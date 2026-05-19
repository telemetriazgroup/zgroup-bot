require('dotenv').config()
const express    = require('express')
const { conectarWhatsApp } = require('./src/bot')
const alertasRouter        = require('./src/alertas')
const { logger }           = require('./src/logger')

const app  = express()
const PORT = process.env.PORT || 9301

app.use(express.json())

// Middleware: validar token interno en todas las rutas /api
app.use('/api', (req, res, next) => {
  const token = req.headers['x-api-secret']
  if (token !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'No autorizado' })
  }
  next()
})

app.use('/api', alertasRouter)

// Health check para Docker
app.get('/health', (req, res) => res.json({ status: 'ok' }))

async function iniciar() {
  try {
    await conectarWhatsApp()
    app.listen(PORT, () => {
      logger.info(`🚀 API ZGroup escuchando en puerto ${PORT}`)
    })
  } catch (err) {
    logger.error('Error al iniciar:', err)
    process.exit(1)
  }
}

iniciar()
