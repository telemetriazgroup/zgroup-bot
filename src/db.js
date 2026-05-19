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

const db = {

  async buscarUsuarioPorTelefono(telefono) {
    const { rows } = await pool.query(
      'SELECT * FROM usuarios WHERE telefono = $1 AND activo = true LIMIT 1',
      [telefono]
    )
    return rows[0] || null
  },

  async listarUsuarios() {
    const { rows } = await pool.query(
      'SELECT id, nombre, telefono, activo, creado_en FROM usuarios ORDER BY nombre'
    )
    return rows
  },

  async crearUsuario({ nombre, telefono, equipo_ids = [] }) {
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
      await client.query('COMMIT')
      return usuario
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
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

  async obtenerUsuariosDeEquipo(equipo_id) {
    const { rows } = await pool.query(`
      SELECT u.*
      FROM usuarios u
      JOIN usuario_equipos ue ON u.id = ue.usuario_id
      WHERE ue.equipo_id = $1 AND u.activo = true
    `, [equipo_id])
    return rows
  },

  async obtenerAlertasActivas(usuario_id) {
    const { rows } = await pool.query(`
      SELECT a.*
      FROM alertas a
      JOIN usuario_equipos ue ON a.equipo_id = ue.equipo_id
      WHERE ue.usuario_id = $1 AND a.resuelta = false
      ORDER BY a.fecha DESC
      LIMIT 20
    `, [usuario_id])
    return rows
  },

  async registrarAlerta({ equipo_id, tipo_alerta, temperatura, humedad, ubicacion, nivel }) {
    const { rows } = await pool.query(`
      INSERT INTO alertas (equipo_id, tipo, temperatura, humedad, ubicacion, nivel)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [equipo_id, tipo_alerta, temperatura, humedad, ubicacion, nivel || 'normal'])
    return rows[0]
  }
}

module.exports = { db }
