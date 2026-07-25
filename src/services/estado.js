const { getSock } = require('../bot')
const { db } = require('../db')
const { logger } = require('../logger')
const { fetchLiveData, extraerTelemetria, SENSORES } = require('./live')
const { analizarYGenerarGrafica } = require('./historico')
const { formatearSeguimientoProceso } = require('./informe-ca')

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
  if (setRef == null || sensorVal == null) return { fueraDeRango: d.en_rango === false, setRef, delta, sensorVal, sensorNombre }

  const min = setRef - delta
  const max = setRef + delta
  const fueraLive = sensorVal < min || sensorVal > max
  const alertaFuera = d.alertas_pendientes?.some(a => a.codigo === 'fuera_de_rango')
  return {
    fueraDeRango: d.en_rango === false || alertaFuera || fueraLive,
    setRef, delta, min, max, sensorVal, sensorNombre, alertaFuera
  }
}

function formatearBloqueAnalisis12h(d, analisis) {
  if (!analisis) return ''
  const r = d.rango || {}
  let bloque = ''
  if (analisis.mensajeHoras) bloque += `\n🔴 *${analisis.mensajeHoras}*\n`
  if (r.sensorNombre && r.sensorVal != null && r.setRef != null) {
    bloque += `📋 ${r.sensorNombre}: ${r.sensorVal}°C | Rango: ${r.min}°C a ${r.max}°C (Set ${r.setRef}°C ±${r.delta})\n`
  }
  if (analisis.horasEnteras >= 2) {
    bloque += `📊 Análisis 12h: ${analisis.horasEnteras}h continuas fuera de rango (${analisis.totalFuera}/${analisis.totalRegistros} lecturas)\n`
  } else if (analisis.totalRegistros) {
    bloque += `📊 Análisis 12h: ${analisis.totalRegistros} lecturas revisadas\n`
  }
  return bloque
}

function formatearCaptionAnalisis12h(d, grupoNombre, analisis) {
  const nombre = d.nombre || d.imei
  const bloque = formatearBloqueAnalisis12h(d, analisis)
  return (
    `🚨 *ANÁLISIS FUERA DE RANGO — 12h*\n\n` +
    `📁 Grupo: *${grupoNombre}*\n` +
    `📦 ${nombre}\n` +
    `🔢 IMEI: ${d.imei}\n` +
    bloque +
    `\n📈 Trazabilidad últimas 12 horas\n` +
    `🕐 ${fmtFecha(new Date())}`
  )
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
  const analisisTxt = d.analisis_12h ? formatearBloqueAnalisis12h(d, d.analisis_12h) : ''
  const fueraTxt = d.rango?.fueraDeRango ? `\n⚠️ *Estado: FUERA DE RANGO*\n` : ''
  return (
    `📊 *ESTADO DISPOSITIVO — ZGroup*\n\n` +
    `📁 Grupo: *${grupoNombre}*\n` +
    `🔗 Origen: *${link}*\n` +
    `📦 ${d.nombre || d.imei}\n` +
    `🔢 IMEI: ${d.imei}\n` +
    `${emoji} Conexión: *${(d.estado_conexion || 'unknown').toUpperCase()}*\n` +
    `📍 IP: ${d.last_ip || 'N/A'}\n` +
    fueraTxt +
    analisisTxt +
    `\n` +
    `${formatearControl(d)}\n\n` +
    `${formatearSeguimientoProceso(d.proceso_ca)}` +
    `${formatearTelemetria(d)}\n\n` +
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

async function enviarAnalisis12h(sock, telefono, d, grupoNombre, imagen) {
  if (!imagen) return 0
  await sleep(DELAY_MS)
  const caption = formatearCaptionAnalisis12h(d, grupoNombre, d.analisis_12h)
  await sock.sendMessage(`${telefono}@s.whatsapp.net`, { image: imagen, caption })
  logger.info(`📈 Gráfica 12h enviada → ${telefono} | ${d.imei}`)
  return 1
}

async function procesarGrupo(sock, telefono, grupoNombre, dispositivos, { incluirAnalisis12h = false } = {}) {
  let enviados = 0
  const enriquecidos = []
  for (const d of dispositivos) {
    enriquecidos.push(await enriquecerDispositivo(d))
  }

  for (let i = 0; i < enriquecidos.length; i++) {
    const d = enriquecidos[i]
    let imagen12h = null

    if (incluirAnalisis12h && d.rango?.fueraDeRango && (d.link_origen || 'link1') === 'link1') {
      const { analisis, imagen } = await analizarYGenerarGrafica(d, {
        setRef: d.rango.setRef,
        delta: d.rango.delta
      })
      d.analisis_12h = analisis
      imagen12h = imagen
    }

    if (i > 0) await sleep(DELAY_MS)
    const msg = formatearMensajeDispositivo(d, grupoNombre)
    await sock.sendMessage(`${telefono}@s.whatsapp.net`, { text: msg })
    enviados++
    logger.info(`📊 Estado enviado → ${telefono} | ${grupoNombre} | ${d.imei}`)

    if (imagen12h) {
      enviados += await enviarAnalisis12h(sock, telefono, d, grupoNombre, imagen12h)
    }
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

async function enviarTestEstadoUsuario(usuarioId, dispositivoIds = null, { incluirAnalisis12h = false } = {}) {
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
      enviados += await procesarGrupo(sock, usuario.telefono, g.nombre, g.dispositivos, { incluirAnalisis12h })
    }
  }
  if (individuales.length) {
    enviados += await procesarGrupo(sock, usuario.telefono, 'Asignación individual', individuales, { incluirAnalisis12h })
  }

  return { enviados, usuario: usuario.nombre, telefono: usuario.telefono, dispositivos: totalDisp, incluir_analisis_12h: incluirAnalisis12h }
}

async function enviarTestEstadoMultiples(usuarioIds, dispositivoIds = null, { incluirAnalisis12h = false } = {}) {
  const resultados = []
  for (const id of usuarioIds) {
    try {
      const r = await enviarTestEstadoUsuario(id, dispositivoIds, { incluirAnalisis12h })
      resultados.push({ usuario_id: id, ...r })
      if (usuarioIds.indexOf(id) < usuarioIds.length - 1) await sleep(DELAY_MS)
    } catch (err) {
      resultados.push({ usuario_id: id, error: err.message, enviados: 0 })
    }
  }
  return resultados
}

module.exports = { enviarTestEstadoUsuario, enviarTestEstadoMultiples }
