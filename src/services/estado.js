const { db } = require('../db')
const { logger } = require('../logger')
const { fetchLiveData, extraerTelemetria, SENSORES } = require('./live')
const { analizarYGenerarGrafica } = require('./historico')
const { formatearSeguimientoProceso } = require('./informe-ca')
const { encolarConversacion, jidDeTelefono } = require('./outbox')
const { setContexto, listarDispositivosPlanos } = require('./conversacion')
const { iniciarPrueba, mensajesInicioPrueba } = require('./prueba-activacion')

const DELTA_DEFAULT = 5

function fmtFecha(f) {
  if (!f) return 'N/A'
  return new Date(f).toLocaleString('es-PE', { timeZone: 'America/Lima' })
}

function fmtTemp(v) {
  return v != null ? `${v}°C` : 'N/A'
}

async function enriquecerDispositivo(disp) {
  let d = { ...disp }
  if (d.estado_conexion === 'online') {
    try {
      const live = await fetchLiveData(d.imei, d.link_origen)
      const telem = extraerTelemetria(live.ultimo)
      d = { ...d, ...telem, telemetria_actualizada: new Date() }
      await db.actualizarTelemetria(d.id, telem)
    } catch {
      /* usar datos en caché */
    }
  }
  d.alertas_pendientes = await db.obtenerAlertasPendientesPorImei(d.imei)
  d.tiene_alerta = d.alertas_pendientes.length > 0 || d.en_rango === false
  d.rango = calcularRango(d)
  d.proceso_ca = await db.obtenerProcesoCa(d.id)
  return d
}

function calcularRango(d) {
  const delta = d.delta != null ? parseFloat(d.delta) : DELTA_DEFAULT
  const setRef = d.set_control != null ? parseFloat(d.set_control) : d.set_point_live
  const sensorKey = d.sensor_control || 'return_air'
  const sensorVal = d[sensorKey] ?? d.return_air
  const sensorNombre = SENSORES[sensorKey] || sensorKey
  if (setRef == null || sensorVal == null) {
    return { fueraDeRango: d.en_rango === false, setRef, delta, sensorVal, sensorNombre }
  }

  const min = setRef - delta
  const max = setRef + delta
  const fueraLive = sensorVal < min || sensorVal > max
  const alertaFuera = d.alertas_pendientes?.some(a => a.codigo === 'fuera_de_rango')
  return {
    fueraDeRango: d.en_rango === false || alertaFuera || fueraLive,
    setRef, delta, min, max, sensorVal, sensorNombre, alertaFuera
  }
}

function filtrarPorIds(dispositivos, ids) {
  if (!ids?.length) return dispositivos
  const set = new Set(ids.map(Number))
  return dispositivos.filter(d => set.has(d.id))
}

/**
 * Prueba conversacional (2–3 mensajes): presentación + panorama + CTA.
 * No envía plantillas largas ni gráficas; el usuario las pide con GRAFICA.
 */
async function enviarTestEstadoUsuario(usuarioId, dispositivoIds = null, { incluirAnalisis12h = false } = {}) {
  const usuario = await db.obtenerUsuarioPorId(usuarioId)
  if (!usuario) throw new Error('Usuario no encontrado')
  if (!usuario.activo) throw new Error(`Usuario ${usuario.nombre} está inactivo`)

  let { grupos, individuales } = await db.obtenerDispositivosOrganizadosUsuario(usuarioId)

  if (dispositivoIds?.length) {
    grupos = grupos.map(g => ({
      ...g,
      dispositivos: filtrarPorIds(g.dispositivos, dispositivoIds)
    })).filter(g => g.dispositivos.length)
    individuales = filtrarPorIds(individuales, dispositivoIds)
  }

  const planos = listarDispositivosPlanos(grupos, individuales)
  if (!planos.length) {
    return { enviados: 0, advertencia: 'No hay dispositivos seleccionados para este usuario', encolados: 0 }
  }

  const criticos = []
  for (const d of planos.slice(0, 15)) {
    const e = await enriquecerDispositivo(d)
    if (e.tiene_alerta || e.rango?.fueraDeRango || e.estado_conexion === 'offline') {
      criticos.push({ nombre: e.nombre || e.imei, imei: e.imei })
    }
  }

  const { ya_activado } = await iniciarPrueba(usuario.id, {
    origen: 'test-estado',
    meta: { dispositivos: planos.length, incluirAnalisis12h }
  })

  const lineas = mensajesInicioPrueba(usuario, {
    totalDisp: planos.length,
    criticos,
    yaActivado: ya_activado
  })

  if (incluirAnalisis12h && criticos[0] && ya_activado) {
    lineas[lineas.length - 1] +=
      `\n(Si quieres la curva de 12 h de *${criticos[0].nombre}*, responde *GRAFICA*.)`
  }

  const jid = jidDeTelefono(usuario.telefono)
  const { jobIds } = encolarConversacion(jid, lineas, { prioridad: 4 })

  setContexto(jid, {
    ultimo_usuario_id: usuario.id,
    ultimo_imei: criticos[0]?.imei || planos[0]?.imei,
    ultimo_nombre_equipo: criticos[0]?.nombre || planos[0]?.nombre || planos[0]?.imei,
    esperando: ya_activado ? 'seguimiento' : 'prueba_paso_1',
    prueba_activa: !ya_activado,
    canal: 'privado'
  })

  logger.info(`🧪 Prueba conversacional encolada → ${usuario.nombre} (${usuario.telefono}) · ${jobIds.length} msgs`)

  return {
    enviados: 0,
    encolados: jobIds.length,
    usuario: usuario.nombre,
    telefono: usuario.telefono,
    dispositivos: planos.length,
    incluir_analisis_12h: incluirAnalisis12h,
    modo: 'activacion_conversacional',
    ya_activado,
    nota: ya_activado
      ? 'Usuario ya activado; conversación de verificación en cola.'
      : 'Activación iniciada: el usuario debe responder 3 veces antes de recibir alertas. Evento registrado en BD.'
  }
}

async function enviarTestEstadoMultiples(usuarioIds, dispositivoIds = null, { incluirAnalisis12h = false } = {}) {
  const resultados = []
  for (const id of usuarioIds) {
    try {
      const r = await enviarTestEstadoUsuario(id, dispositivoIds, { incluirAnalisis12h })
      resultados.push({ usuario_id: id, ...r })
    } catch (err) {
      resultados.push({ usuario_id: id, error: err.message, enviados: 0, encolados: 0 })
    }
  }
  return resultados
}

// Reexport helpers legacy por si admin u otros módulos los usan
function formatearBloqueAnalisis12h(d, analisis) {
  if (!analisis) return ''
  const r = d.rango || {}
  let bloque = ''
  if (analisis.mensajeHoras) bloque += `\n🔴 *${analisis.mensajeHoras}*\n`
  if (r.sensorNombre && r.sensorVal != null && r.setRef != null) {
    bloque += `📋 ${r.sensorNombre}: ${r.sensorVal}°C | Rango: ${r.min}°C a ${r.max}°C (Set ${r.setRef}°C ±${r.delta})\n`
  }
  return bloque
}

module.exports = {
  enviarTestEstadoUsuario,
  enviarTestEstadoMultiples,
  enriquecerDispositivo,
  calcularRango,
  formatearBloqueAnalisis12h,
  fmtFecha,
  fmtTemp,
  SENSORES,
  analizarYGenerarGrafica,
  formatearSeguimientoProceso,
  DELTA_DEFAULT
}
