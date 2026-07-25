require('dotenv').config()
const path = require('path')
const express = require('express')
const { initEstadoVinculo } = require('./src/bot-estado')

initEstadoVinculo('Bot arrancando — preparando WhatsApp…')

const { conectarWhatsApp } = require('./src/bot')
const alertasRouter = require('./src/alertas')
const { db } = require('./src/db')
const { iniciarMonitor } = require('./src/services/alertas')
const { logger } = require('./src/logger')

const app  = express()
const PORT = process.env.PORT || 9301

app.use(express.json())
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')))

// Middleware: validar token interno en todas las rutas /api
app.use('/api', (req, res, next) => {
  const token = req.headers['x-api-secret']
  if (token !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'No autorizado' })
  }
  next()
})

app.use('/api', alertasRouter)
app.get('/health', (req, res) => res.json({ status: 'ok' }))

async function iniciar() {
  try {
    await db.initDb()
    logger.info('✅ Base de datos inicializada')
    try {
      await conectarWhatsApp()
    } catch (err) {
      logger.error('WhatsApp no conectó al arranque:', err.message)
    }
    app.listen(PORT, () => {
      logger.info(`🚀 API ZGroup escuchando en puerto ${PORT}`)
      logger.info(`🖥️  Panel admin: http://localhost:${PORT}/admin`)
    })
    iniciarMonitor()
  } catch (err) {
    logger.error('Error al iniciar:', err)
    process.exit(1)
  }
}

iniciar()
