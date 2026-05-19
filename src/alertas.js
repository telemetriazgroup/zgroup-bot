const express    = require('express')
const { getSock } = require('./bot')
const { db }      = require('./db')
const { logger }  = require('./logger')

const router = express.Router()

// POST /api/alerta
// Llamado por el sistema reefer cuando detecta una anomalía
router.post('/alerta', async (req, res) => {
  const { equipo_id, tipo_alerta, temperatura, humedad, ubicacion, nivel } = req.body

  if (!equipo_id || !tipo_alerta) {
    return res.status(400).json({ error: 'equipo_id y tipo_alerta son requeridos' })
  }

  const sock = getSock()
  if (!sock) {
    return res.status(503).json({ error: 'Bot de WhatsApp no está conectado aún' })
  }

  try {
    // Guardar alerta en BD
    await db.registrarAlerta({ equipo_id, tipo_alerta, temperatura, humedad, ubicacion, nivel })

    // Buscar usuarios que deben recibir esta alerta
    const usuarios = await db.obtenerUsuariosDeEquipo(equipo_id)

    if (!usuarios.length) {
      logger.warn(`⚠️ Alerta recibida para ${equipo_id} pero no hay usuarios asignados`)
      return res.json({ ok: true, enviados: 0, advertencia: 'Sin usuarios asignados' })
    }

    const emoji  = nivel === 'critico' ? '🚨' : '⚠️'
    const titulo = nivel === 'critico' ? 'ALERTA CRÍTICA' : 'ALERTA'

    const mensaje =
      `${emoji} *${titulo} REEFER — ZGroup*\n\n` +
      `📦 Equipo: *${equipo_id}*\n` +
      `⚠️ Tipo: ${tipo_alerta}\n` +
      `🌡️ Temperatura: *${temperatura}°C*\n` +
      (humedad ? `💧 Humedad: ${humedad}%\n` : '') +
      `📍 Ubicación: ${ubicacion}\n` +
      `🕐 Hora: ${new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' })}\n\n` +
      `Responde *ESTADO* para ver todos tus equipos.`

    let enviados = 0
    for (const usuario of usuarios) {
      try {
        await sock.sendMessage(`${usuario.telefono}@s.whatsapp.net`, { text: mensaje })
        enviados++
        logger.info(`📤 Alerta enviada a ${usuario.nombre} (${usuario.telefono})`)
      } catch (err) {
        logger.error(`❌ Error enviando a ${usuario.telefono}:`, err.message)
      }
    }

    res.json({ ok: true, enviados, total_usuarios: usuarios.length })

  } catch (err) {
    logger.error('Error procesando alerta:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// GET /api/usuarios — listar usuarios registrados
router.get('/usuarios', async (req, res) => {
  try {
    const usuarios = await db.listarUsuarios()
    res.json(usuarios)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/usuarios — registrar usuario interno
router.post('/usuarios', async (req, res) => {
  const { nombre, telefono, equipo_ids } = req.body
  if (!nombre || !telefono) {
    return res.status(400).json({ error: 'nombre y telefono son requeridos' })
  }
  try {
    const usuario = await db.crearUsuario({ nombre, telefono, equipo_ids })
    res.status(201).json(usuario)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
