const { db } = require('../db')
const { logger } = require('../logger')
const { fetchLiveData, extraerTelemetria, SENSORES } = require('./live')
const { analizarYGenerarGrafica } = require('./historico')
const { formatearSeguimientoProceso } = require('./informe-ca')

const DELTA_DEFAULT = 5

const TIPO_ALERTA = {
  offline: 'Dispositivo OFFLINE — sin conexión',
  wait:    'Dispositivo en WAIT — sin datos recientes',
  fuera_de_rango: 'FUERA DE RANGO — temperatura',
  cambio_setpoint: 'CAMBIO DE SETPOINT detectado'
}

async function dispararAlerta(disp, codigo, { detalle, temperatura, nivel = 'normal', imagenBuffer = null, analisisHistorico = null }) {
  const configs = await db.listarConfigAlertas()
  const cfg = configs.find(c => c.tipo === codigo)
  if (cfg && !cfg.activo) return null

  const nivelFinal = nivel || cfg?.nivel || 'normal'
  const tipoTexto = TIPO_ALERTA[codigo] || codigo
  const nombre = disp.nombre || disp.imei

  await db.registrarAlerta({
    equipo_id: disp.imei,
    tipo_alerta: `${tipoTexto}: ${detalle}`,
    temperatura,
    ubicacion: disp.last_ip,
    nivel: nivelFinal,
    codigo
  })

  const proceso = await db.obtenerProcesoCa(disp.id)
  const seguimientoCa = formatearSeguimientoProceso(proceso)

  const mensajeExtra =
    `\n📦 *${nombre}*\n` +
    `🔢 IMEI: ${disp.imei}\n` +
    (temperatura != null ? `🌡️ ${temperatura}°C\n` : '') +
    (analisisHistorico?.mensajeHoras ? `\n🔴 *${analisisHistorico.mensajeHoras}*\n` : '') +
    seguimientoCa +
    `📋 ${detalle}` +
    (analisisHistorico?.maxHorasContinuas >= 2
      ? `\n📊 Análisis 12h: ${analisisHistorico.horasEnteras}h continuas fuera de rango (${analisisHistorico.totalFuera}/${analisisHistorico.totalRegistros} lecturas)`
      : '')

  const sock = require('../bot').getSock()
  if (!sock) return { enviados: 0 }

  const usuarios = await db.obtenerUsuariosDeEquipo(disp.imei)
  if (!usuarios.length) return { enviados: 0 }

  const emoji = nivelFinal === 'critico' ? '🚨' : '⚠️'
  const titulo = nivelFinal === 'critico' ? 'ALERTA CRÍTICA' : 'ALERTA'
  const mensaje =
    `${emoji} *${titulo} REEFER — ZGroup*\n` +
    mensajeExtra +
    `\n🕐 ${new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' })}\n\n` +
    `Responde *ESTADO* para ver tus equipos.`

  let enviados = 0
  for (const u of usuarios) {
    try {
      const jid = `${u.telefono}@s.whatsapp.net`
      if (imagenBuffer) {
        await sock.sendMessage(jid, { image: imagenBuffer, caption: mensaje })
      } else {
        await sock.sendMessage(jid, { text: mensaje })
      }
      enviados++
    } catch (err) {
      logger.error(`Error alerta ${codigo} a ${u.telefono}:`, err.message)
    }
  }

  logger.info(`⚠️ Alerta [${codigo}] ${disp.imei}: ${detalle} → ${enviados} enviados`)
  return { enviados, codigo }
}

async function evaluarDispositivo(dispositivoId, { notificar = true } = {}) {
  const disp = await db.obtenerDispositivoPorId(dispositivoId)
  if (!disp) throw new Error('Dispositivo no encontrado')
  if (!disp.alarmas_activas) return { skip: true, motivo: 'Monitoreo desactivado' }

  const alertas = []

  // ── 1. Validar conexión PRIMERO ───────────────────────────
  if (disp.estado_conexion !== 'online') {
    const codigo = disp.estado_conexion === 'wait' ? 'wait' : 'offline'
    const pendiente = await db.tieneAlertaPendiente(disp.imei, codigo)

    if (notificar && !pendiente) {
      const config = await db.obtenerConfigApi()
      const flagKey = `alerta_${codigo}`
      if (config?.[flagKey] !== false) {
        const r = await dispararAlerta(disp, codigo, {
          detalle: `Estado: ${disp.estado_conexion.toUpperCase()}. Último dato: ${disp.ultimo_dato || 'N/A'}`,
          nivel: codigo === 'offline' ? 'critico' : 'normal'
        })
        if (r) alertas.push(codigo)
      }
    }

    await db.actualizarMonitoreoEstado(disp.id, { en_rango: false })
    return { online: false, estado: disp.estado_conexion, alertas }
  }

  // ── 2. Online → consultar telemetría live ───────────────
  let live
  try {
    live = await fetchLiveData(disp.imei, disp.link_origen)
  } catch (err) {
    logger.warn(`Live API falló para ${disp.imei}: ${err.message}`)
    return { online: true, error: err.message, alertas }
  }

  const ultimo = live.ultimo
  const telem = extraerTelemetria(ultimo)
  await db.actualizarTelemetria(disp.id, telem)

  const setRef = disp.set_control != null ? parseFloat(disp.set_control) : telem.set_point_live
  const delta = disp.delta != null ? parseFloat(disp.delta) : DELTA_DEFAULT
  const sensorKey = disp.sensor_control || 'return_air'
  const sensorVal = ultimo[sensorKey]
  const sensorNombre = SENSORES[sensorKey] || sensorKey

  // Resolver alertas offline/wait al volver online
  if (notificar) {
    await db.resolverAlertasPorCodigo(disp.imei, ['offline', 'wait'])
  }

  // ── 3. Alerta cambio de SETPOINT (si set_control configurado) ──
  if (disp.set_control != null && disp.alerta_setpoint !== false && telem.set_point_live != null) {
    const setAnterior = disp.ultimo_set_point != null ? parseFloat(disp.ultimo_set_point) : null
    const setActual = parseFloat(telem.set_point_live)

    if (setAnterior != null && Math.abs(setActual - setAnterior) > 0.05) {
      const pendiente = await db.tieneAlertaPendiente(disp.imei, 'cambio_setpoint')
      if (notificar && !pendiente) {
        const r = await dispararAlerta(disp, 'cambio_setpoint', {
          detalle: `Setpoint: ${setAnterior}°C → ${setActual}°C`,
          temperatura: setActual,
          nivel: 'normal'
        })
        if (r) alertas.push('cambio_setpoint')
      }
    }
    await db.actualizarUltimoSetPoint(disp.id, setActual)
  } else if (telem.set_point_live != null) {
    await db.actualizarUltimoSetPoint(disp.id, parseFloat(telem.set_point_live))
  }

  // ── 4. Alerta FUERA DE RANGO ──────────────────────────────
  if (sensorVal != null && setRef != null) {
    const min = setRef - delta
    const max = setRef + delta
    const dentroRango = sensorVal >= min && sensorVal <= max

    if (!dentroRango) {
      const pendiente = await db.tieneAlertaPendiente(disp.imei, 'fuera_de_rango')
      if (notificar && !pendiente) {
        let detalleFinal = `${sensorNombre}: ${sensorVal}°C | Rango: ${min}°C a ${max}°C (Set ${setRef}°C ±${delta})`
        let imagenBuffer = null
        let analisisHistorico = null

        if ((disp.link_origen || 'link1') === 'link1') {
          const { analisis, imagen } = await analizarYGenerarGrafica(disp, { setRef, delta })
          analisisHistorico = analisis
          imagenBuffer = imagen
          if (analisis?.mensajeHoras) {
            detalleFinal = `${analisis.mensajeHoras}\n${detalleFinal}`
          }
        }

        const r = await dispararAlerta(disp, 'fuera_de_rango', {
          detalle: detalleFinal,
          temperatura: sensorVal,
          nivel: 'critico',
          imagenBuffer,
          analisisHistorico
        })
        if (r) alertas.push('fuera_de_rango')
      }
      await db.actualizarMonitoreoEstado(disp.id, { en_rango: false })
    } else {
      if (disp.en_rango === false) {
        await db.resolverAlertasPorCodigo(disp.imei, ['fuera_de_rango'])
      }
      await db.actualizarMonitoreoEstado(disp.id, { en_rango: true })
    }
  }

  return {
    online: true,
    alertas,
    telemetria: telem,
    rango: setRef != null ? { set: setRef, delta, min: setRef - delta, max: setRef + delta, sensor: sensorNombre, valor: sensorVal } : null
  }
}

async function monitorearDispositivosActivos() {
  const dispositivos = await db.listarDispositivosMonitoreo()
  const resultados = []
  for (const d of dispositivos) {
    try {
      const r = await evaluarDispositivo(d.id)
      if (r.alertas?.length) resultados.push({ imei: d.imei, alertas: r.alertas })
    } catch (err) {
      logger.error(`Monitoreo ${d.imei}: ${err.message}`)
    }
  }
  if (resultados.length) {
    logger.info(`🔍 Monitoreo: ${resultados.length} dispositivo(s) con alertas`)
  }
  return resultados
}

async function obtenerLiveDispositivo(dispositivoId) {
  const disp = await db.obtenerDispositivoPorId(dispositivoId)
  if (!disp) throw new Error('Dispositivo no encontrado')

  let live = null
  let sensores = []
  let error = null

  if (disp.estado_conexion === 'online') {
    try {
      live = await fetchLiveData(disp.imei, disp.link_origen)
      sensores = Object.entries(SENSORES).map(([key, label]) => ({
        key,
        label,
        valor: live.ultimo[key === 'set_point' ? 'set_point' : key] ?? null
      }))
      const telem = extraerTelemetria(live.ultimo)
      await db.actualizarTelemetria(disp.id, telem)
      disp = await db.obtenerDispositivoPorId(dispositivoId)
    } catch (err) {
      error = err.message
    }
  }

  const setRef = disp.set_control != null ? parseFloat(disp.set_control) : (disp.set_point_live ?? live?.ultimo?.set_point)
  const delta = disp.delta != null ? parseFloat(disp.delta) : DELTA_DEFAULT

  return {
    dispositivo: disp,
    live: live?.ultimo || null,
    sensores,
    error,
    rango: setRef != null ? {
      set: setRef,
      delta,
      min: setRef - delta,
      max: setRef + delta,
      sensor: SENSORES[disp.sensor_control || 'return_air']
    } : null,
    referencia: live?.referencia_servidor
  }
}

module.exports = { evaluarDispositivo, monitorearDispositivosActivos, obtenerLiveDispositivo, DELTA_DEFAULT }
