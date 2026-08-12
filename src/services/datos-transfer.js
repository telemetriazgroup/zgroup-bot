/**
 * Exportar / importar datos del sistema (usuarios, dispositivos, asignaciones,
 * alertas, historial WA, monitor API, configuración).
 * Usa claves naturales (telefono, imei, nombre de grupo) — no depende de SERIAL ids.
 */
const { pool } = require('../db')
const { logger } = require('../logger')

const EXPORT_VERSION = 1

const DEFAULT_OPTS = {
  usuarios: true,
  dispositivos: true,
  grupos: true,
  asignaciones: true,
  alertas: true,
  historial_wa: true,
  monitor_api: true,
  config: true,
  // límites para tablas grandes
  alertas_limit: 5000,
  mensajes_limit: 10000,
  eventos_limit: 5000,
  consultas_limit: 200,
  incluir_payload_consultas: false
}

function mergeOpts(opts = {}) {
  return { ...DEFAULT_OPTS, ...opts }
}

async function q(sql, params = []) {
  const { rows } = await pool.query(sql, params)
  return rows
}

async function exportarDatos(optsIn = {}) {
  const opts = mergeOpts(optsIn)
  const sections = {}
  const counts = {}

  if (opts.config) {
    const [config_api] = await q('SELECT * FROM config_api WHERE id = 1')
    const config_alertas = await q('SELECT tipo, activo, descripcion, nivel FROM config_alertas ORDER BY tipo')
    const config_links = await q(
      'SELECT link_id, nombre, tipo_default, url_reporte, url_live, url_historico, activo FROM config_links ORDER BY link_id'
    )
    // No exportar secretos: config_api no los tiene
    sections.config = { config_api: config_api || null, config_alertas, config_links }
    counts.config = {
      config_api: config_api ? 1 : 0,
      config_alertas: config_alertas.length,
      config_links: config_links.length
    }
  }

  if (opts.dispositivos) {
    const dispositivos = await q(`
      SELECT imei, nombre, tipo, link_origen, estado_conexion, ultimo_dato, last_ip,
             set_control, delta, sensor_control, alerta_setpoint, alarmas_activas,
             prioridad_monitor, monitor_row_key, monitor_grupo, fuera_desde
      FROM dispositivos ORDER BY imei
    `)
    const equipos = await q(`
      SELECT id_equipo, nombre, imei, temperatura, humedad, ubicacion, alarmas_activas
      FROM equipos ORDER BY id_equipo
    `)
    const proceso_ca = await q(`
      SELECT d.imei, p.receta, p.tipo_fruta, p.variacion, p.procedencia,
             p.fecha_inicio, p.fecha_fin, p.maquina_serie
      FROM proceso_ca p
      JOIN dispositivos d ON d.id = p.dispositivo_id
      ORDER BY d.imei
    `)
    sections.dispositivos = { dispositivos, equipos, proceso_ca }
    counts.dispositivos = {
      dispositivos: dispositivos.length,
      equipos: equipos.length,
      proceso_ca: proceso_ca.length
    }
  }

  if (opts.grupos) {
    const grupos = await q(`
      SELECT g.id, g.nombre, g.descripcion, g.activo,
             COALESCE(
               (SELECT array_agg(d.imei ORDER BY d.imei)
                FROM grupo_dispositivos gd
                JOIN dispositivos d ON d.id = gd.dispositivo_id
                WHERE gd.grupo_id = g.id),
               '{}'::text[]
             ) AS dispositivo_imeis
      FROM grupos_alertas g
      ORDER BY g.nombre
    `)
    sections.grupos = {
      grupos_alertas: grupos.map(g => ({
        nombre: g.nombre,
        descripcion: g.descripcion,
        activo: g.activo,
        dispositivo_imeis: g.dispositivo_imeis || []
      }))
    }
    counts.grupos = { grupos_alertas: grupos.length }
  }

  if (opts.usuarios || opts.asignaciones) {
    const usuarios = await q(`
      SELECT id, nombre, telefono, activo, creado_en,
             alertas_habilitadas, prueba_respuestas, prueba_iniciada_en, prueba_completada_en
      FROM usuarios ORDER BY telefono
    `)

    const outUsers = []
    for (const u of usuarios) {
      const row = {
        nombre: u.nombre,
        telefono: u.telefono,
        activo: u.activo,
        creado_en: u.creado_en,
        alertas_habilitadas: u.alertas_habilitadas,
        prueba_respuestas: u.prueba_respuestas,
        prueba_iniciada_en: u.prueba_iniciada_en,
        prueba_completada_en: u.prueba_completada_en
      }
      if (opts.asignaciones) {
        const grupos = await q(
          `SELECT g.nombre FROM usuario_grupos ug
           JOIN grupos_alertas g ON g.id = ug.grupo_id
           WHERE ug.usuario_id = $1 ORDER BY g.nombre`,
          [u.id]
        )
        const disps = await q(
          `SELECT d.imei FROM usuario_dispositivos ud
           JOIN dispositivos d ON d.id = ud.dispositivo_id
           WHERE ud.usuario_id = $1 ORDER BY d.imei`,
          [u.id]
        )
        const eqs = await q(
          `SELECT e.id_equipo FROM usuario_equipos ue
           JOIN equipos e ON e.id = ue.equipo_id
           WHERE ue.usuario_id = $1 ORDER BY e.id_equipo`,
          [u.id]
        )
        row.grupo_nombres = grupos.map(x => x.nombre)
        row.dispositivo_imeis = disps.map(x => x.imei)
        row.equipo_ids = eqs.map(x => x.id_equipo)
      }
      outUsers.push(row)
    }
    sections.usuarios = { usuarios: outUsers }
    counts.usuarios = { usuarios: outUsers.length }
  }

  if (opts.alertas) {
    const lim = Math.min(50000, Math.max(1, parseInt(opts.alertas_limit, 10) || 5000))
    const alertas = await q(
      `SELECT equipo_id, tipo, temperatura, humedad, ubicacion, nivel, resuelta, fecha, codigo
       FROM alertas ORDER BY fecha DESC LIMIT $1`,
      [lim]
    )
    const seguimiento = await q(`
      SELECT u.telefono, s.imei, s.codigo, s.iniciado_en, s.ultima_notificacion_en,
             s.ultimo_umbral_horas, s.estado, s.ack_en, s.dia_lima, s.meta
      FROM alerta_seguimiento s
      JOIN usuarios u ON u.id = s.usuario_id
      ORDER BY s.iniciado_en DESC
      LIMIT 5000
    `)
    sections.alertas = { alertas, alerta_seguimiento: seguimiento }
    counts.alertas = { alertas: alertas.length, alerta_seguimiento: seguimiento.length }
  }

  if (opts.historial_wa) {
    const limMsg = Math.min(100000, Math.max(1, parseInt(opts.mensajes_limit, 10) || 10000))
    const limEv = Math.min(50000, Math.max(1, parseInt(opts.eventos_limit, 10) || 5000))
    const mensajes = await q(
      `SELECT u.telefono, m.telefono AS telefono_chat, m.direccion, m.tipo,
              m.cuerpo, m.caption, m.intencion, m.imei_contexto, m.jid, m.meta, m.creado_en
       FROM whatsapp_mensajes m
       LEFT JOIN usuarios u ON u.id = m.usuario_id
       ORDER BY m.creado_en DESC LIMIT $1`,
      [limMsg]
    )
    const eventos = await q(
      `SELECT u.telefono, e.tipo, e.detalle, e.meta, e.creado_en
       FROM conversacion_eventos e
       LEFT JOIN usuarios u ON u.id = e.usuario_id
       ORDER BY e.creado_en DESC LIMIT $1`,
      [limEv]
    )
    sections.historial_wa = { whatsapp_mensajes: mensajes, conversacion_eventos: eventos }
    counts.historial_wa = {
      whatsapp_mensajes: mensajes.length,
      conversacion_eventos: eventos.length
    }
  }

  if (opts.monitor_api) {
    const limC = Math.min(1000, Math.max(1, parseInt(opts.consultas_limit, 10) || 200))
    const envios = await q(
      `SELECT envio_id, imei, alert_kind, umbral_horas, procesado_en, meta
       FROM monitor_envios_procesados ORDER BY procesado_en DESC LIMIT 5000`
    )
    const umbrales = await q(
      `SELECT imei, alert_kind, umbral_key, dia_lima, envio_id, notificado_en
       FROM monitor_umbrales_notificados ORDER BY notificado_en DESC LIMIT 5000`
    )
    const consultasSql = opts.incluir_payload_consultas
      ? `SELECT consultado_en, url, ok, http_status, error_mensaje, duracion_ms,
                generated_at, ciclo_id, resumen, equipos_resumen, alertas_resumen,
                payload, wa_encolados, prioridad_count, en_api_local, procesado_wa, meta
         FROM monitor_api_consultas ORDER BY consultado_en DESC LIMIT $1`
      : `SELECT consultado_en, url, ok, http_status, error_mensaje, duracion_ms,
                generated_at, ciclo_id, resumen, equipos_resumen, alertas_resumen,
                NULL::jsonb AS payload, wa_encolados, prioridad_count, en_api_local, procesado_wa, meta
         FROM monitor_api_consultas ORDER BY consultado_en DESC LIMIT $1`
    const consultas = await q(consultasSql, [limC])
    sections.monitor_api = {
      monitor_envios_procesados: envios,
      monitor_umbrales_notificados: umbrales,
      monitor_api_consultas: consultas
    }
    counts.monitor_api = {
      monitor_envios_procesados: envios.length,
      monitor_umbrales_notificados: umbrales.length,
      monitor_api_consultas: consultas.length
    }
  }

  return {
    version: EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    options: opts,
    counts,
    sections
  }
}

async function ensureDispositivoImei(client, imei, patch = {}) {
  const { rows } = await client.query(
    `INSERT INTO dispositivos (imei, nombre, link_origen, alarmas_activas, set_control, delta, sensor_control, alerta_setpoint, prioridad_monitor)
     VALUES ($1, $2, $3, COALESCE($4, false), $5, $6, COALESCE($7, 'return_air'), COALESCE($8, true), COALESCE($9, false))
     ON CONFLICT (imei) DO UPDATE SET
       nombre = COALESCE(EXCLUDED.nombre, dispositivos.nombre),
       link_origen = COALESCE(EXCLUDED.link_origen, dispositivos.link_origen),
       alarmas_activas = COALESCE($4, dispositivos.alarmas_activas),
       set_control = COALESCE($5, dispositivos.set_control),
       delta = COALESCE($6, dispositivos.delta),
       sensor_control = COALESCE($7, dispositivos.sensor_control),
       alerta_setpoint = COALESCE($8, dispositivos.alerta_setpoint),
       prioridad_monitor = COALESCE($9, dispositivos.prioridad_monitor),
       monitor_row_key = COALESCE($10, dispositivos.monitor_row_key),
       monitor_grupo = COALESCE($11, dispositivos.monitor_grupo)
     RETURNING id`,
    [
      imei,
      patch.nombre || imei,
      patch.link_origen || 'link1',
      patch.alarmas_activas,
      patch.set_control ?? null,
      patch.delta ?? null,
      patch.sensor_control || 'return_air',
      patch.alerta_setpoint,
      patch.prioridad_monitor,
      patch.monitor_row_key || null,
      patch.monitor_grupo || null
    ]
  )
  return rows[0].id
}

async function ensureUsuarioTelefono(client, u) {
  const { rows } = await client.query(
    `INSERT INTO usuarios (nombre, telefono, activo, alertas_habilitadas, prueba_respuestas, prueba_iniciada_en, prueba_completada_en)
     VALUES ($1, $2, COALESCE($3, true), COALESCE($4, false), COALESCE($5, 0), $6, $7)
     ON CONFLICT (telefono) DO UPDATE SET
       nombre = COALESCE(EXCLUDED.nombre, usuarios.nombre),
       activo = COALESCE(EXCLUDED.activo, usuarios.activo),
       alertas_habilitadas = COALESCE(EXCLUDED.alertas_habilitadas, usuarios.alertas_habilitadas),
       prueba_respuestas = COALESCE(EXCLUDED.prueba_respuestas, usuarios.prueba_respuestas),
       prueba_iniciada_en = COALESCE(EXCLUDED.prueba_iniciada_en, usuarios.prueba_iniciada_en),
       prueba_completada_en = COALESCE(EXCLUDED.prueba_completada_en, usuarios.prueba_completada_en)
     RETURNING id`,
    [
      u.nombre || u.telefono,
      String(u.telefono).replace(/\D/g, ''),
      u.activo,
      u.alertas_habilitadas,
      u.prueba_respuestas,
      u.prueba_iniciada_en || null,
      u.prueba_completada_en || null
    ]
  )
  return rows[0].id
}

async function ensureGrupoNombre(client, g) {
  const { rows } = await client.query(
    `INSERT INTO grupos_alertas (nombre, descripcion, activo)
     VALUES ($1, $2, COALESCE($3, true))
     ON CONFLICT (nombre) DO UPDATE SET
       descripcion = COALESCE(EXCLUDED.descripcion, grupos_alertas.descripcion),
       activo = COALESCE(EXCLUDED.activo, grupos_alertas.activo)
     RETURNING id`,
    [g.nombre, g.descripcion || null, g.activo]
  )
  return rows[0].id
}

async function ensureEquipo(client, e) {
  const { rows } = await client.query(
    `INSERT INTO equipos (id_equipo, nombre, imei, temperatura, humedad, ubicacion, alarmas_activas)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, true))
     ON CONFLICT (id_equipo) DO UPDATE SET
       nombre = COALESCE(EXCLUDED.nombre, equipos.nombre),
       imei = COALESCE(EXCLUDED.imei, equipos.imei),
       alarmas_activas = COALESCE(EXCLUDED.alarmas_activas, equipos.alarmas_activas)
     RETURNING id`,
    [
      e.id_equipo,
      e.nombre || e.id_equipo,
      e.imei || null,
      e.temperatura ?? null,
      e.humedad ?? null,
      e.ubicacion || null,
      e.alarmas_activas
    ]
  )
  return rows[0].id
}

/**
 * Importa un dump JSON. mode: 'merge' (default) upsert por claves naturales.
 * replace_asignaciones: si true, reemplaza vínculos del usuario por los del archivo.
 */
async function importarDatos(payload, optsIn = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Archivo inválido: se esperaba un JSON de exportación ZGroup')
  }
  if (payload.version && Number(payload.version) > EXPORT_VERSION) {
    throw new Error(`Versión de export ${payload.version} no soportada (máx ${EXPORT_VERSION})`)
  }

  const sections = payload.sections || payload
  const opts = {
    usuarios: optsIn.usuarios !== false,
    dispositivos: optsIn.dispositivos !== false,
    grupos: optsIn.grupos !== false,
    asignaciones: optsIn.asignaciones !== false,
    alertas: optsIn.alertas !== false,
    historial_wa: optsIn.historial_wa !== false,
    monitor_api: optsIn.monitor_api !== false,
    config: optsIn.config !== false,
    replace_asignaciones: optsIn.replace_asignaciones === true
  }

  const result = {
    imported: {},
    skipped: {},
    errors: []
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // ── Config ──
    if (opts.config && sections.config) {
      const ca = sections.config.config_api
      if (ca) {
        await client.query(
          `UPDATE config_api SET
             url = COALESCE($1, url),
             online_hasta_horas = COALESCE($2, online_hasta_horas),
             wait_hasta_horas = COALESCE($3, wait_hasta_horas),
             alerta_online = COALESCE($4, alerta_online),
             alerta_wait = COALESCE($5, alerta_wait),
             alerta_offline = COALESCE($6, alerta_offline),
             intervalo_minutos = COALESCE($7, intervalo_minutos),
             url_live = COALESCE($8, url_live),
             fuera_rango_minutos_min = COALESCE($9, fuera_rango_minutos_min),
             reaviso_paso_horas = COALESCE($10, reaviso_paso_horas),
             reaviso_max_horas_dia = COALESCE($11, reaviso_max_horas_dia),
             alerta_en_rango = COALESCE($12, alerta_en_rango),
             historico_fecha_ya_lima = COALESCE($13, historico_fecha_ya_lima),
             monitor_externo_url = COALESCE($14, monitor_externo_url),
             monitor_externo_minutos = COALESCE($15, monitor_externo_minutos),
             monitor_externo_activo = COALESCE($16, monitor_externo_activo),
             actualizado_en = NOW()
           WHERE id = 1`,
          [
            ca.url, ca.online_hasta_horas, ca.wait_hasta_horas,
            ca.alerta_online, ca.alerta_wait, ca.alerta_offline, ca.intervalo_minutos,
            ca.url_live, ca.fuera_rango_minutos_min, ca.reaviso_paso_horas,
            ca.reaviso_max_horas_dia, ca.alerta_en_rango, ca.historico_fecha_ya_lima,
            ca.monitor_externo_url, ca.monitor_externo_minutos, ca.monitor_externo_activo
          ]
        )
        result.imported.config_api = 1
      }
      let nAlert = 0
      for (const t of sections.config.config_alertas || []) {
        await client.query(
          `INSERT INTO config_alertas (tipo, activo, descripcion, nivel)
           VALUES ($1, COALESCE($2, true), $3, COALESCE($4, 'normal'))
           ON CONFLICT (tipo) DO UPDATE SET
             activo = EXCLUDED.activo,
             descripcion = COALESCE(EXCLUDED.descripcion, config_alertas.descripcion),
             nivel = COALESCE(EXCLUDED.nivel, config_alertas.nivel)`,
          [t.tipo, t.activo, t.descripcion || null, t.nivel]
        )
        nAlert++
      }
      let nLinks = 0
      for (const l of sections.config.config_links || []) {
        await client.query(
          `INSERT INTO config_links (link_id, nombre, tipo_default, url_reporte, url_live, url_historico, activo)
           VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, true))
           ON CONFLICT (link_id) DO UPDATE SET
             nombre = COALESCE(EXCLUDED.nombre, config_links.nombre),
             url_reporte = COALESCE(EXCLUDED.url_reporte, config_links.url_reporte),
             url_live = COALESCE(EXCLUDED.url_live, config_links.url_live),
             url_historico = COALESCE(EXCLUDED.url_historico, config_links.url_historico),
             activo = COALESCE(EXCLUDED.activo, config_links.activo)`,
          [l.link_id, l.nombre || l.link_id, l.tipo_default || null, l.url_reporte || null, l.url_live || null, l.url_historico || null, l.activo]
        )
        nLinks++
      }
      result.imported.config_alertas = nAlert
      result.imported.config_links = nLinks
    }

    // ── Dispositivos / equipos ──
    const imeiToId = new Map()
    if (opts.dispositivos && sections.dispositivos) {
      let n = 0
      for (const d of sections.dispositivos.dispositivos || []) {
        if (!d.imei) continue
        const id = await ensureDispositivoImei(client, String(d.imei), d)
        imeiToId.set(String(d.imei), id)
        // actualizar telemetría opcional si viene
        if (d.estado_conexion || d.ultimo_dato || d.last_ip) {
          await client.query(
            `UPDATE dispositivos SET
               estado_conexion = COALESCE($2, estado_conexion),
               ultimo_dato = COALESCE($3, ultimo_dato),
               last_ip = COALESCE($4, last_ip),
               tipo = COALESCE($5, tipo),
               fuera_desde = COALESCE($6, fuera_desde)
             WHERE id = $1`,
            [id, d.estado_conexion || null, d.ultimo_dato || null, d.last_ip || null, d.tipo || null, d.fuera_desde || null]
          )
        }
        n++
      }
      let nEq = 0
      for (const e of sections.dispositivos.equipos || []) {
        if (!e.id_equipo) continue
        await ensureEquipo(client, e)
        nEq++
      }
      let nCa = 0
      for (const p of sections.dispositivos.proceso_ca || []) {
        if (!p.imei) continue
        let did = imeiToId.get(String(p.imei))
        if (!did) {
          const { rows } = await client.query('SELECT id FROM dispositivos WHERE imei = $1', [String(p.imei)])
          did = rows[0]?.id
        }
        if (!did) continue
        await client.query(
          `INSERT INTO proceso_ca (dispositivo_id, receta, tipo_fruta, variacion, procedencia, fecha_inicio, fecha_fin, maquina_serie)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (dispositivo_id) DO UPDATE SET
             receta = EXCLUDED.receta,
             tipo_fruta = EXCLUDED.tipo_fruta,
             variacion = EXCLUDED.variacion,
             procedencia = EXCLUDED.procedencia,
             fecha_inicio = EXCLUDED.fecha_inicio,
             fecha_fin = EXCLUDED.fecha_fin,
             maquina_serie = EXCLUDED.maquina_serie,
             actualizado_en = NOW()`,
          [did, p.receta || null, p.tipo_fruta || null, p.variacion || null, p.procedencia || null, p.fecha_inicio || null, p.fecha_fin || null, p.maquina_serie || null]
        )
        nCa++
      }
      result.imported.dispositivos = n
      result.imported.equipos = nEq
      result.imported.proceso_ca = nCa
    }

    // ── Grupos ──
    const grupoToId = new Map()
    if (opts.grupos && sections.grupos) {
      let n = 0
      for (const g of sections.grupos.grupos_alertas || []) {
        if (!g.nombre) continue
        const gid = await ensureGrupoNombre(client, g)
        grupoToId.set(g.nombre, gid)
        for (const imei of g.dispositivo_imeis || []) {
          let did = imeiToId.get(String(imei))
          if (!did) {
            const { rows } = await client.query('SELECT id FROM dispositivos WHERE imei = $1', [String(imei)])
            did = rows[0]?.id
            if (!did) {
              did = await ensureDispositivoImei(client, String(imei), { nombre: String(imei) })
            }
            imeiToId.set(String(imei), did)
          }
          await client.query(
            `INSERT INTO grupo_dispositivos (grupo_id, dispositivo_id) VALUES ($1,$2)
             ON CONFLICT DO NOTHING`,
            [gid, did]
          )
        }
        n++
      }
      result.imported.grupos_alertas = n
    }

    // ── Usuarios + asignaciones ──
    if (opts.usuarios && sections.usuarios) {
      let n = 0
      let nAsig = 0
      for (const u of sections.usuarios.usuarios || []) {
        if (!u.telefono) continue
        const uid = await ensureUsuarioTelefono(client, u)
        n++

        if (opts.asignaciones) {
          if (opts.replace_asignaciones) {
            await client.query('DELETE FROM usuario_grupos WHERE usuario_id = $1', [uid])
            await client.query('DELETE FROM usuario_dispositivos WHERE usuario_id = $1', [uid])
            await client.query('DELETE FROM usuario_equipos WHERE usuario_id = $1', [uid])
          }
          for (const nombre of u.grupo_nombres || []) {
            let gid = grupoToId.get(nombre)
            if (!gid) {
              const { rows } = await client.query('SELECT id FROM grupos_alertas WHERE nombre = $1', [nombre])
              gid = rows[0]?.id
              if (!gid) gid = await ensureGrupoNombre(client, { nombre, activo: true })
              grupoToId.set(nombre, gid)
            }
            await client.query(
              `INSERT INTO usuario_grupos (usuario_id, grupo_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
              [uid, gid]
            )
            nAsig++
          }
          for (const imei of u.dispositivo_imeis || []) {
            let did = imeiToId.get(String(imei))
            if (!did) {
              const { rows } = await client.query('SELECT id FROM dispositivos WHERE imei = $1', [String(imei)])
              did = rows[0]?.id
              if (!did) did = await ensureDispositivoImei(client, String(imei), { nombre: String(imei) })
              imeiToId.set(String(imei), did)
            }
            await client.query(
              `INSERT INTO usuario_dispositivos (usuario_id, dispositivo_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
              [uid, did]
            )
            nAsig++
          }
          for (const idEq of u.equipo_ids || []) {
            const eid = await ensureEquipo(client, { id_equipo: idEq, nombre: idEq })
            await client.query(
              `INSERT INTO usuario_equipos (usuario_id, equipo_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
              [uid, eid]
            )
            nAsig++
          }
        }
      }
      result.imported.usuarios = n
      result.imported.asignaciones = nAsig
    }

    // ── Alertas ──
    if (opts.alertas && sections.alertas) {
      let n = 0
      for (const a of sections.alertas.alertas || []) {
        if (!a.equipo_id || !a.tipo) continue
        // Evitar duplicar el mismo registro por fecha+equipo+tipo
        const { rows: exists } = await client.query(
          `SELECT 1 FROM alertas
           WHERE equipo_id = $1 AND tipo = $2 AND fecha = $3 LIMIT 1`,
          [a.equipo_id, a.tipo, a.fecha || new Date().toISOString()]
        )
        if (exists.length) {
          result.skipped.alertas = (result.skipped.alertas || 0) + 1
          continue
        }
        await client.query(
          `INSERT INTO alertas (equipo_id, tipo, temperatura, humedad, ubicacion, nivel, resuelta, fecha, codigo)
           VALUES ($1,$2,$3,$4,$5,COALESCE($6,'normal'),COALESCE($7,false),COALESCE($8,NOW()),$9)`,
          [
            a.equipo_id, a.tipo, a.temperatura ?? null, a.humedad ?? null,
            a.ubicacion || null, a.nivel, a.resuelta, a.fecha || null, a.codigo || null
          ]
        )
        n++
      }
      let nSeg = 0
      for (const s of sections.alertas.alerta_seguimiento || []) {
        if (!s.telefono || !s.imei || !s.codigo) continue
        const { rows: ur } = await client.query('SELECT id FROM usuarios WHERE telefono = $1', [String(s.telefono).replace(/\D/g, '')])
        const uid = ur[0]?.id
        if (!uid) {
          result.skipped.alerta_seguimiento = (result.skipped.alerta_seguimiento || 0) + 1
          continue
        }
        await client.query(
          `INSERT INTO alerta_seguimiento
             (usuario_id, imei, codigo, iniciado_en, ultima_notificacion_en, ultimo_umbral_horas, estado, ack_en, dia_lima, meta)
           VALUES ($1,$2,$3,COALESCE($4,NOW()),$5,$6,COALESCE($7,'activo'),$8,$9,$10::jsonb)`,
          [
            uid, s.imei, s.codigo, s.iniciado_en || null, s.ultima_notificacion_en || null,
            s.ultimo_umbral_horas ?? null, s.estado, s.ack_en || null, s.dia_lima || null,
            JSON.stringify(s.meta || null)
          ]
        )
        nSeg++
      }
      result.imported.alertas = n
      result.imported.alerta_seguimiento = nSeg
    }

    // ── Historial WA ──
    if (opts.historial_wa && sections.historial_wa) {
      let nMsg = 0
      for (const m of sections.historial_wa.whatsapp_mensajes || []) {
        let uid = null
        if (m.telefono) {
          const { rows } = await client.query(
            'SELECT id FROM usuarios WHERE telefono = $1',
            [String(m.telefono).replace(/\D/g, '')]
          )
          uid = rows[0]?.id || null
        }
        await client.query(
          `INSERT INTO whatsapp_mensajes
             (usuario_id, telefono, jid, direccion, tipo, cuerpo, caption, intencion, imei_contexto, meta, creado_en)
           VALUES ($1,$2,$3,$4,COALESCE($5,'text'),$6,$7,$8,$9,$10::jsonb,COALESCE($11,NOW()))`,
          [
            uid,
            m.telefono_chat || m.telefono || null,
            m.jid || null,
            m.direccion || 'out',
            m.tipo || 'text',
            m.cuerpo || m.texto || '',
            m.caption || null,
            m.intencion || null,
            m.imei_contexto || null,
            JSON.stringify(m.meta || null),
            m.creado_en || null
          ]
        )
        nMsg++
      }
      let nEv = 0
      for (const e of sections.historial_wa.conversacion_eventos || []) {
        let uid = null
        if (e.telefono) {
          const { rows } = await client.query(
            'SELECT id FROM usuarios WHERE telefono = $1',
            [String(e.telefono).replace(/\D/g, '')]
          )
          uid = rows[0]?.id || null
        }
        await client.query(
          `INSERT INTO conversacion_eventos (usuario_id, tipo, detalle, meta, creado_en)
           VALUES ($1,$2,$3,$4::jsonb,COALESCE($5,NOW()))`,
          [uid, e.tipo || 'import', e.detalle || null, JSON.stringify(e.meta || null), e.creado_en || null]
        )
        nEv++
      }
      result.imported.whatsapp_mensajes = nMsg
      result.imported.conversacion_eventos = nEv
    }

    // ── Monitor API ──
    if (opts.monitor_api && sections.monitor_api) {
      let nEnv = 0
      for (const e of sections.monitor_api.monitor_envios_procesados || []) {
        if (!e.envio_id) continue
        await client.query(
          `INSERT INTO monitor_envios_procesados (envio_id, imei, alert_kind, umbral_horas, procesado_en, meta)
           VALUES ($1,$2,$3,$4,COALESCE($5,NOW()),$6::jsonb)
           ON CONFLICT (envio_id) DO NOTHING`,
          [e.envio_id, e.imei || null, e.alert_kind || null, e.umbral_horas ?? null, e.procesado_en || null, JSON.stringify(e.meta || null)]
        )
        nEnv++
      }
      let nUmb = 0
      for (const u of sections.monitor_api.monitor_umbrales_notificados || []) {
        if (!u.imei || !u.alert_kind || u.umbral_key == null || !u.dia_lima) continue
        await client.query(
          `INSERT INTO monitor_umbrales_notificados (imei, alert_kind, umbral_key, dia_lima, envio_id, notificado_en)
           VALUES ($1,$2,$3,$4::date,$5,COALESCE($6,NOW()))
           ON CONFLICT (imei, alert_kind, umbral_key, dia_lima) DO NOTHING`,
          [u.imei, u.alert_kind, u.umbral_key, u.dia_lima, u.envio_id || null, u.notificado_en || null]
        )
        nUmb++
      }
      let nCon = 0
      for (const c of sections.monitor_api.monitor_api_consultas || []) {
        await client.query(
          `INSERT INTO monitor_api_consultas (
             consultado_en, url, ok, http_status, error_mensaje, duracion_ms,
             generated_at, ciclo_id, resumen, equipos_resumen, alertas_resumen,
             payload, wa_encolados, prioridad_count, en_api_local, procesado_wa, meta
           ) VALUES (
             COALESCE($1,NOW()),$2,COALESCE($3,false),$4,$5,$6,
             $7,$8,$9::jsonb,$10::jsonb,$11::jsonb,
             $12::jsonb,COALESCE($13,0),$14,$15,COALESCE($16,false),$17::jsonb
           )`,
          [
            c.consultado_en || null,
            c.url || 'import',
            c.ok,
            c.http_status ?? null,
            c.error_mensaje || null,
            c.duracion_ms ?? null,
            c.generated_at || null,
            c.ciclo_id || null,
            JSON.stringify(c.resumen ?? null),
            JSON.stringify(Array.isArray(c.equipos_resumen) ? c.equipos_resumen : []),
            JSON.stringify(Array.isArray(c.alertas_resumen) ? c.alertas_resumen : []),
            JSON.stringify(c.payload ?? null),
            c.wa_encolados ?? 0,
            c.prioridad_count ?? null,
            c.en_api_local ?? null,
            c.procesado_wa,
            JSON.stringify(c.meta ?? null)
          ]
        )
        nCon++
      }
      result.imported.monitor_envios = nEnv
      result.imported.monitor_umbrales = nUmb
      result.imported.monitor_consultas = nCon
    }

    await client.query('COMMIT')
    logger.info(`📦 Import datos OK: ${JSON.stringify(result.imported)}`)
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    logger.error(`Import datos falló: ${err.message}`)
    throw err
  } finally {
    client.release()
  }
}

module.exports = {
  exportarDatos,
  importarDatos,
  EXPORT_VERSION,
  DEFAULT_OPTS
}
