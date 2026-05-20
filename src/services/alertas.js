const { getSock } = require('../bot')
const { db } = require('../db')
const { logger } = require('../logger')
const { sincronizarDispositivos } = require('../services/dispositivos')
const { monitorearDispositivosActivos } = require('../services/monitoreo')

const TIPO_ALERTA = {
  online:  'Dispositivo en línea',
  wait:    'Dispositivo en espera (sin datos recientes)',
  offline: 'Dispositivo sin conexión'
}

async function enviarAlertaWhatsApp({ equipo_id, tipo_alerta, ubicacion, nivel }) {
  const sock = getSock()
  if (!sock) return { enviados: 0, error: 'Bot no conectado' }

  const usuarios = await db.obtenerUsuariosDeEquipo(equipo_id)
  if (!usuarios.length) return { enviados: 0, advertencia: 'Sin usuarios asignados' }

  const emoji = nivel === 'critico' ? '🚨' : '⚠️'
  const titulo = nivel === 'critico' ? 'ALERTA CRÍTICA' : 'ALERTA'
  const mensaje =
    `${emoji} *${titulo} REEFER — ZGroup*\n\n` +
    `📦 Equipo: *${equipo_id}*\n` +
    `⚠️ Tipo: ${tipo_alerta}\n` +
    `📍 ${ubicacion || 'Sin ubicación'}\n` +
    `🕐 ${new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' })}\n\n` +
    `Responde *ESTADO* para ver tus equipos.`

  let enviados = 0
  for (const u of usuarios) {
    try {
      await sock.sendMessage(`${u.telefono}@s.whatsapp.net`, { text: mensaje })
      enviados++
    } catch (err) {
      logger.error(`Error enviando a ${u.telefono}:`, err.message)
    }
  }
  return { enviados, total_usuarios: usuarios.length }
}

async function enviarTestAlarma(dispositivoId) {
  const disp = await db.obtenerDispositivoPorId(dispositivoId)
  if (!disp) throw new Error('Dispositivo no encontrado')

  await db.asegurarEquipoDesdeDispositivo(disp)
  const usuarios = await db.obtenerUsuariosDeEquipo(disp.imei)
  if (!usuarios.length) {
    return {
      enviados: 0,
      total_usuarios: 0,
      advertencia: 'No hay usuarios asignados a este reefer. Asígnalos en Usuarios → Editar → Equipos.'
    }
  }

  const sock = getSock()
  if (!sock) return { enviados: 0, error: 'Bot de WhatsApp no conectado' }

  const nombre = disp.nombre || disp.imei
  const mensaje =
    `🧪 *PRUEBA DE ALARMA — ZGroup*\n\n` +
    `📦 Reefer: *${nombre}*\n` +
    `🔢 IMEI: ${disp.imei}\n` +
    `📡 Estado: ${disp.estado_conexion}\n` +
    `⚠️ Mensaje de *prueba* — no es una alerta real.\n` +
    `🕐 ${new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' })}\n\n` +
    `Responde *ESTADO* para ver tus equipos.`

  let enviados = 0
  const errores = []
  for (const u of usuarios) {
    try {
      await sock.sendMessage(`${u.telefono}@s.whatsapp.net`, { text: mensaje })
      enviados++
      logger.info(`🧪 Test alarma enviada a ${u.nombre} (${u.telefono}) — ${disp.imei}`)
    } catch (err) {
      errores.push({ telefono: u.telefono, error: err.message })
      logger.error(`Error test alarma a ${u.telefono}:`, err.message)
    }
  }

  return {
    enviados,
    total_usuarios: usuarios.length,
    usuarios: usuarios.map(u => ({ id: u.id, nombre: u.nombre, telefono: u.telefono })),
    errores: errores.length ? errores : undefined
  }
}

async function procesarCambiosEstado(cambios) {
  const config = await db.obtenerConfigApi()
  const configsAlerta = await db.listarConfigAlertas()
  const mapConfig = Object.fromEntries(configsAlerta.map(c => [c.tipo, c]))
  const alertasEnviadas = []

  for (const c of cambios) {
    const nuevoEstado = c.a
    const flagConfig = config[`alerta_${nuevoEstado}`]
    const cfgTipo = mapConfig[nuevoEstado]
    if (!flagConfig || !cfgTipo?.activo) continue

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
      nivel: cfgTipo.nivel
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
