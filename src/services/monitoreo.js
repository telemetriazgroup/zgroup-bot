const { db } = require('../db')
const { logger } = require('../logger')
const { fetchLiveData, extraerTelemetria, SENSORES } = require('./live')
const { analizarYGenerarGrafica } = require('./historico')
const { encolarConversacion, jidDeTelefono } = require('./outbox')
const {
  setContexto,
  estaMuteado
} = require('./conversacion')
const { puedeRecibirAlertas, omitirAlertaPorPrueba } = require('./prueba-activacion')
const {
  leerUmbrales,
  decidirNotificacionFuera,
  obtenerSeguimientoActivo,
  upsertSeguimientoNotificado,
  resolverSeguimiento,
  redactarAvisoFuera,
  redactarRecuperacionRango,
  redactarOnline
} = require('./alerta-seguimiento')

const DELTA_DEFAULT = 5

const TIPO_ALERTA = {
  offline: 'Dispositivo OFFLINE — sin conexión',
  wait:    'Dispositivo en WAIT — sin datos recientes',
  fuera_de_rango: 'FUERA DE RANGO — temperatura',
  cambio_setpoint: 'CAMBIO DE SETPOINT detectado',
  en_rango: 'Temperatura de vuelta al rango',
  online: 'Dispositivo en línea'
}

async function notificarUsuarios(disp, codigo, redactarFn, { nivel = 'normal', meta = {} } = {}) {
  const configs = await db.listarConfigAlertas()
  const cfg = configs.find(c => c.tipo === codigo)
  if (cfg && cfg.activo === false && codigo !== 'en_rango' && codigo !== 'online') return { encolados: 0 }

  const usuarios = await db.obtenerUsuariosDeEquipo(disp.imei)
  if (!usuarios.length) return { encolados: 0 }

  let encolados = 0
  let bloqueados = 0
  for (const u of usuarios) {
    const jid = jidDeTelefono(u.telefono)
    if (estaMuteado(jid)) continue
    if (!puedeRecibirAlertas(u)) {
      await omitirAlertaPorPrueba(u, { imei: disp.imei, codigo })
      bloqueados++
      continue
    }
    const texto = await redactarFn(u)
    encolarConversacion(jid, [texto], {
      prioridad: nivel === 'critico' ? 1 : 3,
      usuarioId: u.id,
      imeiContexto: disp.imei,
      meta: { codigo, ...meta }
    })
    setContexto(jid, {
      ultimo_usuario_id: u.id,
      ultimo_imei: disp.imei,
      ultimo_nombre_equipo: disp.nombre || disp.imei,
      ultima_alerta_codigo: codigo,
      esperando: 'seguimiento',
      canal: 'privado'
    })
    await db.registrarEventoConversacion(u.id, 'alerta_encolada', {
      detalle: `Alerta encolada: ${codigo} · ${disp.nombre || disp.imei}`,
      meta: { imei: disp.imei, codigo, nivel, ...meta }
    })
    encolados++
  }
  return { encolados, bloqueados }
}

async function dispararAlerta(disp, codigo, { detalle, temperatura, nivel = 'normal', analisisHistorico = null }) {
  const tipoTexto = TIPO_ALERTA[codigo] || codigo
  const nombre = disp.nombre || disp.imei

  await db.registrarAlerta({
    equipo_id: disp.imei,
    tipo_alerta: `${tipoTexto}: ${detalle}`,
    temperatura,
    ubicacion: disp.last_ip,
    nivel,
    codigo
  })

  let datoClave = detalle
  if (analisisHistorico?.mensajeHoras) {
    datoClave = `${analisisHistorico.mensajeHoras}\n${detalle}`
  }

  const r = await notificarUsuarios(
    disp,
    codigo,
    async (u) => {
      const { mensajeAvisoAlerta, codigoATextoHumano } = require('./conversacion')
      return mensajeAvisoAlerta(u, {
        nombreEquipo: nombre,
        imei: disp.imei,
        quePaso: `El reefer ${codigoATextoHumano(codigo)}.`,
        datoClave
      })
    },
    { nivel, meta: { detalle } }
  )

  logger.info(
    `⚠️ Alerta [${codigo}] ${disp.imei}: ${detalle} → ${r.encolados} en cola` +
      (r.bloqueados ? `, ${r.bloqueados} bloqueada(s)` : '')
  )
  return { enviados: 0, ...r, codigo }
}

async function procesarFueraDeRango(disp, {
  sensorVal, setRef, delta, sensorNombre, notificar, config
}) {
  const umbrales = leerUmbrales(config)
  const min = setRef - delta
  const max = setRef + delta
  const alertas = []

  // Marcar inicio del periodo fuera de rango
  let fueraDesde = disp.fuera_desde ? new Date(disp.fuera_desde) : null
  if (!fueraDesde) {
    fueraDesde = new Date()
    await db.setFueraDesde(disp.id, fueraDesde)
    disp.fuera_desde = fueraDesde
  }

  const horasContinuas = Math.max(0, (Date.now() - fueraDesde.getTime()) / 3600000)
  await db.actualizarMonitoreoEstado(disp.id, { en_rango: false })

  if (!notificar) return { alertas, horasContinuas }

  const detalleBase =
    `${sensorNombre}: ${sensorVal}°C | Rango: ${min}°C a ${max}°C (Set ${setRef}°C ±${delta})`

  let analisisHistorico = null
  if ((disp.link_origen || 'link1') === 'link1' && horasContinuas >= umbrales.minHoras) {
    try {
      const { analisis } = await analizarYGenerarGrafica(disp, { setRef, delta, conImagen: false })
      analisisHistorico = analisis
    } catch (err) {
      logger.warn(`Histórico ${disp.imei}: ${err.message}`)
    }
  }

  const usuarios = await db.obtenerUsuariosDeEquipo(disp.imei)
  let algunEnvio = false

  for (const u of usuarios) {
    if (!puedeRecibirAlertas(u)) {
      await omitirAlertaPorPrueba(u, { imei: disp.imei, codigo: 'fuera_de_rango' })
      continue
    }
    const jid = jidDeTelefono(u.telefono)
    if (estaMuteado(jid)) continue

    const seg = await obtenerSeguimientoActivo(u.id, disp.imei, 'fuera_de_rango')
    if (seg?.ack_en || seg?.estado === 'ack') continue

    const decision = decidirNotificacionFuera(horasContinuas, seg, umbrales)
    if (!decision.notificar) continue

    const texto = await redactarAvisoFuera(u, {
      nombreEquipo: disp.nombre || disp.imei,
      imei: disp.imei,
      horas: horasContinuas,
      umbral: decision.umbral,
      esPrimera: decision.esPrimera,
      esReaviso: decision.esReaviso,
      datoClave: analisisHistorico?.mensajeHoras
        ? `${analisisHistorico.mensajeHoras}\n${detalleBase}`
        : detalleBase,
      sensorVal,
      setRef,
      delta
    })

    encolarConversacion(jid, [texto], {
      prioridad: 1,
      usuarioId: u.id,
      imeiContexto: disp.imei,
      meta: { codigo: 'fuera_de_rango', umbral: decision.umbral, horas: horasContinuas }
    })
    setContexto(jid, {
      ultimo_usuario_id: u.id,
      ultimo_imei: disp.imei,
      ultimo_nombre_equipo: disp.nombre || disp.imei,
      ultima_alerta_codigo: 'fuera_de_rango',
      esperando: 'seguimiento'
    })
    await upsertSeguimientoNotificado(u.id, disp.imei, 'fuera_de_rango', decision.umbral, {
      horas: horasContinuas,
      es_reaviso: decision.esReaviso
    })
    await db.registrarEventoConversacion(u.id, decision.esPrimera ? 'alerta_fuera' : 'reaviso_fuera', {
      detalle: `Fuera de rango ~${horasContinuas.toFixed(1)}h (umbral ${decision.umbral}) · ${disp.nombre || disp.imei}`,
      meta: { imei: disp.imei, umbral: decision.umbral, horas: horasContinuas }
    })
    algunEnvio = true
  }

  if (algunEnvio) {
    const pendiente = await db.tieneAlertaPendiente(disp.imei, 'fuera_de_rango')
    if (!pendiente) {
      await db.registrarAlerta({
        equipo_id: disp.imei,
        tipo_alerta: `${TIPO_ALERTA.fuera_de_rango}: ${detalleBase}`,
        temperatura: sensorVal,
        ubicacion: disp.last_ip,
        nivel: 'critico',
        codigo: 'fuera_de_rango'
      })
    }
    alertas.push('fuera_de_rango')
    logger.info(
      `⚠️ Fuera de rango ${disp.imei}: ${horasContinuas.toFixed(2)}h (min ${umbrales.minHoras}h)`
    )
  }

  return { alertas, horasContinuas }
}

async function procesarRecuperacionRango(disp, { notificar, config, horasFuera }) {
  await db.setFueraDesde(disp.id, null)
  await db.resolverAlertasPorCodigo(disp.imei, ['fuera_de_rango'])
  await resolverSeguimiento(disp.imei, 'fuera_de_rango')
  await db.actualizarMonitoreoEstado(disp.id, { en_rango: true })

  const umbrales = leerUmbrales(config)
  if (!notificar || !umbrales.avisarEnRango || !horasFuera || horasFuera < umbrales.minHoras * 0.5) {
    return []
  }

  const r = await notificarUsuarios(
    disp,
    'en_rango',
    async (u) => redactarRecuperacionRango(u, {
      nombreEquipo: disp.nombre || disp.imei,
      imei: disp.imei,
      horasFuera
    }),
    { nivel: 'normal', meta: { horasFuera } }
  )
  if (r.encolados) logger.info(`✅ En rango ${disp.imei} → ${r.encolados} avisos`)
  return r.encolados ? ['en_rango'] : []
}

async function evaluarDispositivo(dispositivoId, { notificar = true } = {}) {
  const disp = await db.obtenerDispositivoPorId(dispositivoId)
  if (!disp) throw new Error('Dispositivo no encontrado')
  if (!disp.alarmas_activas) return { skip: true, motivo: 'Monitoreo desactivado' }

  // Prioridad ztrack: las alertas push las dispara el monitor correo (ultimasAlertasEnviadas)
  if (disp.prioridad_monitor && notificar) {
    return {
      skip: true,
      motivo: 'prioridad_monitor',
      prioridad_monitor: true,
      alertas: []
    }
  }

  const config = await db.obtenerConfigApi()
  const umbrales = leerUmbrales(config)
  const alertas = []

  // ── 1. Validar conexión PRIMERO ───────────────────────────
  if (disp.estado_conexion !== 'online') {
    const codigo = disp.estado_conexion === 'wait' ? 'wait' : 'offline'
    const pendiente = await db.tieneAlertaPendiente(disp.imei, codigo)

    if (notificar && !pendiente) {
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

  // ── 2. Online → telemetría live ───────────────────────────
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

  const veniaOffline =
    (await db.tieneAlertaPendiente(disp.imei, 'offline')) ||
    (await db.tieneAlertaPendiente(disp.imei, 'wait'))

  if (notificar) {
    await db.resolverAlertasPorCodigo(disp.imei, ['offline', 'wait'])
    if (umbrales.avisarOnline && veniaOffline) {
      const r = await notificarUsuarios(
        disp,
        'online',
        async (u) => redactarOnline(u, {
          nombreEquipo: disp.nombre || disp.imei,
          imei: disp.imei
        }),
        { nivel: 'normal' }
      )
      if (r.encolados) alertas.push('online')
    }
  }

  const setRef = disp.set_control != null ? parseFloat(disp.set_control) : telem.set_point_live
  const delta = disp.delta != null ? parseFloat(disp.delta) : DELTA_DEFAULT
  const sensorKey = disp.sensor_control || 'return_air'
  const sensorVal = ultimo[sensorKey]
  const sensorNombre = SENSORES[sensorKey] || sensorKey

  // ── 3. Cambio setpoint ────────────────────────────────────
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

  // ── 4. Fuera / en rango con umbrales y reavisos ───────────
  if (sensorVal != null && setRef != null) {
    const dentroRango = sensorVal >= (setRef - delta) && sensorVal <= (setRef + delta)

    if (!dentroRango) {
      const r = await procesarFueraDeRango(disp, {
        sensorVal, setRef, delta, sensorNombre, notificar, config
      })
      alertas.push(...(r.alertas || []))
    } else {
      const horasFuera = disp.fuera_desde
        ? (Date.now() - new Date(disp.fuera_desde).getTime()) / 3600000
        : (disp.en_rango === false ? umbrales.minHoras : 0)

      if (disp.en_rango === false || disp.fuera_desde) {
        const rec = await procesarRecuperacionRango(disp, { notificar, config, horasFuera })
        alertas.push(...rec)
      } else {
        await db.actualizarMonitoreoEstado(disp.id, { en_rango: true })
      }
    }
  }

  return {
    online: true,
    alertas,
    telemetria: telem,
    rango: setRef != null
      ? { set: setRef, delta, min: setRef - delta, max: setRef + delta, sensor: sensorNombre, valor: sensorVal }
      : null
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
  let disp = await db.obtenerDispositivoPorId(dispositivoId)
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
