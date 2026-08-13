const { db } = require('../db')
const { logger } = require('../logger')
const { sincronizarDispositivos } = require('../services/dispositivos')
const { monitorearDispositivosActivos } = require('../services/monitoreo')
const { encolarConversacion, jidDeTelefono } = require('./outbox')
const {
  mensajeAvisoAlerta,
  setContexto,
  estaMuteado,
  codigoATextoHumano
} = require('./conversacion')
const {
  puedeRecibirAlertas,
  omitirAlertaPorPrueba,
  iniciarPrueba,
  mensajesInicioPrueba
} = require('./prueba-activacion')

const TIPO_ALERTA = {
  online:  'Dispositivo en línea',
  wait:    'Dispositivo en espera (sin datos recientes)',
  offline: 'Dispositivo sin conexión'
}

async function enviarAlertaWhatsApp({ equipo_id, tipo_alerta, ubicacion, nivel, codigo }) {
  const usuarios = await db.obtenerUsuariosDeEquipo(equipo_id)
  if (!usuarios.length) return { enviados: 0, encolados: 0, advertencia: 'Sin usuarios asignados' }

  const disp = await db.obtenerDispositivoPorImei(equipo_id)
  const nombre = disp?.nombre || equipo_id
  const cod = codigo || 'alerta'

  let encolados = 0
  let bloqueados = 0
  for (const u of usuarios) {
    const jid = jidDeTelefono(u.telefono)
    if (estaMuteado(jid)) continue
    if (!puedeRecibirAlertas(u)) {
      await omitirAlertaPorPrueba(u, { imei: equipo_id, codigo: cod })
      bloqueados++
      continue
    }

    const texto = mensajeAvisoAlerta(u, {
      nombreEquipo: nombre,
      imei: equipo_id,
      quePaso: tipo_alerta || `El reefer ${codigoATextoHumano(cod)}.`,
      datoClave: ubicacion ? `Última IP/ubicación: ${ubicacion}` : null
    })
    encolarConversacion(jid, [texto], { prioridad: nivel === 'critico' ? 1 : 3 })
    setContexto(jid, {
      ultimo_usuario_id: u.id,
      ultimo_imei: equipo_id,
      ultimo_nombre_equipo: nombre,
      ultima_alerta_codigo: cod,
      esperando: 'seguimiento'
    })
    await db.registrarEventoConversacion(u.id, 'alerta_encolada', {
      detalle: `Alerta encolada: ${cod || tipo_alerta} · ${nombre}`,
      meta: { imei: equipo_id, codigo: cod, nivel }
    })
    encolados++
  }

  return { enviados: 0, encolados, bloqueados, total_usuarios: usuarios.length }
}

async function enviarTestAlarma(dispositivoId) {
  const disp = await db.obtenerDispositivoPorId(dispositivoId)
  if (!disp) throw new Error('Dispositivo no encontrado')

  await db.asegurarEquipoDesdeDispositivo(disp)
  const usuarios = await db.obtenerUsuariosDeEquipo(disp.imei)
  if (!usuarios.length) {
    return {
      enviados: 0,
      encolados: 0,
      total_usuarios: 0,
      advertencia: 'No hay usuarios asignados a este reefer. Asígnalos en Usuarios → Editar → Equipos.'
    }
  }

  const nombre = disp.nombre || disp.imei
  let encolados = 0
  for (const u of usuarios) {
    const { ya_activado } = await iniciarPrueba(u.id, {
      origen: 'test-alarma',
      meta: { imei: disp.imei, dispositivo_id: disp.id }
    })
    const jid = jidDeTelefono(u.telefono)
    const lineas = mensajesInicioPrueba(u, {
      totalDisp: 1,
      criticos: [{ nombre, imei: disp.imei }],
      yaActivado: ya_activado
    })
    if (!ya_activado) {
      lineas[1] =
        `Esto es la *activación* con el reefer *${nombre}* (IMEI ${disp.imei}).\n` +
        `No es una alarma real: debes responderme *3 veces* para poder recibir alertas después.`
    }
    encolarConversacion(jid, lineas, { prioridad: 4 })
    setContexto(jid, {
      ultimo_usuario_id: u.id,
      ultimo_imei: disp.imei,
      ultimo_nombre_equipo: nombre,
      esperando: ya_activado ? 'seguimiento' : 'prueba_paso_1',
      prueba_activa: !ya_activado
    })
    encolados++
    logger.info(`🧪 Test/activación encolado → ${u.nombre} (${u.telefono}) — ${disp.imei}`)
  }

  return {
    enviados: 0,
    encolados,
    total_usuarios: usuarios.length,
    usuarios: usuarios.map(u => ({ id: u.id, nombre: u.nombre, telefono: u.telefono })),
    modo: 'activacion_conversacional',
    nota: 'Cada usuario debe responder 3 veces; el evento queda en conversacion_eventos. Sin eso no hay alertas push.'
  }
}

async function procesarCambiosEstado(cambios) {
  const config = await db.obtenerConfigApi()
  const configsAlerta = await db.listarConfigAlertas()
  const mapConfig = Object.fromEntries(configsAlerta.map(c => [c.tipo, c]))
  const alertasEnviadas = []

  for (const c of cambios) {
    const nuevoEstado = c.a
    // online: no push por defecto (anti-spam)
    if (nuevoEstado === 'online') continue

    // wait/offline: lo evalúa monitorearDispositivosActivos
    // (interno ≥2 h, usuario WA ≥4 h). Evita avisar al cambio inmediato (~1–2 h).
    if (nuevoEstado === 'wait' || nuevoEstado === 'offline') {
      continue
    }

    const flagConfig = config[`alerta_${nuevoEstado}`]
    const cfgTipo = mapConfig[nuevoEstado]
    if (!flagConfig || !cfgTipo?.activo) continue

    // Prioridad ztrack: no alertas locales por cambio de estado
    if (c.dispositivo?.prioridad_monitor) continue

    const alerta = await db.registrarAlerta({
      equipo_id: c.imei,
      tipo_alerta: TIPO_ALERTA[nuevoEstado] || `Cambio a ${nuevoEstado}`,
      ubicacion: c.dispositivo?.last_ip,
      nivel: cfgTipo.nivel,
      codigo: nuevoEstado
    })

    const resultado = await enviarAlertaWhatsApp({
      equipo_id: c.imei,
      tipo_alerta: alerta.tipo,
      ubicacion: c.dispositivo?.last_ip,
      nivel: cfgTipo.nivel,
      codigo: nuevoEstado
    })
    alertasEnviadas.push({ imei: c.imei, estado: nuevoEstado, ...resultado })
  }
  return alertasEnviadas
}

async function syncYAlertar() {
  const result = await sincronizarDispositivos()
  const alertas = await procesarCambiosEstado(result.cambios || [])
  return { ...result, alertas_enviadas: alertas }
}

let monitorTimer = null

async function ejecutarMonitor() {
  try {
    await syncYAlertar()
    await monitorearDispositivosActivos()
  } catch (err) {
    logger.error('Error en monitor de dispositivos:', err.message)
  }
}

async function iniciarMonitor() {
  if (monitorTimer) return
  await ejecutarMonitor()
  const config = await db.obtenerConfigApi()
  const mins = config?.intervalo_minutos || 15
  monitorTimer = setInterval(ejecutarMonitor, mins * 60 * 1000)
  logger.info(`🔄 Monitor de dispositivos iniciado (cada ${mins} min)`)
}

module.exports = { enviarAlertaWhatsApp, enviarTestAlarma, syncYAlertar, procesarCambiosEstado, iniciarMonitor }
