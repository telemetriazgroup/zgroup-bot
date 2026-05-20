const { getSock } = require('../bot')
const { db } = require('../db')
const { logger } = require('../logger')
const { fetchLiveData, extraerTelemetria, SENSORES } = require('./live')

const DELTA_DEFAULT = 5
const DELAY_MS = 2000

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

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
      const live = await fetchLiveData(d.imei)
      const telem = extraerTelemetria(live.ultimo)
      d = { ...d, ...telem, telemetria_actualizada: new Date() }
      await db.actualizarTelemetria(d.id, telem)
    } catch {
      /* usar datos en caché */
    }
  }
  d.alertas_pendientes = await db.obtenerAlertasPendientesPorImei(d.imei)
  d.tiene_alerta = d.alertas_pendientes.length > 0
  return d
}

function formatearControl(d) {
  const set = d.set_control != null ? d.set_control : (d.set_point_live ?? 'Auto (API)')
  const delta = d.delta != null ? d.delta : DELTA_DEFAULT
  const sensor = SENSORES[d.sensor_control || 'return_air'] || d.sensor_control
  return (
    `⚙️ *Control:*\n` +
    `• Set: ${set}°C | Delta: ±${delta}°C\n` +
    `• Sensor: ${sensor}\n` +
    `• Monitoreo: ${d.alarmas_activas ? '✅ Activo' : '❌ Inactivo'}\n` +
    `• Alerta setpoint: ${d.alerta_setpoint !== false ? 'Sí' : 'No'}`
  )
}

function formatearTelemetria(d) {
  return (
    `🌡️ *Telemetría:*\n` +
    `• Suministro: ${fmtTemp(d.temp_supply_1)}\n` +
    `• Retorno: ${fmtTemp(d.return_air)}\n` +
    `• Evaporador: ${fmtTemp(d.evaporation_coil)}\n` +
    `• Set point: ${fmtTemp(d.set_point_live)}\n` +
    `• Compresor: ${fmtTemp(d.compress_coil_1)}\n` +
    `• Actualizado: ${fmtFecha(d.telemetria_actualizada || d.ultimo_dato)}`
  )
}

function formatearAlertas(d) {
  if (!d.alertas_pendientes?.length) return '✅ *Alertas:* Sin alertas pendientes'
  const lista = d.alertas_pendientes.slice(0, 5).map(a =>
    `• [${a.nivel}] ${a.tipo?.slice(0, 80)}`
  ).join('\n')
  return `🚨 *Alertas pendientes (${d.alertas_pendientes.length}):*\n${lista}`
}

function formatearMensajeDispositivo(d, grupoNombre) {
  const estadoEmoji = { online: '🟢', wait: '🟡', offline: '🔴' }
  const emoji = estadoEmoji[d.estado_conexion] || '⚪'
  const link = d.link_origen || 'link1'
  return (
    `📊 *ESTADO DISPOSITIVO — ZGroup*\n\n` +
    `📁 Grupo: *${grupoNombre}*\n` +
    `🔗 Origen: *${link}*\n` +
    `📦 ${d.nombre || d.imei}\n` +
    `🔢 IMEI: ${d.imei}\n` +
    `${emoji} Conexión: *${(d.estado_conexion || 'unknown').toUpperCase()}*\n` +
    `📍 IP: ${d.last_ip || 'N/A'}\n\n` +
    `${formatearTelemetria(d)}\n\n` +
    `${formatearControl(d)}\n\n` +
    `${formatearAlertas(d)}\n\n` +
    `🕐 ${fmtFecha(new Date())}`
  )
}

function filtrarPorIds(dispositivos, ids) {
  if (!ids?.length) return dispositivos
  const set = new Set(ids.map(Number))
  return dispositivos.filter(d => set.has(d.id))
}

function formatearResumenGrupo(grupoNombre, dispositivos) {
  const online = dispositivos.filter(d => d.estado_conexion === 'online').length
  const wait = dispositivos.filter(d => d.estado_conexion === 'wait').length
  const offline = dispositivos.filter(d => d.estado_conexion === 'offline').length
  const conAlarma = dispositivos.filter(d => d.tiene_alerta).length
  const monitoreo = dispositivos.filter(d => d.alarmas_activas).length

  const lista = dispositivos.map(d => {
    const e = { online: '🟢', wait: '🟡', offline: '🔴' }[d.estado_conexion] || '⚪'
    const al = d.tiene_alerta ? ' 🚨' : ''
    return `${e} ${d.nombre || d.imei}${al}`
  }).join('\n')

  return (
    `📋 *RESUMEN GRUPO — ${grupoNombre}*\n\n` +
    `📊 Total: ${dispositivos.length} dispositivo(s)\n` +
    `🟢 Online: ${online} | 🟡 Wait: ${wait} | 🔴 Offline: ${offline}\n` +
    `🔔 Con alertas: ${conAlarma} | ⚙️ Monitoreo activo: ${monitoreo}\n\n` +
    `*Dispositivos:*\n${lista}\n\n` +
    `🕐 ${fmtFecha(new Date())}`
  )
}

async function procesarGrupo(sock, telefono, grupoNombre, dispositivos) {
  let enviados = 0
  const enriquecidos = []
  for (const d of dispositivos) {
    enriquecidos.push(await enriquecerDispositivo(d))
  }

  for (let i = 0; i < enriquecidos.length; i++) {
    if (i > 0) await sleep(DELAY_MS)
    const msg = formatearMensajeDispositivo(enriquecidos[i], grupoNombre)
    await sock.sendMessage(`${telefono}@s.whatsapp.net`, { text: msg })
    enviados++
    logger.info(`📊 Estado enviado → ${telefono} | ${grupoNombre} | ${enriquecidos[i].imei}`)
  }

  if (enriquecidos.length > 1) {
    await sleep(DELAY_MS)
    await sock.sendMessage(`${telefono}@s.whatsapp.net`, {
      text: formatearResumenGrupo(grupoNombre, enriquecidos)
    })
    enviados++
  }

  return enviados
}

async function enviarTestEstadoUsuario(usuarioId, dispositivoIds = null) {
  const usuario = await db.obtenerUsuarioPorId(usuarioId)
  if (!usuario) throw new Error('Usuario no encontrado')
  if (!usuario.activo) throw new Error(`Usuario ${usuario.nombre} está inactivo`)

  const sock = getSock()
  if (!sock) return { enviados: 0, error: 'Bot de WhatsApp no conectado' }

  let { grupos, individuales } = await db.obtenerDispositivosOrganizadosUsuario(usuarioId)

  if (dispositivoIds?.length) {
    grupos = grupos.map(g => ({
      ...g,
      dispositivos: filtrarPorIds(g.dispositivos, dispositivoIds)
    })).filter(g => g.dispositivos.length)
    individuales = filtrarPorIds(individuales, dispositivoIds)
  }

  const totalDisp = grupos.reduce((a, g) => a + g.dispositivos.length, 0) + individuales.length

  if (!totalDisp) {
    return { enviados: 0, advertencia: 'No hay dispositivos seleccionados para este usuario' }
  }

  let enviados = 0
  for (const g of grupos) {
    if (g.dispositivos.length) {
      enviados += await procesarGrupo(sock, usuario.telefono, g.nombre, g.dispositivos)
    }
  }
  if (individuales.length) {
    enviados += await procesarGrupo(sock, usuario.telefono, 'Asignación individual', individuales)
  }

  return { enviados, usuario: usuario.nombre, telefono: usuario.telefono, dispositivos: totalDisp }
}

async function enviarTestEstadoMultiples(usuarioIds, dispositivoIds = null) {
  const resultados = []
  for (const id of usuarioIds) {
    try {
      const r = await enviarTestEstadoUsuario(id, dispositivoIds)
      resultados.push({ usuario_id: id, ...r })
      if (usuarioIds.indexOf(id) < usuarioIds.length - 1) await sleep(DELAY_MS)
    } catch (err) {
      resultados.push({ usuario_id: id, error: err.message, enviados: 0 })
    }
  }
  return resultados
}

module.exports = { enviarTestEstadoUsuario, enviarTestEstadoMultiples }
