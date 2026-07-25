const fs   = require('fs')
const path = require('path')
const { Pool } = require('pg')
const { logger } = require('./logger')

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
})

pool.on('error', (err) => logger.error('Error en pool PostgreSQL:', err))

async function initDb() {
  const sql = fs.readFileSync(path.join(__dirname, 'db', 'migrations.sql'), 'utf8')
  await pool.query(sql)
}

const db = {

  initDb,

  // ── Usuarios ──────────────────────────────────────────────

  async buscarUsuarioPorTelefono(telefono) {
    const { rows } = await pool.query(
      'SELECT * FROM usuarios WHERE telefono = $1 AND activo = true LIMIT 1',
      [telefono]
    )
    return rows[0] || null
  },

  async listarUsuarios() {
    const { rows } = await pool.query(`
      SELECT u.id, u.nombre, u.telefono, u.activo, u.creado_en,
        COALESCE(json_agg(DISTINCT jsonb_build_object('id', e.id, 'id_equipo', e.id_equipo, 'nombre', e.nombre))
          FILTER (WHERE e.id IS NOT NULL), '[]') AS equipos,
        COALESCE((
          SELECT json_agg(jsonb_build_object('id', g.id, 'nombre', g.nombre))
          FROM usuario_grupos ug JOIN grupos_alertas g ON g.id = ug.grupo_id
          WHERE ug.usuario_id = u.id
        ), '[]') AS grupos,
        COALESCE((
          SELECT json_agg(jsonb_build_object('id', d.id, 'imei', d.imei, 'nombre', d.nombre))
          FROM usuario_dispositivos ud JOIN dispositivos d ON d.id = ud.dispositivo_id
          WHERE ud.usuario_id = u.id
        ), '[]') AS dispositivos
      FROM usuarios u
      LEFT JOIN usuario_equipos ue ON u.id = ue.usuario_id
      LEFT JOIN equipos e ON e.id = ue.equipo_id
      GROUP BY u.id ORDER BY u.nombre
    `)
    return rows
  },

  async crearUsuario({ nombre, telefono, equipo_ids = [], grupo_ids = [], dispositivo_ids = [] }) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        'INSERT INTO usuarios (nombre, telefono) VALUES ($1, $2) RETURNING *',
        [nombre, telefono]
      )
      const usuario = rows[0]
      for (const equipo_id of equipo_ids) {
        await client.query(
          'INSERT INTO usuario_equipos (usuario_id, equipo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [usuario.id, equipo_id]
        )
      }
      for (const grupo_id of grupo_ids) {
        await client.query(
          'INSERT INTO usuario_grupos (usuario_id, grupo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [usuario.id, grupo_id]
        )
      }
      for (const dispositivo_id of dispositivo_ids) {
        await client.query(
          'INSERT INTO usuario_dispositivos (usuario_id, dispositivo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [usuario.id, dispositivo_id]
        )
      }
      await client.query('COMMIT')
      return usuario
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },

  async actualizarUsuario(id, { nombre, telefono, activo, equipo_ids, grupo_ids, dispositivo_ids }) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `UPDATE usuarios SET
           nombre = COALESCE($2, nombre),
           telefono = COALESCE($3, telefono),
           activo = COALESCE($4, activo)
         WHERE id = $1 RETURNING *`,
        [id, nombre, telefono, activo]
      )
      if (!rows[0]) throw new Error('Usuario no encontrado')
      if (equipo_ids !== undefined) {
        await client.query('DELETE FROM usuario_equipos WHERE usuario_id = $1', [id])
        for (const equipo_id of equipo_ids) {
          await client.query(
            'INSERT INTO usuario_equipos (usuario_id, equipo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [id, equipo_id]
          )
        }
      }
      if (grupo_ids !== undefined) {
        await client.query('DELETE FROM usuario_grupos WHERE usuario_id = $1', [id])
        for (const grupo_id of grupo_ids) {
          await client.query(
            'INSERT INTO usuario_grupos (usuario_id, grupo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [id, grupo_id]
          )
        }
      }
      if (dispositivo_ids !== undefined) {
        await client.query('DELETE FROM usuario_dispositivos WHERE usuario_id = $1', [id])
        for (const dispositivo_id of dispositivo_ids) {
          await client.query(
            'INSERT INTO usuario_dispositivos (usuario_id, dispositivo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [id, dispositivo_id]
          )
        }
      }
      await client.query('COMMIT')
      return rows[0]
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },

  async eliminarUsuario(id) {
    await pool.query('DELETE FROM usuarios WHERE id = $1', [id])
  },

  async obtenerUsuarioPorId(id) {
    const { rows } = await pool.query('SELECT * FROM usuarios WHERE id = $1', [id])
    return rows[0] || null
  },

  async obtenerAlertasPendientesPorImei(imei) {
    const { rows } = await pool.query(
      'SELECT id, tipo, nivel, codigo, fecha FROM alertas WHERE equipo_id = $1 AND resuelta = false ORDER BY fecha DESC LIMIT 10',
      [imei]
    )
    return rows
  },

  async obtenerDispositivosOrganizadosUsuario(usuario_id) {
    const { rows: gruposRows } = await pool.query(`
      SELECT g.id, g.nombre, g.descripcion
      FROM grupos_alertas g
      JOIN usuario_grupos ug ON ug.grupo_id = g.id
      WHERE ug.usuario_id = $1 AND g.activo = true
      ORDER BY g.nombre
    `, [usuario_id])

    const grupos = []
    const imeisEnGrupo = new Set()

    for (const g of gruposRows) {
      const { rows: dispositivos } = await pool.query(`
        SELECT d.* FROM dispositivos d
        JOIN grupo_dispositivos gd ON gd.dispositivo_id = d.id
        WHERE gd.grupo_id = $1 ORDER BY d.imei
      `, [g.id])
      dispositivos.forEach(d => imeisEnGrupo.add(d.imei))
      if (dispositivos.length) grupos.push({ ...g, dispositivos })
    }

    const { rows: directos } = await pool.query(`
      SELECT d.* FROM dispositivos d
      JOIN usuario_dispositivos ud ON ud.dispositivo_id = d.id
      WHERE ud.usuario_id = $1 ORDER BY d.imei
    `, [usuario_id])

    const { rows: viaEquipos } = await pool.query(`
      SELECT DISTINCT d.* FROM dispositivos d
      JOIN equipos e ON e.imei = d.imei OR e.id_equipo = d.imei
      JOIN usuario_equipos ue ON ue.equipo_id = e.id
      WHERE ue.usuario_id = $1
    `, [usuario_id])

    const mapInd = new Map()
    for (const d of [...directos, ...viaEquipos]) {
      if (!imeisEnGrupo.has(d.imei)) mapInd.set(d.imei, d)
    }
    const individuales = [...mapInd.values()]

    return { grupos, individuales }
  },

  async obtenerPreviewTestEstado(usuario_ids) {
    const dispositivosMap = new Map()
    const usuarios = []

    for (const uid of usuario_ids) {
      const usuario = await this.obtenerUsuarioPorId(uid)
      if (!usuario) continue
      usuarios.push({ id: usuario.id, nombre: usuario.nombre, telefono: usuario.telefono })
      const { grupos, individuales } = await this.obtenerDispositivosOrganizadosUsuario(uid)

      const registrar = (d, grupoNombre) => {
        const key = d.id
        if (!dispositivosMap.has(key)) {
          dispositivosMap.set(key, {
            id: d.id,
            imei: d.imei,
            nombre: d.nombre,
            link_origen: d.link_origen || 'link1',
            estado_conexion: d.estado_conexion,
            alarmas_activas: d.alarmas_activas,
            en_rango: d.en_rango,
            alertas_pendientes: 0,
            tiene_alerta: false,
            grupos: new Set(),
            usuario_ids: new Set(),
            usuario_nombres: new Set()
          })
        }
        const entry = dispositivosMap.get(key)
        entry.grupos.add(grupoNombre)
        entry.usuario_ids.add(uid)
        entry.usuario_nombres.add(usuario.nombre)
      }

      for (const g of grupos) {
        for (const d of g.dispositivos) registrar(d, g.nombre)
      }
      for (const d of individuales) registrar(d, 'Individual')
    }

    const imeis = [...dispositivosMap.values()].map(d => d.imei)
    const alertasMap = {}
    const fueraDeRangoSet = new Set()
    if (imeis.length) {
      const { rows } = await pool.query(`
        SELECT equipo_id, COUNT(*)::int AS cnt
        FROM alertas WHERE resuelta = false AND equipo_id = ANY($1)
        GROUP BY equipo_id
      `, [imeis])
      rows.forEach(r => { alertasMap[r.equipo_id] = r.cnt })

      const { rows: fueraRows } = await pool.query(`
        SELECT DISTINCT equipo_id FROM alertas
        WHERE resuelta = false AND codigo = 'fuera_de_rango' AND equipo_id = ANY($1)
      `, [imeis])
      fueraRows.forEach(r => fueraDeRangoSet.add(r.equipo_id))
    }

    const dispositivos = [...dispositivosMap.values()].map(v => {
      const pendientes = alertasMap[v.imei] || 0
      const fueraRango = v.en_rango === false || fueraDeRangoSet.has(v.imei)
      const tieneAlarma = pendientes > 0 || v.en_rango === false
      const link1 = (v.link_origen || 'link1') === 'link1'
      return {
        id: v.id,
        imei: v.imei,
        nombre: v.nombre,
        link_origen: v.link_origen,
        estado_conexion: v.estado_conexion,
        alarmas_activas: v.alarmas_activas,
        en_rango: v.en_rango,
        alertas_pendientes: pendientes,
        tiene_alerta: tieneAlarma,
        fuera_rango: fueraRango,
        elegible_analisis_12h: link1 && fueraRango,
        grupos: [...v.grupos],
        usuario_ids: [...v.usuario_ids],
        usuarios: [...v.usuario_nombres]
      }
    }).sort((a, b) => a.imei.localeCompare(b.imei))

    return { usuarios, dispositivos }
  },

  // ── Equipos ───────────────────────────────────────────────

  async listarEquipos() {
    const { rows } = await pool.query(`
      SELECT e.*, d.estado_conexion, d.ultimo_dato AS disp_ultimo_dato
      FROM equipos e
      LEFT JOIN dispositivos d ON d.imei = e.imei
      ORDER BY e.nombre
    `)
    return rows
  },

  async crearEquipo({ id_equipo, nombre, imei, temperatura, humedad, ubicacion, alarmas_activas = true }) {
    const { rows } = await pool.query(`
      INSERT INTO equipos (id_equipo, nombre, imei, temperatura, humedad, ubicacion, alarmas_activas)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
    `, [id_equipo, nombre, imei || null, temperatura, humedad, ubicacion, alarmas_activas])
    return rows[0]
  },

  async actualizarEquipo(id, data) {
    const { rows } = await pool.query(`
      UPDATE equipos SET
        id_equipo = COALESCE($2, id_equipo),
        nombre = COALESCE($3, nombre),
        imei = COALESCE($4, imei),
        temperatura = COALESCE($5, temperatura),
        humedad = COALESCE($6, humedad),
        ubicacion = COALESCE($7, ubicacion),
        alarmas_activas = COALESCE($8, alarmas_activas),
        ultima_actualizacion = NOW()
      WHERE id = $1 RETURNING *
    `, [id, data.id_equipo, data.nombre, data.imei, data.temperatura, data.humedad, data.ubicacion, data.alarmas_activas])
    return rows[0]
  },

  async eliminarEquipo(id) {
    await pool.query('DELETE FROM equipos WHERE id = $1', [id])
  },

  async obtenerEquiposPorUsuario(usuario_id) {
    const { rows } = await pool.query(`
      SELECT e.*, ue.usuario_id
      FROM equipos e
      JOIN usuario_equipos ue ON e.id = ue.equipo_id
      WHERE ue.usuario_id = $1
      ORDER BY e.nombre
    `, [usuario_id])
    return rows
  },

  async obtenerUsuariosDeEquipo(equipo_ref) {
    const { rows } = await pool.query(`
      SELECT DISTINCT u.*
      FROM usuarios u
      WHERE u.activo = true AND (
        u.id IN (
          SELECT ue.usuario_id FROM usuario_equipos ue
          JOIN equipos e ON e.id = ue.equipo_id
          WHERE e.id_equipo = $1 OR e.imei = $1
        )
        OR u.id IN (
          SELECT ud.usuario_id FROM usuario_dispositivos ud
          JOIN dispositivos d ON d.id = ud.dispositivo_id
          WHERE d.imei = $1
        )
        OR u.id IN (
          SELECT ug.usuario_id FROM usuario_grupos ug
          JOIN grupo_dispositivos gd ON gd.grupo_id = ug.grupo_id
          JOIN dispositivos d ON d.id = gd.dispositivo_id
          WHERE d.imei = $1
        )
      )
      ORDER BY u.nombre
    `, [equipo_ref])
    return rows
  },

  // ── Alertas ───────────────────────────────────────────────

  async listarAlertas({ solo_activas = false, limite = 100 } = {}) {
    const { rows } = await pool.query(`
      SELECT * FROM alertas
      ${solo_activas ? 'WHERE resuelta = false' : ''}
      ORDER BY fecha DESC LIMIT $1
    `, [limite])
    return rows
  },

  async obtenerAlertasActivas(usuario_id) {
    const { rows } = await pool.query(`
      SELECT DISTINCT a.*
      FROM alertas a
      WHERE a.resuelta = false AND (
        a.equipo_id IN (
          SELECT e.id_equipo FROM equipos e
          JOIN usuario_equipos ue ON ue.equipo_id = e.id
          WHERE ue.usuario_id = $1
        )
        OR a.equipo_id IN (
          SELECT e.imei FROM equipos e
          JOIN usuario_equipos ue ON ue.equipo_id = e.id
          WHERE ue.usuario_id = $1 AND e.imei IS NOT NULL
        )
        OR a.equipo_id IN (
          SELECT d.imei FROM dispositivos d
          JOIN usuario_dispositivos ud ON ud.dispositivo_id = d.id
          WHERE ud.usuario_id = $1
        )
        OR a.equipo_id IN (
          SELECT d.imei FROM dispositivos d
          JOIN grupo_dispositivos gd ON gd.dispositivo_id = d.id
          JOIN usuario_grupos ug ON ug.grupo_id = gd.grupo_id
          WHERE ug.usuario_id = $1
        )
      )
      ORDER BY a.fecha DESC LIMIT 20
    `, [usuario_id])
    return rows
  },

  async registrarAlerta({ equipo_id, tipo_alerta, temperatura, humedad, ubicacion, nivel, codigo }) {
    const { rows } = await pool.query(`
      INSERT INTO alertas (equipo_id, tipo, temperatura, humedad, ubicacion, nivel, codigo)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [equipo_id, tipo_alerta, temperatura, humedad, ubicacion, nivel || 'normal', codigo || null])
    return rows[0]
  },

  async resolverAlerta(id) {
    const { rows } = await pool.query(
      'UPDATE alertas SET resuelta = true WHERE id = $1 RETURNING *',
      [id]
    )
    return rows[0]
  },

  async listarConfigAlertas() {
    const { rows } = await pool.query('SELECT * FROM config_alertas ORDER BY tipo')
    return rows
  },

  async actualizarConfigAlerta(tipo, { activo, descripcion, nivel }) {
    const { rows } = await pool.query(`
      UPDATE config_alertas SET
        activo = COALESCE($2, activo),
        descripcion = COALESCE($3, descripcion),
        nivel = COALESCE($4, nivel)
      WHERE tipo = $1 RETURNING *
    `, [tipo, activo, descripcion, nivel])
    return rows[0]
  },

  // ── Config API ────────────────────────────────────────────

  async obtenerConfigApi() {
    const { rows } = await pool.query('SELECT * FROM config_api WHERE id = 1')
    return rows[0]
  },

  async actualizarConfigApi(data) {
    const { rows } = await pool.query(`
      UPDATE config_api SET
        url = COALESCE($1, url),
        online_hasta_horas = COALESCE($2, online_hasta_horas),
        wait_hasta_horas = COALESCE($3, wait_hasta_horas),
        alerta_online = COALESCE($4, alerta_online),
        alerta_wait = COALESCE($5, alerta_wait),
        alerta_offline = COALESCE($6, alerta_offline),
        intervalo_minutos = COALESCE($7, intervalo_minutos),
        url_live = COALESCE($8, url_live),
        actualizado_en = NOW()
      WHERE id = 1 RETURNING *
    `, [
      data.url, data.online_hasta_horas, data.wait_hasta_horas,
      data.alerta_online, data.alerta_wait, data.alerta_offline, data.intervalo_minutos,
      data.url_live
    ])
    return rows[0]
  },

  async listarConfigLinks() {
    const { rows } = await pool.query(
      'SELECT * FROM config_links ORDER BY link_id'
    )
    return rows
  },

  async listarConfigLinksActivos() {
    const { rows } = await pool.query(
      'SELECT * FROM config_links WHERE activo = true ORDER BY link_id'
    )
    return rows
  },

  async obtenerConfigLink(link_id) {
    const { rows } = await pool.query(
      'SELECT * FROM config_links WHERE link_id = $1',
      [link_id]
    )
    return rows[0] || null
  },

  async actualizarConfigLink(link_id, data) {
    const { rows } = await pool.query(`
      UPDATE config_links SET
        nombre = COALESCE($2, nombre),
        url_reporte = COALESCE($3, url_reporte),
        url_live = COALESCE($4, url_live),
        url_historico = COALESCE($5, url_historico),
        tipo_default = COALESCE($6, tipo_default),
        activo = COALESCE($7, activo),
        actualizado_en = NOW()
      WHERE link_id = $1 RETURNING *
    `, [link_id, data.nombre, data.url_reporte, data.url_live, data.url_historico, data.tipo_default, data.activo])
    return rows[0]
  },

  // ── Dispositivos ──────────────────────────────────────────

  async listarDispositivos({ estado } = {}) {
    const params = []
    let where = ''
    if (estado) {
      where = 'WHERE d.estado_conexion = $1'
      params.push(estado)
    }
    const { rows } = await pool.query(`
      SELECT d.*,
        (SELECT COUNT(DISTINCT u.id)::int FROM usuarios u WHERE u.activo = true AND (
          u.id IN (SELECT ue.usuario_id FROM usuario_equipos ue JOIN equipos e ON e.id = ue.equipo_id WHERE e.imei = d.imei OR e.id_equipo = d.imei)
          OR u.id IN (SELECT ud.usuario_id FROM usuario_dispositivos ud WHERE ud.dispositivo_id = d.id)
          OR u.id IN (SELECT ug.usuario_id FROM usuario_grupos ug JOIN grupo_dispositivos gd ON gd.grupo_id = ug.grupo_id WHERE gd.dispositivo_id = d.id)
        )) AS total_usuarios
      FROM dispositivos d ${where} ORDER BY d.estado_conexion, d.imei
    `, params)
    return rows
  },

  async upsertDispositivo(d) {
    const link = d.link_origen || 'link1'
    const { rows } = await pool.query(`
      INSERT INTO dispositivos (imei, tipo, estado_conexion, ultimo_dato, last_ip, fecha_registro, link_origen, sincronizado_en)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (imei) DO UPDATE SET
        tipo = EXCLUDED.tipo,
        estado_conexion = EXCLUDED.estado_conexion,
        ultimo_dato = EXCLUDED.ultimo_dato,
        last_ip = EXCLUDED.last_ip,
        fecha_registro = COALESCE(dispositivos.fecha_registro, EXCLUDED.fecha_registro),
        link_origen = EXCLUDED.link_origen,
        sincronizado_en = NOW()
      RETURNING *
    `, [d.imei, d.tipo, d.estado_conexion, d.ultimo_dato, d.last_ip, d.fecha_registro, link])
    await this.asegurarEquipoDesdeDispositivo(rows[0])
    return rows[0]
  },

  async toggleAlarmaDispositivo(id, activa) {
    const { rows } = await pool.query(
      'UPDATE dispositivos SET alarmas_activas = $2 WHERE id = $1 RETURNING *',
      [id, activa]
    )
    if (rows[0]) {
      await pool.query(`
        INSERT INTO equipos (id_equipo, nombre, imei, alarmas_activas)
        VALUES ($1, $2, $1, $3)
        ON CONFLICT (id_equipo) DO UPDATE SET alarmas_activas = $3, imei = $1
      `, [rows[0].imei, rows[0].nombre || rows[0].imei, activa])
    }
    return rows[0]
  },

  async actualizarNombreDispositivo(id, nombre) {
    const { rows } = await pool.query(
      'UPDATE dispositivos SET nombre = $2 WHERE id = $1 RETURNING *',
      [id, nombre]
    )
    if (rows[0]) {
      await pool.query(`
        INSERT INTO equipos (id_equipo, nombre, imei)
        VALUES ($1, $2, $1)
        ON CONFLICT (id_equipo) DO UPDATE SET nombre = $2
      `, [rows[0].imei, nombre || rows[0].imei])
    }
    return rows[0]
  },

  async asegurarEquipoDesdeDispositivo(d) {
    await pool.query(`
      INSERT INTO equipos (id_equipo, nombre, imei, alarmas_activas)
      VALUES ($1, $2, $1, $3)
      ON CONFLICT (id_equipo) DO UPDATE SET
        imei = EXCLUDED.imei,
        nombre = CASE WHEN equipos.nombre = equipos.id_equipo OR equipos.nombre IS NULL
                 THEN EXCLUDED.nombre ELSE equipos.nombre END
    `, [d.imei, d.nombre || d.imei, d.alarmas_activas || false])
  },

  async obtenerDispositivoPorImei(imei) {
    const { rows } = await pool.query('SELECT * FROM dispositivos WHERE imei = $1', [imei])
    return rows[0] || null
  },

  async obtenerDispositivoPorId(id) {
    const { rows } = await pool.query('SELECT * FROM dispositivos WHERE id = $1', [id])
    return rows[0] || null
  },

  async contarDispositivos() {
    const { rows } = await pool.query(`
      SELECT estado_conexion, COUNT(*)::int AS total,
             SUM(CASE WHEN alarmas_activas THEN 1 ELSE 0 END)::int AS con_alarma
      FROM dispositivos GROUP BY estado_conexion
    `)
    return rows
  },

  async listarDispositivosMonitoreo() {
    const { rows } = await pool.query(
      'SELECT * FROM dispositivos WHERE alarmas_activas = true ORDER BY imei'
    )
    return rows
  },

  async actualizarMonitoreoConfig(id, data) {
    const { rows } = await pool.query(`
      UPDATE dispositivos SET
        set_control = $2,
        delta = $3,
        sensor_control = COALESCE($4, sensor_control),
        alerta_setpoint = COALESCE($5, alerta_setpoint),
        alarmas_activas = COALESCE($6, alarmas_activas),
        nombre = COALESCE($7, nombre)
      WHERE id = $1 RETURNING *
    `, [
      id,
      data.set_control ?? null,
      data.delta ?? null,
      data.sensor_control,
      data.alerta_setpoint,
      data.alarmas_activas,
      data.nombre
    ])
    if (rows[0]) await this.asegurarEquipoDesdeDispositivo(rows[0])
    return rows[0]
  },

  async obtenerProcesoCa(dispositivo_id) {
    const { rows } = await pool.query(
      'SELECT * FROM proceso_ca WHERE dispositivo_id = $1',
      [dispositivo_id]
    )
    return rows[0] || null
  },

  async guardarProcesoCa(dispositivo_id, data) {
    const { rows } = await pool.query(`
      INSERT INTO proceso_ca (
        dispositivo_id, receta, tipo_fruta, variacion, procedencia,
        fecha_inicio, fecha_fin, maquina_serie, actualizado_en
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (dispositivo_id) DO UPDATE SET
        receta = EXCLUDED.receta,
        tipo_fruta = EXCLUDED.tipo_fruta,
        variacion = EXCLUDED.variacion,
        procedencia = EXCLUDED.procedencia,
        fecha_inicio = EXCLUDED.fecha_inicio,
        fecha_fin = EXCLUDED.fecha_fin,
        maquina_serie = EXCLUDED.maquina_serie,
        actualizado_en = NOW()
      RETURNING *
    `, [
      dispositivo_id,
      data.receta,
      data.tipo_fruta,
      data.variacion,
      data.procedencia,
      data.fecha_inicio,
      data.fecha_fin,
      data.maquina_serie
    ])
    return rows[0]
  },

  async eliminarProcesoCa(dispositivo_id) {
    await pool.query('DELETE FROM proceso_ca WHERE dispositivo_id = $1', [dispositivo_id])
  },

  async actualizarTelemetria(id, t) {
    const { rows } = await pool.query(`
      UPDATE dispositivos SET
        temp_supply_1 = $2, return_air = $3, evaporation_coil = $4,
        set_point_live = $5, compress_coil_1 = $6, telemetria_actualizada = NOW()
      WHERE id = $1 RETURNING *
    `, [id, t.temp_supply_1, t.return_air, t.evaporation_coil, t.set_point_live, t.compress_coil_1])
    return rows[0]
  },

  async actualizarUltimoSetPoint(id, setPoint) {
    await pool.query('UPDATE dispositivos SET ultimo_set_point = $2 WHERE id = $1', [id, setPoint])
  },

  async actualizarMonitoreoEstado(id, { en_rango }) {
    await pool.query('UPDATE dispositivos SET en_rango = $2 WHERE id = $1', [id, en_rango])
  },

  async tieneAlertaPendiente(equipo_id, codigo) {
    const { rows } = await pool.query(
      'SELECT 1 FROM alertas WHERE equipo_id = $1 AND codigo = $2 AND resuelta = false LIMIT 1',
      [equipo_id, codigo]
    )
    return rows.length > 0
  },

  async resolverAlertasPorCodigo(equipo_id, codigos) {
    await pool.query(
      'UPDATE alertas SET resuelta = true WHERE equipo_id = $1 AND codigo = ANY($2) AND resuelta = false',
      [equipo_id, codigos]
    )
  },

  // ── Grupos de alertas ─────────────────────────────────────

  async listarGrupos() {
    const { rows } = await pool.query(`
      SELECT g.*,
        (SELECT COUNT(*)::int FROM grupo_dispositivos gd WHERE gd.grupo_id = g.id) AS total_dispositivos,
        (SELECT COUNT(*)::int FROM usuario_grupos ug WHERE ug.grupo_id = g.id) AS total_usuarios
      FROM grupos_alertas g ORDER BY g.nombre
    `)
    return rows
  },

  async obtenerGrupo(id) {
    const { rows } = await pool.query('SELECT * FROM grupos_alertas WHERE id = $1', [id])
    if (!rows[0]) return null
    const grupo = rows[0]

    const { rows: dispositivos } = await pool.query(`
      SELECT d.id, d.imei, d.nombre, d.estado_conexion
      FROM dispositivos d
      JOIN grupo_dispositivos gd ON gd.dispositivo_id = d.id
      WHERE gd.grupo_id = $1 ORDER BY d.imei
    `, [id])

    const { rows: usuarios } = await pool.query(`
      SELECT u.id, u.nombre, u.telefono, u.activo
      FROM usuarios u
      JOIN usuario_grupos ug ON ug.usuario_id = u.id
      WHERE ug.grupo_id = $1 ORDER BY u.nombre
    `, [id])

    return { ...grupo, dispositivos, usuarios }
  },

  async crearGrupo({ nombre, descripcion, dispositivo_ids = [] }) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        'INSERT INTO grupos_alertas (nombre, descripcion) VALUES ($1, $2) RETURNING *',
        [nombre, descripcion || null]
      )
      const grupo = rows[0]
      for (const dispositivo_id of dispositivo_ids) {
        await client.query(
          'INSERT INTO grupo_dispositivos (grupo_id, dispositivo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [grupo.id, dispositivo_id]
        )
      }
      await client.query('COMMIT')
      return grupo
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },

  async actualizarGrupo(id, { nombre, descripcion, activo, dispositivo_ids }) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(`
        UPDATE grupos_alertas SET
          nombre = COALESCE($2, nombre),
          descripcion = COALESCE($3, descripcion),
          activo = COALESCE($4, activo)
        WHERE id = $1 RETURNING *
      `, [id, nombre, descripcion, activo])
      if (!rows[0]) throw new Error('Grupo no encontrado')
      if (dispositivo_ids !== undefined) {
        await client.query('DELETE FROM grupo_dispositivos WHERE grupo_id = $1', [id])
        for (const dispositivo_id of dispositivo_ids) {
          await client.query(
            'INSERT INTO grupo_dispositivos (grupo_id, dispositivo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [id, dispositivo_id]
          )
        }
      }
      await client.query('COMMIT')
      return rows[0]
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },

  async eliminarGrupo(id) {
    await pool.query('DELETE FROM grupos_alertas WHERE id = $1', [id])
  },

  async asignacionMasiva({ usuario_ids, grupo_ids = [], dispositivo_ids = [], equipo_ids = [], accion = 'agregar' }) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const uid of usuario_ids) {
        if (accion === 'reemplazar') {
          await client.query('DELETE FROM usuario_grupos WHERE usuario_id = $1', [uid])
          await client.query('DELETE FROM usuario_dispositivos WHERE usuario_id = $1', [uid])
          await client.query('DELETE FROM usuario_equipos WHERE usuario_id = $1', [uid])
        }
        if (accion === 'quitar') {
          if (grupo_ids.length) {
            await client.query('DELETE FROM usuario_grupos WHERE usuario_id = $1 AND grupo_id = ANY($2)', [uid, grupo_ids])
          }
          if (dispositivo_ids.length) {
            await client.query('DELETE FROM usuario_dispositivos WHERE usuario_id = $1 AND dispositivo_id = ANY($2)', [uid, dispositivo_ids])
          }
          if (equipo_ids.length) {
            await client.query('DELETE FROM usuario_equipos WHERE usuario_id = $1 AND equipo_id = ANY($2)', [uid, equipo_ids])
          }
          if (accion === 'quitar') continue
        }
        if (accion === 'agregar' || accion === 'reemplazar') {
          for (const gid of grupo_ids) {
            await client.query(
              'INSERT INTO usuario_grupos (usuario_id, grupo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
              [uid, gid]
            )
          }
          for (const did of dispositivo_ids) {
            await client.query(
              'INSERT INTO usuario_dispositivos (usuario_id, dispositivo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
              [uid, did]
            )
          }
          for (const eid of equipo_ids) {
            await client.query(
              'INSERT INTO usuario_equipos (usuario_id, equipo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
              [uid, eid]
            )
          }
        }
      }
      await client.query('COMMIT')
      return { ok: true, usuarios: usuario_ids.length }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },

  async asignarUsuariosAGrupo(grupo_id, usuario_ids, accion = 'agregar') {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      if (accion === 'reemplazar') {
        await client.query('DELETE FROM usuario_grupos WHERE grupo_id = $1', [grupo_id])
      } else if (accion === 'quitar') {
        await client.query(
          'DELETE FROM usuario_grupos WHERE grupo_id = $1 AND usuario_id = ANY($2)',
          [grupo_id, usuario_ids]
        )
        await client.query('COMMIT')
        return { ok: true }
      }
      for (const uid of usuario_ids) {
        await client.query(
          'INSERT INTO usuario_grupos (usuario_id, grupo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [uid, grupo_id]
        )
      }
      await client.query('COMMIT')
      return { ok: true }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }
}

module.exports = { db, pool }
