/**
 * Monitor externo ztrack → disparador WhatsApp (solo ultimasAlertasEnviadas).
 *
 * - Poll cada N min
 * - Prioridad API: dispositivos con prioridad_monitor=true (desactivable en admin)
 * - Si prioridad OFF → no dispara por API; sigue la lógica local de monitoreo
 * - Control estricto por umbral: apagado 2h una vez, luego 3h, etc. (por día Lima)
 */
const { db, pool } = require('../db')
const { logger } = require('../logger')
const { encolarConversacion, jidDeTelefono } = require('./outbox')
const { setContexto, estaMuteado, nombrePila } = require('./conversacion')
const { puedeRecibirAlertas, omitirAlertaPorPrueba } = require('./prueba-activacion')
const { upsertSeguimientoNotificado } = require('./alerta-seguimiento')

const URL_DEFAULT = 'https://ztrack.app/reefer/api/correo/external/monitor'

const KIND_LABEL = {
  fuera_rango: 'fuera de rango',
  apagado: 'apagado',
  fuera_linea: 'sin conexión / fuera de línea',
  offline: 'sin conexión'
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function diaLima(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d)
}

function fmtHoras(h) {
  if (h == null || Number.isNaN(Number(h))) return null
  const n = Number(h)
  if (n < 1) return `${Math.round(n * 60)} min`
  const e = Math.floor(n)
  const m = Math.round((n - e) * 60)
  return m ? `${e} h ${m} min` : `${e} h`
}

function mapCodigoInterno(alertKind) {
  const k = String(alertKind || '').toLowerCase()
  if (k.includes('apagado')) return 'apagado'
  if (k.includes('linea') || k.includes('offline') || k.includes('wait')) return 'fuera_linea'
  return 'fuera_de_rango'
}

/** Clave de umbral para no repetir la misma alerta (2h, 3h, …). */
function umbralKeyDeEnvio(envio) {
  if (envio.umbralHoras != null && !Number.isNaN(Number(envio.umbralHoras))) {
    return Math.round(Number(envio.umbralHoras) * 100) / 100
  }
  if (envio.horasAcumuladas != null && !Number.isNaN(Number(envio.horasAcumuladas))) {
    return Math.round(Number(envio.horasAcumuladas) * 100) / 100
  }
  if (envio.horasOffline != null && !Number.isNaN(Number(envio.horasOffline))) {
    // Fuera de línea sin umbral explícito: redondeo a 0.5 h
    return Math.floor(Number(envio.horasOffline) * 2) / 2
  }
  return 0
}

function horasDeEnvio(envio) {
  return envio.horasAcumuladas ?? envio.horasOffline ?? envio.umbralHoras ?? null
}

function resumirEquipo(eq) {
  const cfg = eq.configuracionAlerta || {}
  const rango = eq.rangoProgramado || null
  const telem = eq.telemetriaActual || eq.ultimaEvaluacionCiclo?.telemetria || null
  const epi = eq.episodioActivo || null
  const evalCiclo = eq.ultimaEvaluacionCiclo || null
  return {
    rowKey: eq.rowKey,
    imei: eq.imei,
    codigo: eq.codigo,
    enabled: eq.enabled,
    cliente: eq.cliente,
    grupoNombre: eq.grupoNombre,
    nombrePlataforma: eq.nombrePlataforma || eq.descripcionEquipo,
    umbralesHoras: eq.umbralesHoras || cfg.umbralesHoras || null,
    configuracionAlerta: {
      mode: cfg.mode,
      alerta30Minutos: cfg.alerta30Minutos,
      alerta1Hora: cfg.alerta1Hora,
      useRangoPersonalizado: cfg.useRangoPersonalizado,
      margenInferior: cfg.margenInferior,
      margenSuperior: cfg.margenSuperior
    },
    rangoProgramado: rango
      ? {
          setPoint: rango.setPoint,
          min: rango.min,
          max: rango.max,
          margenInferior: rango.margenInferior,
          margenSuperior: rango.margenSuperior,
          metricaGuia: rango.metricaGuia,
          personalizado: rango.personalizado
        }
      : null,
    enRango: eq.enRango,
    telemetria: telem
      ? {
          estado_conexion: telem.estado_conexion || telem.estadoConexion,
          return_air: telem.return_air ?? telem.returnAir,
          set_point: telem.set_point ?? telem.setPoint,
          temp_supply: telem.temp_supply_1 ?? telem.tempSupply,
          power_state: telem.power_state ?? telem.powerState,
          minutos_desde_ultimo_dato: telem.minutos_desde_ultimo_dato,
          ultima_actualizacion: telem.ultima_actualizacion || telem.ultimaActualizacion,
          en_defrost: telem.en_defrost ?? telem.enDefrost
        }
      : null,
    episodioActivo: epi
      ? {
          kind: epi.kind,
          since: epi.since,
          sentUmbrales: epi.sentUmbrales || [],
          establishedAt: epi.establishedAt
        }
      : null,
    ultimaEvaluacion: evalCiclo
      ? {
          estado: evalCiclo.estado,
          accion: evalCiclo.accion,
          criterio: evalCiclo.criterio,
          umbralDisparado: evalCiclo.umbralDisparado,
          referenciaDesde: evalCiclo.referenciaDesde
        }
      : null
  }
}

function resumirAlertaEnvio(envio) {
  return {
    id: envio.id,
    alertKind: envio.alertKind,
    sentAt: envio.sentAt,
    imei: envio.imei,
    nombrePlataforma: envio.nombrePlataforma || envio.descripcionEquipo,
    grupoNombre: envio.grupoNombre,
    umbralHoras: envio.umbralHoras,
    horasAcumuladas: envio.horasAcumuladas,
    horasOffline: envio.horasOffline,
    destinatarioTipo: envio.destinatarioTipo,
    subject: envio.subject
  }
}

/** Payload más liviano para guardar (sin muestras históricas pesadas). */
function payloadParaHistorial(data) {
  if (!data || typeof data !== 'object') return data
  return {
    generatedAt: data.generatedAt,
    aplicacion: data.aplicacion || null,
    resumen: data.resumen || null,
    equiposProgramados: (data.equiposProgramados || []).map(resumirEquipo),
    ultimasAlertasEnviadas: (data.ultimasAlertasEnviadas || []).map(resumirAlertaEnvio)
  }
}

async function fetchMonitor(url) {
  const t0 = Date.now()
  let httpStatus = null
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    })
    httpStatus = res.status
    const txt = await res.text()
    let json
    try {
      json = JSON.parse(txt)
    } catch {
      throw Object.assign(new Error(`Respuesta no JSON: ${txt.slice(0, 180)}`), { httpStatus })
    }
    if (!res.ok) {
      throw Object.assign(
        new Error(`HTTP ${res.status}: ${(json?.message || txt).toString().slice(0, 200)}`),
        { httpStatus }
      )
    }
    if (!json?.ok && json?.code !== 200) {
      throw Object.assign(new Error(json?.message || 'Respuesta monitor no ok'), { httpStatus })
    }
    return {
      data: json.data || json,
      httpStatus,
      duracionMs: Date.now() - t0
    }
  } catch (err) {
    err.httpStatus = err.httpStatus ?? httpStatus
    err.duracionMs = Date.now() - t0
    throw err
  }
}

async function registrarConsultaApi(row) {
  const { rows } = await pool.query(
    `INSERT INTO monitor_api_consultas (
       url, ok, http_status, error_mensaje, duracion_ms,
       generated_at, ciclo_id, resumen, equipos_resumen, alertas_resumen,
       payload, wa_encolados, prioridad_count, en_api_local, procesado_wa, meta
     ) VALUES (
       $1,$2,$3,$4,$5,
       $6,$7,$8::jsonb,$9::jsonb,$10::jsonb,
       $11::jsonb,$12,$13,$14,$15,$16::jsonb
     ) RETURNING id, consultado_en`,
    [
      row.url,
      !!row.ok,
      row.httpStatus ?? null,
      row.errorMensaje || null,
      row.duracionMs ?? null,
      row.generatedAt || null,
      row.cicloId || null,
      JSON.stringify(row.resumen ?? null),
      JSON.stringify(Array.isArray(row.equiposResumen) ? row.equiposResumen : []),
      JSON.stringify(Array.isArray(row.alertasResumen) ? row.alertasResumen : []),
      JSON.stringify(row.payload ?? null),
      row.waEncolados ?? 0,
      row.prioridadCount ?? null,
      row.enApiLocal ?? null,
      !!row.procesadoWa,
      JSON.stringify(row.meta || null)
    ]
  )

  // Retención: últimas 500 consultas
  await pool.query(`
    DELETE FROM monitor_api_consultas
    WHERE id NOT IN (
      SELECT id FROM monitor_api_consultas ORDER BY consultado_en DESC LIMIT 500
    )
  `)

  return rows[0]
}

async function listarConsultasMonitor({ limit = 50, offset = 0, soloErrores = false } = {}) {
  const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50))
  const off = Math.max(0, parseInt(offset, 10) || 0)
  const params = []
  let where = ''
  if (soloErrores) {
    where = 'WHERE ok = false'
  }
  params.push(lim, off)
  const { rows } = await pool.query(
    `SELECT id, consultado_en, url, ok, http_status, error_mensaje, duracion_ms,
            generated_at, ciclo_id, resumen, wa_encolados, prioridad_count,
            en_api_local, procesado_wa, meta,
            CASE WHEN jsonb_typeof(equipos_resumen) = 'array'
              THEN jsonb_array_length(equipos_resumen) ELSE 0 END AS equipos_count,
            CASE WHEN jsonb_typeof(alertas_resumen) = 'array'
              THEN jsonb_array_length(alertas_resumen) ELSE 0 END AS alertas_count
     FROM monitor_api_consultas
     ${where}
     ORDER BY consultado_en DESC
     LIMIT $1 OFFSET $2`,
    params
  )
  const { rows: tot } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM monitor_api_consultas ${where}`
  )
  return { total: tot[0]?.total || 0, consultas: rows }
}

async function obtenerConsultaMonitor(id) {
  const { rows } = await pool.query(
    'SELECT * FROM monitor_api_consultas WHERE id = $1',
    [id]
  )
  return rows[0] || null
}

async function obtenerUltimaConsultaMonitor({ soloOk = false } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM monitor_api_consultas
     ${soloOk ? 'WHERE ok = true' : ''}
     ORDER BY consultado_en DESC LIMIT 1`
  )
  return rows[0] || null
}

async function obtenerEstadoMonitorUi() {
  const config = await db.obtenerConfigApi()
  const ultima = await obtenerUltimaConsultaMonitor()
  const ultimaOk = await obtenerUltimaConsultaMonitor({ soloOk: true })
  const { rows: stats } = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE ok)::int AS ok,
      COUNT(*) FILTER (WHERE NOT ok)::int AS error,
      MAX(consultado_en) AS ultima_en
    FROM monitor_api_consultas
    WHERE consultado_en > NOW() - INTERVAL '24 hours'
  `)
  const { rows: prio } = await pool.query(`
    SELECT COUNT(*)::int AS n FROM dispositivos
    WHERE prioridad_monitor = true AND alarmas_activas = true
  `)
  return {
    config: {
      url: process.env.MONITOR_EXTERNO_URL || config?.monitor_externo_url || URL_DEFAULT,
      minutos: config?.monitor_externo_minutos ?? 5,
      activo: config?.monitor_externo_activo !== false
    },
    stats_24h: stats[0] || { total: 0, ok: 0, error: 0 },
    prioridad_activos: prio[0]?.n || 0,
    ultima,
    ultima_ok: ultimaOk
  }
}

async function envioYaProcesado(envioId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM monitor_envios_procesados WHERE envio_id = $1',
    [envioId]
  )
  return rows.length > 0
}

async function marcarEnvioProcesado(envio, { notificado = false, motivo = null } = {}) {
  await pool.query(
    `INSERT INTO monitor_envios_procesados (envio_id, imei, alert_kind, umbral_horas, meta)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (envio_id) DO NOTHING`,
    [
      envio.id,
      envio.imei || null,
      envio.alertKind || null,
      umbralKeyDeEnvio(envio),
      JSON.stringify({
        subject: envio.subject,
        sentAt: envio.sentAt,
        grupoNombre: envio.grupoNombre,
        destinatarioTipo: envio.destinatarioTipo,
        notificado,
        motivo
      })
    ]
  )
}

async function umbralYaNotificado(imei, alertKind, umbralKey, dia = diaLima()) {
  const { rows } = await pool.query(
    `SELECT 1 FROM monitor_umbrales_notificados
     WHERE imei = $1 AND alert_kind = $2 AND umbral_key = $3 AND dia_lima = $4::date`,
    [imei, alertKind, umbralKey, dia]
  )
  return rows.length > 0
}

async function registrarUmbralNotificado(imei, alertKind, umbralKey, envioId, dia = diaLima()) {
  await pool.query(
    `INSERT INTO monitor_umbrales_notificados (imei, alert_kind, umbral_key, dia_lima, envio_id)
     VALUES ($1,$2,$3,$4::date,$5)
     ON CONFLICT (imei, alert_kind, umbral_key, dia_lima) DO NOTHING`,
    [imei, alertKind, umbralKey, dia, envioId || null]
  )
}

async function esPrimerCiclo() {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM monitor_envios_procesados'
  )
  return (rows[0]?.n || 0) === 0
}

/** Si ya hay envíos procesados pero aún no hay control de umbrales, rellenar. */
async function backfillUmbralesDesdeEnvios() {
  const { rows: cnt } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM monitor_umbrales_notificados'
  )
  if ((cnt[0]?.n || 0) > 0) return 0

  const { rows } = await pool.query(
    `SELECT envio_id, imei, alert_kind, umbral_horas, procesado_en
     FROM monitor_envios_procesados
     WHERE imei IS NOT NULL AND alert_kind IS NOT NULL`
  )
  let n = 0
  for (const r of rows) {
    const dia = diaLima(r.procesado_en || new Date())
    await registrarUmbralNotificado(
      r.imei,
      r.alert_kind,
      Number(r.umbral_horas) || 0,
      r.envio_id,
      dia
    )
    n++
  }
  if (n) logger.info(`🛰️ Backfill umbrales notificados: ${n} desde envíos previos`)
  return n
}

/**
 * Sincroniza metadata + contexto ztrack (rangos, estado, telemetría).
 * NO pisa prioridad_monitor=false: solo la activa la primera vez que aparece en el API.
 */
async function persistirContextoZtrack(disp, eq, { consultaId = null } = {}) {
  const resumen = resumirEquipo(eq)
  const rango = resumen.rangoProgramado
  const umbrales = resumen.umbralesHoras
  const enRango = resumen.enRango
  const estado = resumen.ultimaEvaluacion?.estado || null
  const criterio = resumen.ultimaEvaluacion?.criterio || null
  const telem = resumen.telemetria
  const epi = resumen.episodioActivo

  await pool.query(
    `UPDATE dispositivos SET
       prioridad_monitor = CASE
         WHEN monitor_row_key IS NULL THEN true
         ELSE prioridad_monitor
       END,
       monitor_row_key = $2,
       monitor_grupo = $3,
       nombre = CASE
         WHEN nombre IS NULL OR nombre = imei OR nombre = '' THEN $4
         ELSE nombre
       END,
       ztrack_rango = $5::jsonb,
       ztrack_umbrales = $6::jsonb,
       ztrack_en_rango = $7,
       ztrack_estado = $8,
       ztrack_criterio = $9,
       ztrack_telemetria = $10::jsonb,
       ztrack_episodio = $11::jsonb,
       ztrack_actualizado_en = NOW()
     WHERE id = $1`,
    [
      disp.id,
      eq.rowKey || null,
      eq.grupoNombre || null,
      eq.nombrePlataforma || eq.descripcionEquipo || disp.nombre || disp.imei,
      JSON.stringify(rango),
      JSON.stringify(umbrales),
      enRango,
      estado,
      criterio,
      JSON.stringify(telem),
      JSON.stringify(epi)
    ]
  )

  await pool.query(
    `INSERT INTO dispositivo_ztrack_historial
       (imei, en_rango, estado, criterio, rango, umbrales, telemetria, episodio, consulta_id)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9)`,
    [
      String(eq.imei),
      enRango,
      estado,
      criterio,
      JSON.stringify(rango),
      JSON.stringify(umbrales),
      JSON.stringify(telem),
      JSON.stringify(epi),
      consultaId
    ]
  )

  // Retención ~48 h por IMEI (o 300 muestras)
  await pool.query(
    `DELETE FROM dispositivo_ztrack_historial
     WHERE imei = $1 AND id NOT IN (
       SELECT id FROM dispositivo_ztrack_historial
       WHERE imei = $1
       ORDER BY consultado_en DESC
       LIMIT 300
     )`,
    [String(eq.imei)]
  )

  const { rows } = await pool.query(
    'SELECT prioridad_monitor FROM dispositivos WHERE id = $1',
    [disp.id]
  )
  return rows[0]?.prioridad_monitor === true
}

async function listarHistorialZtrack(imei, { limit = 48 } = {}) {
  const lim = Math.min(300, Math.max(1, parseInt(limit, 10) || 48))
  const { rows } = await pool.query(
    `SELECT id, imei, consultado_en, en_rango, estado, criterio, rango, umbrales, telemetria, episodio
     FROM dispositivo_ztrack_historial
     WHERE imei = $1
     ORDER BY consultado_en DESC
     LIMIT $2`,
    [String(imei), lim]
  )
  return rows
}

/** @deprecated use persistirContextoZtrack */
async function syncMetadataPrioridad(disp, eq) {
  return persistirContextoZtrack(disp, eq)
}

function redactarDesdeMonitor(usuario, {
  nombreEquipo,
  kind,
  horas,
  umbral,
  criterio,
  telemetria
}) {
  const nombre = nombrePila(usuario.nombre) || ''
  const label = KIND_LABEL[kind] || kind
  const horasTxt = fmtHoras(horas)
  const umbralTxt = umbral != null ? fmtHoras(umbral) : null
  const t = telemetria || {}
  const datos = []
  if (t.returnAir != null || t.return_air != null) {
    datos.push(`Retorno *${t.returnAir ?? t.return_air} °C*`)
  }
  if (t.setPoint != null || t.set_point != null) {
    datos.push(`set *${t.setPoint ?? t.set_point} °C*`)
  }
  if (t.estadoConexion || t.estado_conexion) {
    datos.push(`conexión ${(t.estadoConexion || t.estado_conexion)}`)
  }

  return (
    `${pick(['Hola', 'Buenas', 'Aviso'])}${nombre ? ` ${nombre}` : ''} — el reefer *${nombreEquipo}* está *${label}*` +
    (horasTxt ? ` (~${horasTxt})` : '') +
    (umbralTxt ? ` — umbral ${umbralTxt}` : '') +
    `.\n` +
    (datos.length ? `${datos.join(' · ')}\n` : '') +
    (criterio ? `${String(criterio).slice(0, 220)}\n` : '') +
    `\n¿Lo revisan? Responde *OK*, *GRAFICA* o *ESTADO*.`
  )
}

async function notificarWhatsApp(disp, {
  codigo,
  kind,
  horas,
  umbral,
  criterio,
  telemetria,
  meta
}) {
  const usuarios = await db.obtenerUsuariosDeEquipo(disp.imei)
  if (!usuarios.length) return { encolados: 0, bloqueados: 0 }

  const nombreEquipo = disp.nombre || meta?.nombrePlataforma || disp.imei
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

    const texto = redactarDesdeMonitor(u, {
      nombreEquipo,
      kind,
      horas,
      umbral,
      criterio,
      telemetria
    })

    encolarConversacion(jid, [texto], {
      prioridad: 1,
      usuarioId: u.id,
      imeiContexto: disp.imei,
      meta: { origen: 'monitor_externo', codigo, kind, umbral, ...meta }
    })
    setContexto(jid, {
      ultimo_usuario_id: u.id,
      ultimo_imei: disp.imei,
      ultimo_nombre_equipo: nombreEquipo,
      ultima_alerta_codigo: codigo,
      esperando: 'seguimiento'
    })
    await upsertSeguimientoNotificado(u.id, disp.imei, codigo, umbral ?? horas ?? 0, {
      origen: 'monitor_externo',
      kind,
      horas
    })
    await db.registrarEventoConversacion(u.id, 'monitor_externo_alerta', {
      detalle: `[ztrack] ${kind} · ${nombreEquipo}` +
        (umbral != null ? ` · umbral ${fmtHoras(umbral)}` : '') +
        (horas != null ? ` · ${fmtHoras(horas)}` : ''),
      meta: { imei: disp.imei, codigo, kind, umbral, horas, envioId: meta?.envioId }
    })
    encolados++
  }

  if (encolados) {
    await db.registrarAlerta({
      equipo_id: disp.imei,
      tipo_alerta: `Monitor ztrack (${kind}): ${criterio || KIND_LABEL[kind] || kind}`,
      temperatura: telemetria?.returnAir ?? telemetria?.return_air ?? null,
      ubicacion: null,
      nivel: kind === 'fuera_rango' || codigo === 'fuera_de_rango' ? 'critico' : 'normal',
      codigo
    })
  }

  return { encolados, bloqueados }
}

/**
 * Solo ultimasAlertasEnviadas. Un umbral = un WA por día.
 */
async function procesarUltimasAlertas(ultimas, mapLocal, { bootstrap = false } = {}) {
  const resultados = []
  const yaEnCiclo = new Set() // imei|kind|umbral dentro de este poll
  const dia = diaLima()

  const ordenados = [...(ultimas || [])].sort(
    (a, b) => new Date(a.sentAt || 0) - new Date(b.sentAt || 0)
  )

  for (const envio of ordenados) {
    if (!envio?.id || !envio?.imei) continue
    if (await envioYaProcesado(envio.id)) continue

    const kind = envio.alertKind || mapCodigoInterno(envio.alertKind)
    const umbralKey = umbralKeyDeEnvio(envio)
    const claveUmbral = `${envio.imei}|${kind}|${umbralKey}|${dia}`

    const disp = mapLocal.get(String(envio.imei))

    // Bootstrap / sin dispositivo / sin prioridad → consumir envío sin WA
    if (bootstrap || !disp) {
      await marcarEnvioProcesado(envio, {
        notificado: false,
        motivo: bootstrap ? 'bootstrap' : 'sin_dispositivo_local'
      })
      if (disp || bootstrap) {
        await registrarUmbralNotificado(envio.imei, kind, umbralKey, envio.id, dia)
      }
      continue
    }

    if (!disp.prioridad_monitor) {
      await marcarEnvioProcesado(envio, { notificado: false, motivo: 'prioridad_desactivada' })
      continue
    }

    if (yaEnCiclo.has(claveUmbral) || (await umbralYaNotificado(envio.imei, kind, umbralKey, dia))) {
      await marcarEnvioProcesado(envio, { notificado: false, motivo: 'umbral_ya_notificado' })
      yaEnCiclo.add(claveUmbral)
      continue
    }

    const codigo = mapCodigoInterno(kind)
    const horas = horasDeEnvio(envio)
    const umbralNum = Number(umbralKey) || 0

    // Sin datos / fuera de línea: interno desde wait_interno; WA cliente desde wait_usuario (def. 4 h)
    const esSinDatos = codigo === 'fuera_linea'
    if (esSinDatos) {
      const cfgApi = await db.obtenerConfigApi().catch(() => null)
      const waitInterno = Math.max(0.5, parseFloat(cfgApi?.wait_interno_horas ?? 2) || 2)
      const waitUsuario = Math.max(waitInterno, parseFloat(cfgApi?.wait_usuario_horas ?? 4) || 4)

      if (umbralNum + 0.001 < waitUsuario) {
        await db.registrarAlerta({
          equipo_id: disp.imei,
          tipo_alerta:
            `Monitor ztrack (${kind}): ~${umbralNum} h sin datos (interno ≥${waitInterno} h; WA usuario ≥${waitUsuario} h)`,
          ubicacion: null,
          nivel: 'normal',
          codigo: 'wait'
        })
        await db.registrarEventoConversacion(null, 'incidente_interno', {
          detalle: `[ztrack-interno] ${kind} ${disp.imei} umbral=${umbralNum}h (WA ≥${waitUsuario}h)`,
          meta: {
            imei: disp.imei,
            kind,
            umbral: umbralNum,
            waitInterno,
            waitUsuario,
            envioId: envio.id
          }
        }).catch(() => {})
        await registrarUmbralNotificado(envio.imei, kind, umbralKey, envio.id, dia)
        await marcarEnvioProcesado(envio, {
          notificado: false,
          motivo: 'interno_sin_wa_umbral_bajo'
        })
        yaEnCiclo.add(claveUmbral)
        resultados.push({
          envio_id: envio.id,
          imei: envio.imei,
          kind,
          umbral: umbralKey,
          encolados: 0,
          bloqueados: 0,
          solo_interno: true
        })
        logger.info(
          `📝 Monitor ztrack interno ${envio.imei} ${kind} umbral=${umbralKey} (WA usuario ≥${waitUsuario}h)`
        )
        continue
      }
    }

    const muestra = envio.muestrasUsadas?.puntos?.[0] || null
    const telemetria = muestra
      ? {
          returnAir: muestra.returnAir,
          setPoint: muestra.setPoint,
          powerState: muestra.powerState
        }
      : null

    const r = await notificarWhatsApp(disp, {
      codigo,
      kind,
      horas,
      umbral: envio.umbralHoras ?? umbralKey,
      criterio: envio.subject || null,
      telemetria,
      meta: {
        nombrePlataforma: envio.nombrePlataforma || envio.descripcionEquipo,
        grupoNombre: envio.grupoNombre,
        envioId: envio.id,
        umbralKey
      }
    })

    // Registrar umbral aunque 0 encolados (prueba pendiente): evita reintentos spam del mismo umbral
    await registrarUmbralNotificado(envio.imei, kind, umbralKey, envio.id, dia)
    await marcarEnvioProcesado(envio, {
      notificado: r.encolados > 0,
      motivo: r.encolados > 0 ? 'wa_encolado' : (r.bloqueados ? 'bloqueado_prueba' : 'sin_usuarios')
    })
    yaEnCiclo.add(claveUmbral)

    resultados.push({
      envio_id: envio.id,
      imei: envio.imei,
      kind,
      umbral: umbralKey,
      ...r
    })
    logger.info(
      `📨 Monitor ztrack ${envio.imei} ${kind} umbral=${umbralKey} → WA:${r.encolados} (envio ${envio.id})`
    )
  }
  return resultados
}

async function sincronizarMetadata(equipos, mapLocal, { consultaId = null } = {}) {
  let enApi = 0
  let conPrioridad = 0
  for (const eq of equipos || []) {
    if (!eq?.imei) continue
    let disp = mapLocal.get(String(eq.imei))
    if (!disp) {
      // También vincular IMEIs locales aunque no tengan alarmas_activas aún
      const { rows } = await pool.query(
        'SELECT * FROM dispositivos WHERE imei = $1 LIMIT 1',
        [String(eq.imei)]
      )
      disp = rows[0]
      if (!disp) continue
      mapLocal.set(String(eq.imei), disp)
    }
    enApi++
    const activa = await persistirContextoZtrack(disp, eq, { consultaId })
    disp.prioridad_monitor = activa
    if (activa) conPrioridad++
  }
  return { enApi, conPrioridad }
}

async function sincronizarMonitorExterno() {
  const config = await db.obtenerConfigApi()
  const url = process.env.MONITOR_EXTERNO_URL || config?.monitor_externo_url || URL_DEFAULT
  const procesarWa = config?.monitor_externo_activo !== false

  let fetchResult
  try {
    fetchResult = await fetchMonitor(url)
  } catch (err) {
    const consulta = await registrarConsultaApi({
      url,
      ok: false,
      httpStatus: err.httpStatus ?? null,
      errorMensaje: err.message,
      duracionMs: err.duracionMs ?? null,
      procesadoWa: false,
      meta: { motivo: 'error_conexion' }
    })
    logger.error(`Monitor externo: ${err.message}`)
    return {
      ok: false,
      error: err.message,
      consulta_id: consulta?.id,
      procesado_wa: false
    }
  }

  const { data, httpStatus, duracionMs } = fetchResult
  const equiposResumen = (data.equiposProgramados || []).map(resumirEquipo)
  const alertasResumen = (data.ultimasAlertasEnviadas || []).map(resumirAlertaEnvio)
  const payload = payloadParaHistorial(data)

  await backfillUmbralesDesdeEnvios()

  // Mapa de todos los IMEIs locales que aparecen en el monitor (no solo alarmas_activas)
  const imeisApi = (data.equiposProgramados || []).map(e => String(e.imei)).filter(Boolean)
  let locales = []
  if (imeisApi.length) {
    const { rows } = await pool.query(
      'SELECT * FROM dispositivos WHERE imei = ANY($1::text[])',
      [imeisApi]
    )
    locales = rows
  }
  // Para WA solo alarmas activas
  const conAlarma = await db.listarDispositivosMonitoreo()
  const mapLocal = new Map([
    ...locales.map(d => [String(d.imei), d]),
    ...conAlarma.map(d => [String(d.imei), d])
  ])

  const equipos = data.equiposProgramados || []
  const meta = await sincronizarMetadata(equipos, mapLocal)
  logger.info(
    `🛰️ Monitor ztrack: ${equipos.length} en correo, ${meta.enApi} locales, ${meta.conPrioridad} con prioridad WA` +
      (procesarWa ? '' : ' (WA desactivado)')
  )

  let fromEnvios = []
  let bootstrap = false
  if (procesarWa) {
    bootstrap = await esPrimerCiclo()
    if (bootstrap) {
      logger.info('🛰️ Monitor ztrack: bootstrap — marcando envíos/umbrales existentes sin WA')
    }
    // Solo notificar a dispositivos con alarmas + prioridad
    const mapWa = new Map(
      [...mapLocal.entries()].filter(([, d]) => d.alarmas_activas && d.prioridad_monitor)
    )
    fromEnvios = await procesarUltimasAlertas(data.ultimasAlertasEnviadas || [], mapWa, {
      bootstrap
    })
  }

  const waEncolados = fromEnvios.reduce((a, x) => a + (x.encolados || 0), 0)
  const consulta = await registrarConsultaApi({
    url,
    ok: true,
    httpStatus,
    duracionMs,
    generatedAt: data.generatedAt || null,
    cicloId: data.aplicacion?.ultimoCiclo?.id || null,
    resumen: data.resumen || null,
    equiposResumen,
    alertasResumen,
    payload,
    waEncolados,
    prioridadCount: meta.conPrioridad,
    enApiLocal: meta.enApi,
    procesadoWa: procesarWa,
    meta: {
      bootstrap,
      envios_nuevos: fromEnvios.length,
      wa_desactivado: !procesarWa
    }
  })

  return {
    ok: true,
    generatedAt: data.generatedAt,
    ciclo: data.aplicacion?.ultimoCiclo?.id,
    programados: equipos.length,
    en_api_local: meta.enApi,
    prioridad: meta.conPrioridad,
    bootstrap,
    envios_wa: fromEnvios,
    resumen: data.resumen,
    consulta_id: consulta?.id,
    procesado_wa: procesarWa,
    equipos: equiposResumen,
    alertas: alertasResumen
  }
}

let timer = null

async function ejecutarCiclo() {
  try {
    const r = await sincronizarMonitorExterno()
    if (r.ok === false) return
    const n = r.envios_wa?.reduce((a, x) => a + (x.encolados || 0), 0) || 0
    if (n) logger.info(`🛰️ Monitor ztrack: ${n} mensaje(s) WA encolados`)
  } catch (err) {
    logger.error(`Monitor externo: ${err.message}`)
  }
}

async function iniciarMonitorExterno() {
  if (timer) return
  const config = await db.obtenerConfigApi()
  const mins = Math.max(
    1,
    parseInt(process.env.MONITOR_EXTERNO_MINUTOS || config?.monitor_externo_minutos || 5, 10)
  )
  await ejecutarCiclo()
  timer = setInterval(ejecutarCiclo, mins * 60 * 1000)
  logger.info(`🛰️ Monitor externo ztrack iniciado (cada ${mins} min)`)
}

module.exports = {
  sincronizarMonitorExterno,
  iniciarMonitorExterno,
  fetchMonitor,
  listarConsultasMonitor,
  obtenerConsultaMonitor,
  obtenerUltimaConsultaMonitor,
  obtenerEstadoMonitorUi,
  listarHistorialZtrack,
  resumirEquipo
}
