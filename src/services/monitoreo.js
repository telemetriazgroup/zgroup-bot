const { db } = require('../db')
const { logger } = require('../logger')
const { fetchLiveData, extraerTelemetria, SENSORES } = require('./live')
const { analizarYGenerarGrafica, resolverRangoAnalisis } = require('./historico')
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
  redactarRecuperacionRango,
  redactarOnline
} = require('./alerta-seguimiento')

const DELTA_DEFAULT = 5
const WAIT_INTERNO_DEFAULT = 2
const WAIT_USUARIO_DEFAULT = 4

const TIPO_ALERTA = {
  offline: 'Dispositivo OFFLINE — sin conexión',
  wait:    'Dispositivo en WAIT — sin datos recientes',
  fuera_de_rango: 'FUERA DE RANGO — temperatura',
  cambio_setpoint: 'CAMBIO DE SETPOINT detectado',
  en_rango: 'Temperatura de vuelta al rango',
  online: 'Dispositivo en línea'
}

function horasSinDato(disp) {
  if (!disp?.ultimo_dato) return Infinity
  const t = new Date(disp.ultimo_dato).getTime()
  if (Number.isNaN(t)) return Infinity
  return Math.max(0, (Date.now() - t) / 3600000)
}

function umbralesWait(config) {
  const interno = Math.max(0.5, parseFloat(config?.wait_interno_horas ?? WAIT_INTERNO_DEFAULT) || WAIT_INTERNO_DEFAULT)
  const usuario = Math.max(interno, parseFloat(config?.wait_usuario_horas ?? WAIT_USUARIO_DEFAULT) || WAIT_USUARIO_DEFAULT)
  return { interno, usuario }
}

/**
 * Wait/offline: incidente interno ≥ interno h; WhatsApp usuario ≥ usuario h.
 * Con prioridad ztrack no se avisa localmente (lo hace el monitor correo).
 */
async function evaluarConexionSinDatos(disp, codigo, { notificar, config }) {
  const alertas = []
  const horas = horasSinDato(disp)
  const { interno, usuario } = umbralesWait(config)
  const pendiente = await db.tieneAlertaPendiente(disp.imei, codigo)

  if (horas < interno) {
    await db.actualizarMonitoreoEstado(disp.id, { en_rango: false })
    return {
      online: false,
      estado: disp.estado_conexion,
      alertas,
      horas_sin_dato: horas,
      motivo: 'bajo_umbral_interno'
    }
  }

  // Registro interno (nosotros) a partir de `interno` horas — sin WA
  if (!pendiente) {
    await db.registrarAlerta({
      equipo_id: disp.imei,
      tipo_alerta: `${TIPO_ALERTA[codigo] || codigo}: ~${horas.toFixed(1)} h sin dato (interno ≥${interno} h)`,
      ubicacion: disp.last_ip,
      nivel: codigo === 'offline' ? 'critico' : 'normal',
      codigo
    })
    await db.registrarEventoConversacion(null, 'incidente_interno', {
      detalle: `[interno] ${codigo} ${disp.imei} ~${horas.toFixed(1)}h (usuario ≥${usuario}h)`,
      meta: { imei: disp.imei, codigo, horas, interno, usuario }
    }).catch(() => {})
    alertas.push(`${codigo}_interno`)
    logger.info(`📝 Incidente interno ${codigo} ${disp.imei}: ${horas.toFixed(2)}h (WA usuario ≥${usuario}h)`)
  }

  // WhatsApp al cliente solo desde `usuario` horas (y sin prioridad ztrack)
  if (notificar && !disp.prioridad_monitor && horas >= usuario) {
    const flagKey = `alerta_${codigo}`
    if (config?.[flagKey] !== false) {
      const usuarios = await db.obtenerUsuariosDeEquipo(disp.imei)
      let faltaWa = false
      for (const u of usuarios) {
        const s = await obtenerSeguimientoActivo(u.id, disp.imei, codigo)
        if (!s || parseFloat(s.ultimo_umbral_horas || 0) + 0.001 < usuario) {
          faltaWa = true
          break
        }
      }
      if (faltaWa) {
        const r = await notificarUsuarios(
          disp,
          codigo,
          async (u, { indiceLote = 0, totalUsuarios = 1 } = {}) => {
            const { mensajeAvisoAlerta, codigoATextoHumano } = require('./conversacion')
            return mensajeAvisoAlerta(u, {
              nombreEquipo: disp.nombre || disp.imei,
              imei: disp.imei,
              codigo,
              quePaso: `lleva ~${horas.toFixed(1)} h sin datos (${codigoATextoHumano(codigo)})`,
              datoClave: `Último dato: ${disp.ultimo_dato || 'N/A'} · aviso usuario desde ${usuario} h`,
              horas,
              indiceLote,
              totalUsuarios
            })
          },
          { nivel: codigo === 'offline' ? 'critico' : 'normal', meta: { horas, usuario } }
        )
        for (const u of usuarios) {
          await upsertSeguimientoNotificado(u.id, disp.imei, codigo, usuario, { horas, origen: 'wait_local' })
        }
        if (r.encolados) alertas.push(codigo)
        logger.info(`📨 WA ${codigo} ${disp.imei}: ${horas.toFixed(2)}h → ${r.encolados} usuarios`)
      }
    }
  }

  await db.actualizarMonitoreoEstado(disp.id, { en_rango: false })
  return {
    online: false,
    estado: disp.estado_conexion,
    alertas,
    horas_sin_dato: horas
  }
}

async function notificarUsuarios(disp, codigo, redactarFn, { nivel = 'normal', meta = {} } = {}) {
  const configs = await db.listarConfigAlertas()
  const cfg = configs.find(c => c.tipo === codigo)
  if (cfg && cfg.activo === false && codigo !== 'en_rango' && codigo !== 'online') return { encolados: 0 }

  const usuarios = await db.obtenerUsuariosDeEquipo(disp.imei)
  if (!usuarios.length) return { encolados: 0 }

  const elegibles = []
  for (const u of usuarios) {
    const jid = jidDeTelefono(u.telefono)
    if (estaMuteado(jid)) continue
    if (!puedeRecibirAlertas(u)) {
      await omitirAlertaPorPrueba(u, { imei: disp.imei, codigo })
      continue
    }
    elegibles.push(u)
  }

  let encolados = 0
  const bloqueados = usuarios.length - elegibles.length
  const totalUsuarios = elegibles.length

  for (let i = 0; i < elegibles.length; i++) {
    const u = elegibles[i]
    const jid = jidDeTelefono(u.telefono)
    const texto = await redactarFn(u, { indiceLote: i, totalUsuarios })
    encolarConversacion(jid, [texto], {
      modo: 'alerta',
      esAlerta: true,
      prioridad: nivel === 'critico' ? 3 : 4,
      usuarioId: u.id,
      imeiContexto: disp.imei,
      meta: { codigo, variante_lote: i, total_usuarios: totalUsuarios, ...meta }
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
      detalle: `Alerta encolada: ${codigo} · ${disp.nombre || disp.imei} · var#${i}`,
      meta: { imei: disp.imei, codigo, nivel, indiceLote: i, totalUsuarios, ...meta }
    })
    encolados++
  }
  return { encolados, bloqueados, totalUsuarios }
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
    async (u, { indiceLote = 0, totalUsuarios = 1 } = {}) => {
      const { mensajeAvisoAlerta, codigoATextoHumano } = require('./conversacion')
      return mensajeAvisoAlerta(u, {
        nombreEquipo: nombre,
        imei: disp.imei,
        codigo,
        quePaso: `El reefer ${codigoATextoHumano(codigo)}.`,
        datoClave,
        indiceLote,
        totalUsuarios
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
  sensorVal, setRef, delta, min, max, sensorNombre, notificar, config, origenRango = 'local'
}) {
  const umbrales = leerUmbrales(config)
  const minB = min != null ? min : setRef - delta
  const maxB = max != null ? max : setRef + delta
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
    origenRango === 'ztrack'
      ? `${sensorNombre}: ${sensorVal}°C | Rango ztrack: ${minB}°C a ${maxB}°C (set ${setRef}°C)`
      : `${sensorNombre}: ${sensorVal}°C | Rango: ${minB}°C a ${maxB}°C (Set ${setRef}°C ±${delta})`

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
  const elegibles = []

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
    elegibles.push({ u, jid, decision })
  }

  const { mensajeAlertaVariante } = require('./alerta-variantes')
  const totalUsuarios = elegibles.length

  for (let i = 0; i < elegibles.length; i++) {
    const { u, jid, decision } = elegibles[i]
    const datoClave = analisisHistorico?.mensajeHoras
      ? `${analisisHistorico.mensajeHoras}\n${detalleBase}`
      : detalleBase

    const { texto, variante } = mensajeAlertaVariante(u, {
      nombreEquipo: disp.nombre || disp.imei,
      imei: disp.imei,
      codigo: 'fuera_de_rango',
      familia: 'fuera',
      quePaso: decision.esReaviso
        ? 'Sigue fuera de rango.'
        : 'Está fuera de rango.',
      datoClave,
      horas: horasContinuas,
      indiceLote: i,
      totalUsuarios
    })

    encolarConversacion(jid, [texto], {
      modo: 'alerta',
      esAlerta: true,
      prioridad: 3,
      usuarioId: u.id,
      imeiContexto: disp.imei,
      meta: {
        codigo: 'fuera_de_rango',
        umbral: decision.umbral,
        horas: horasContinuas,
        variante
      }
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
      es_reaviso: decision.esReaviso,
      variante
    })
    await db.registrarEventoConversacion(u.id, decision.esPrimera ? 'alerta_fuera' : 'reaviso_fuera', {
      detalle: `Fuera de rango ~${horasContinuas.toFixed(1)}h (umbral ${decision.umbral}) · ${disp.nombre || disp.imei} · var#${variante}`,
      meta: { imei: disp.imei, umbral: decision.umbral, horas: horasContinuas, variante }
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
    async (u, opts = {}) => redactarRecuperacionRango(u, {
      nombreEquipo: disp.nombre || disp.imei,
      imei: disp.imei,
      horasFuera,
      ...opts
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

  const config = await db.obtenerConfigApi()
  const umbrales = leerUmbrales(config)
  const alertas = []

  // ── 1. Wait/offline: interno ≥2 h siempre; WA usuario ≥4 h (sin prioridad ztrack) ──
  if (disp.estado_conexion !== 'online') {
    const codigo = disp.estado_conexion === 'wait' ? 'wait' : 'offline'
    // Con prioridad ztrack: solo incidente interno (WA lo decide el monitor correo ≥4 h)
    return evaluarConexionSinDatos(disp, codigo, {
      notificar: notificar && !disp.prioridad_monitor,
      config
    })
  }

  // Prioridad ztrack: online → no push local de temp/setpoint (solo correo ztrack o prueba admin)
  if (disp.prioridad_monitor && notificar) {
    return {
      skip: true,
      motivo: 'prioridad_monitor',
      prioridad_monitor: true,
      alertas_locales_suprimidas: true,
      mensaje:
        'Alertas locales de temperatura/setpoint suprimidas: este IMEI usa prioridad ztrack. Wait/sin datos: interno local + WA desde umbral usuario vía monitor correo.',
      alertas: [],
      ztrack: {
        en_rango: disp.ztrack_en_rango,
        estado: disp.ztrack_estado,
        criterio: disp.ztrack_criterio,
        actualizado_en: disp.ztrack_actualizado_en
      }
    }
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
        async (u, opts = {}) => redactarOnline(u, {
          nombreEquipo: disp.nombre || disp.imei,
          imei: disp.imei,
          ...opts
        }),
        { nivel: 'normal' }
      )
      if (r.encolados) alertas.push('online')
    }
  }

  const sensorKey = disp.sensor_control || 'return_air'
  const sensorVal = ultimo[sensorKey]
  const sensorNombre = SENSORES[sensorKey] || sensorKey
  const rangoEf = resolverRangoAnalisis(disp, {
    setRef: disp.set_control != null ? parseFloat(disp.set_control) : telem.set_point_live,
    delta: disp.delta != null ? parseFloat(disp.delta) : DELTA_DEFAULT
  })
  const setRef = rangoEf.setControl != null
    ? rangoEf.setControl
    : (disp.set_control != null ? parseFloat(disp.set_control) : telem.set_point_live)
  const delta = rangoEf.delta != null ? rangoEf.delta : DELTA_DEFAULT
  const minR = rangoEf.min
  const maxR = rangoEf.max

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

  // ── 4. Fuera / en rango (banda ztrack o local) ────────────
  if (sensorVal != null && minR != null && maxR != null) {
    const dentroRango = sensorVal >= minR && sensorVal <= maxR

    if (!dentroRango) {
      const r = await procesarFueraDeRango(disp, {
        sensorVal,
        setRef,
        delta,
        min: minR,
        max: maxR,
        sensorNombre,
        notificar,
        config,
        origenRango: rangoEf.origen
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
    rango: minR != null
      ? {
          set: setRef,
          delta,
          min: minR,
          max: maxR,
          sensor: sensorNombre,
          valor: sensorVal,
          origen: rangoEf.origen
        }
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
  const rangoLocal = setRef != null ? {
    origen: 'local',
    set: setRef,
    delta,
    min: setRef - delta,
    max: setRef + delta,
    sensor: SENSORES[disp.sensor_control || 'return_air'] || (disp.sensor_control || 'return_air')
  } : null

  const zr = disp.ztrack_rango && typeof disp.ztrack_rango === 'object' ? disp.ztrack_rango : null
  const rangoZtrack = zr && (zr.setPoint != null || zr.min != null)
    ? {
        origen: 'ztrack',
        set: zr.setPoint,
        min: zr.min,
        max: zr.max,
        margenInferior: zr.margenInferior,
        margenSuperior: zr.margenSuperior,
        metricaGuia: zr.metricaGuia || 'return_air',
        personalizado: zr.personalizado
      }
    : null

  return {
    dispositivo: disp,
    live: live?.ultimo || null,
    sensores,
    error,
    rango: rangoLocal,
    rango_local: rangoLocal,
    rango_ztrack: rangoZtrack,
    ztrack: {
      vinculado: !!(disp.monitor_row_key || disp.prioridad_monitor),
      prioridad: !!disp.prioridad_monitor,
      alertas_locales_suprimidas: !!disp.prioridad_monitor,
      grupo: disp.monitor_grupo || null,
      en_rango: disp.ztrack_en_rango,
      estado: disp.ztrack_estado,
      criterio: disp.ztrack_criterio,
      umbrales: disp.ztrack_umbrales,
      telemetria: disp.ztrack_telemetria,
      episodio: disp.ztrack_episodio,
      actualizado_en: disp.ztrack_actualizado_en
    },
    referencia: live?.referencia_servidor
  }
}

module.exports = { evaluarDispositivo, monitorearDispositivosActivos, obtenerLiveDispositivo, DELTA_DEFAULT }
