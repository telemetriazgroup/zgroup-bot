/**
 * Cliente WhatsApp vía whatsapp-web.js (Chromium + web.whatsapp.com).
 * Expone getSock() con sendMessage compatible con el resto del bot.
 */
const path = require('path')
const fs = require('fs')
const { execSync } = require('child_process')
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js')
const { logger } = require('./logger')
const { manejarMensaje } = require('./handlers')
const {
  registrarPaso,
  setFase,
  setError,
  setQr,
  marcarConectado,
  marcarVinculacionEnCurso,
  resetEstado,
  obtenerEstadoVinculo,
  patchEstado,
  asegurarDir,
  QR_DIR
} = require('./bot-estado')

const SESSIONS_DIR = path.join(__dirname, '..', 'sessions')
const WWEB_AUTH_DIR = path.join(SESSIONS_DIR, 'wwebjs')
const QR_TEMPLATE = path.join(__dirname, '..', 'public', 'qr-viewer', 'index.html')

let client = null
let sockAdapter = null
let iniciando = false
let modoPairing = false
let telefonoPairing = null

function chromiumPath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return candidates[0] || '/usr/bin/chromium-browser'
}

function copiarPlantillaQr() {
  asegurarDir()
  const viewerDir = path.join(__dirname, '..', 'public', 'qr-viewer')
  if (!fs.existsSync(viewerDir)) {
    if (fs.existsSync(QR_TEMPLATE)) {
      fs.copyFileSync(QR_TEMPLATE, path.join(QR_DIR, 'index.html'))
    }
    return
  }
  for (const name of fs.readdirSync(viewerDir)) {
    if (name.endsWith('.html')) {
      fs.copyFileSync(path.join(viewerDir, name), path.join(QR_DIR, name))
    }
  }
}

function limpiarSesionDisco() {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o775 })
      return true
    }
    for (const name of fs.readdirSync(SESSIONS_DIR)) {
      fs.rmSync(path.join(SESSIONS_DIR, name), { recursive: true, force: true })
    }
    return true
  } catch (err) {
    logger.error(`No se pudo limpiar sessions: ${err.message}`)
    return false
  }
}

/** Quita SingletonLock / zombies de Chromium (error Code 21 — perfil en uso) */
function liberarPerfilChromium() {
  const nombresLock = new Set([
    'SingletonLock',
    'SingletonSocket',
    'SingletonCookie',
    'lockfile',
    '.com.google.Chrome.plist',
    'RunningChromeVersion'
  ])
  function walk(dir) {
    if (!fs.existsSync(dir)) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (nombresLock.has(e.name) || e.name.startsWith('Singleton')) {
        try {
          fs.rmSync(full, { force: true })
          logger.info(`Lock Chromium eliminado: ${full}`)
        } catch (err) {
          logger.warn(`No se pudo borrar ${full}: ${err.message}`)
        }
      }
    }
  }
  walk(WWEB_AUTH_DIR)
  walk(SESSIONS_DIR)
  try {
    execSync('pkill -9 -f chromium || pkill -9 -f chrome || true', { stdio: 'ignore' })
  } catch { /* noop */ }
}

function sesionEnDisco() {
  try {
    if (!fs.existsSync(WWEB_AUTH_DIR)) return false
    return fs.readdirSync(WWEB_AUTH_DIR).length > 0
  } catch {
    return false
  }
}

function normalizarTelefono(raw) {
  return String(raw || '').replace(/\D/g, '')
}

function formatearTelefonoDisplay(phone) {
  const d = normalizarTelefono(phone)
  if (!d) return ''
  if (d.startsWith('51') && d.length === 11) {
    return `+51 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`
  }
  return d.length > 4 ? `+${d}` : d
}

function aChatId(jid) {
  if (!jid) return jid
  if (jid.endsWith('@g.us') || jid.endsWith('@c.us') || jid.endsWith('@lid')) return jid
  return String(jid)
    .replace('@s.whatsapp.net', '@c.us')
    .replace(/@.*/, '') + '@c.us'
}

/** Cache LID WhatsApp → teléfono real (WhatsApp ya no siempre manda @c.us) */
const lidATelefono = new Map()

function digitosDeJid(jid) {
  return String(jid || '')
    .replace(/@.*$/, '')
    .replace(/\D/g, '')
}

/**
 * Resuelve el teléfono real del remitente.
 * WhatsApp Web reciente usa @lid (Linked ID); hay que mapearlo a @c.us.
 */
async function resolverTelefonoRemitente(waClient, msg) {
  const from = String(msg.from || '')
  const esGrupo = from.endsWith('@g.us')
  const targetId = esGrupo
    ? String(msg.author || msg.id?.participant || '')
    : from

  if (!targetId) return null

  if (lidATelefono.has(targetId)) return lidATelefono.get(targetId)

  // Chat privado clásico: 519...@c.us
  if (targetId.endsWith('@c.us') || targetId.endsWith('@s.whatsapp.net')) {
    const n = digitosDeJid(targetId)
    if (n) {
      lidATelefono.set(targetId, n)
      return n
    }
  }

  // LID → phone number
  try {
    if (typeof waClient.getContactLidAndPhone === 'function') {
      const pairs = await waClient.getContactLidAndPhone([targetId])
      const pn = pairs?.[0]?.pn
      const n = digitosDeJid(pn)
      if (n && n.length >= 8) {
        logger.info(`🔗 LID resuelto: ${targetId} → ${n}`)
        lidATelefono.set(targetId, n)
        if (pairs[0]?.lid) lidATelefono.set(pairs[0].lid, n)
        return n
      }
    }
  } catch (err) {
    logger.warn(`getContactLidAndPhone(${targetId}): ${err.message}`)
  }

  try {
    const contact = await msg.getContact()
    const server = contact?.id?.server
    if (contact?.number && server && server !== 'lid') {
      const n = String(contact.number).replace(/\D/g, '')
      if (n.length >= 8) {
        lidATelefono.set(targetId, n)
        return n
      }
    }
    if (contact?.id?._serialized && typeof waClient.getContactLidAndPhone === 'function') {
      const pairs = await waClient.getContactLidAndPhone([contact.id._serialized])
      const n = digitosDeJid(pairs?.[0]?.pn)
      if (n && n.length >= 8) {
        logger.info(`🔗 LID (contact) resuelto: ${contact.id._serialized} → ${n}`)
        lidATelefono.set(targetId, n)
        return n
      }
    }
  } catch (err) {
    logger.warn(`getContact remitente: ${err.message}`)
  }

  // Último recurso: dígitos del JID (puede ser LID, no teléfono)
  const fallback = digitosDeJid(targetId)
  logger.warn(`⚠️ No se pudo mapear LID→teléfono para ${targetId} (fallback ${fallback})`)
  return fallback || null
}

function crearAdapter(waClient) {
  return {
    get user() {
      try {
        const id = waClient.info?.wid?._serialized || waClient.info?.me?._serialized
        return id ? { id, name: waClient.info?.pushname || null } : null
      } catch {
        return null
      }
    },
    async sendMessage(jid, content = {}) {
      const chatId = aChatId(jid)
      if (typeof content === 'string') {
        return waClient.sendMessage(chatId, content)
      }
      if (content.text != null) {
        return waClient.sendMessage(chatId, content.text)
      }
      if (content.image) {
        const buf = Buffer.isBuffer(content.image)
          ? content.image
          : Buffer.from(content.image)
        const media = new MessageMedia(
          'image/png',
          buf.toString('base64'),
          'imagen.png'
        )
        return waClient.sendMessage(chatId, media, { caption: content.caption || '' })
      }
      throw new Error('Contenido de mensaje no soportado')
    }
  }
}

async function destruirCliente() {
  if (client) {
    try {
      await client.destroy()
    } catch {
      try { await client.pupBrowser?.close() } catch { /* noop */ }
    }
  }
  client = null
  sockAdapter = null
  await new Promise(r => setTimeout(r, 800))
  liberarPerfilChromium()
}

function registrarEventos(waClient) {
  waClient.on('qr', async (qr) => {
    if (modoPairing) return
    logger.info('QR WhatsApp Web recibido')
    await setQr(qr, { validoMs: 120_000 })
    patchEstado({
      modo_vinculacion: 'qr',
      codigo_vinculacion: null,
      recomendacion: 'Escanea en :9300 (mismo flujo que web.whatsapp.com).'
    })
    registrarPaso('qr', 'Código QR generado', 'whatsapp-web.js — escanea en el teléfono', 'ok')
  })

  waClient.on('loading_screen', (percent, message) => {
    setFase('conectando', `Cargando WhatsApp Web… ${percent}% ${message || ''}`.trim())
  })

  waClient.on('authenticated', () => {
    marcarVinculacionEnCurso('Autenticado — cargando sesión WhatsApp Web…')
    registrarPaso('auth', 'Autenticado', 'Credenciales WhatsApp Web guardadas', 'ok')
  })

  waClient.on('auth_failure', (msg) => {
    logger.error('Fallo de autenticación WhatsApp Web:', msg)
    setError(String(msg || 'auth_failure'), 'Admin → Iniciar vinculación QR')
    setFase('error', 'Autenticación fallida')
  })

  waClient.on('ready', () => {
    sockAdapter = crearAdapter(waClient)
    const numero = waClient.info?.wid?.user || waClient.info?.me?.user || 'WhatsApp'
    marcarConectado(numero)
    patchEstado({
      modo_vinculacion: 'qr',
      codigo_vinculacion: null,
      posible_bloqueo_wa: false,
      telefono_vinculacion_display: formatearTelefonoDisplay(numero)
    })
    logger.info(`✅ Bot conectado (whatsapp-web.js) como ${numero}`)
    registrarPaso('open', 'WhatsApp conectado', `Sesión Web activa (${numero})`, 'ok')
    iniciando = false
  })

  waClient.on('disconnected', (reason) => {
    logger.warn(`WhatsApp desconectado: ${reason}`)
    sockAdapter = null
    patchEstado({ conectado: false })
    setFase('error', `Desconectado: ${reason}`)
    registrarPaso('close', 'Desconectado', String(reason), 'error')
    iniciando = false
    if (reason !== 'LOGOUT') {
      setTimeout(() => {
        conectarWhatsApp().catch(err => logger.error(err.message))
      }, 5000)
    }
  })

  waClient.on('message', async (msg) => {
    try {
      if (msg.fromMe) return
      if (msg.isStatus) return

      const telefono = await resolverTelefonoRemitente(waClient, msg)
      if (!telefono) {
        logger.warn(`Mensaje sin teléfono resoluble (from=${msg.from})`)
        return
      }

      logger.info(`📩 WA from=${msg.from} → tel=${telefono} body="${String(msg.body || '').slice(0, 80)}"`)

      const wrapped = {
        key: {
          remoteJid: `${telefono}@s.whatsapp.net`,
          fromMe: false
        },
        message: { conversation: msg.body || '' },
        _rawFrom: msg.from
      }
      await manejarMensaje(crearAdapter(waClient), wrapped)
    } catch (err) {
      logger.error('Error en message handler:', err.message)
    }
  })
}

async function conectarWhatsApp() {
  if (iniciando) {
    logger.warn('conectarWhatsApp ya en curso')
    return sockAdapter
  }
  if (client && sockAdapter?.user) return sockAdapter

  iniciando = true
  copiarPlantillaQr()
  setFase('iniciando', 'Iniciando WhatsApp Web (Chromium)…')
  registrarPaso('boot', 'Bot iniciado', 'Cliente whatsapp-web.js', 'pending')

  try {
    await destruirCliente()
    liberarPerfilChromium()
    registrarPaso('browser', 'Perfil Chromium', 'Locks liberados', 'ok')

    const haySesion = sesionEnDisco()
    registrarPaso(
      'sesion',
      'Carpeta de sesión',
      haySesion ? 'Sesión WhatsApp Web en disco' : 'Vacía — se generará QR',
      haySesion ? 'warn' : 'ok'
    )
    patchEstado({
      tiene_sesion: haySesion,
      sesion_registrada: haySesion,
      modo_vinculacion: modoPairing ? 'pairing' : 'qr'
    })

    fs.mkdirSync(WWEB_AUTH_DIR, { recursive: true })

    const exe = chromiumPath()
    registrarPaso('browser', 'Chromium', exe, 'ok')
    logger.info(`Lanzando Chromium: ${exe}`)

    const waClient = new Client({
      authStrategy: new LocalAuth({
        clientId: 'zgroup-bot',
        dataPath: WWEB_AUTH_DIR
      }),
      puppeteer: {
        headless: true,
        executablePath: exe,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ]
      }
    })

    client = waClient
    registrarEventos(waClient)

    setFase(
      'conectando',
      modoPairing
        ? 'Conectando WhatsApp Web para código…'
        : 'Esperando QR de WhatsApp Web…'
    )

    await waClient.initialize()

    if (modoPairing && telefonoPairing && typeof waClient.requestPairingCode === 'function') {
      try {
        await new Promise(r => setTimeout(r, 2500))
        const code = await waClient.requestPairingCode(telefonoPairing)
        const fmt = String(code).length === 8
          ? `${String(code).slice(0, 4)}-${String(code).slice(4)}`
          : String(code)
        patchEstado({
          codigo_vinculacion: code,
          modo_vinculacion: 'pairing',
          telefono_vinculacion: `***${telefonoPairing.slice(-4)}`,
          telefono_vinculacion_display: formatearTelefonoDisplay(telefonoPairing)
        })
        setFase(
          'pairing_listo',
          `Código ${fmt} para ${formatearTelefonoDisplay(telefonoPairing)}`
        )
        registrarPaso('pairing', 'Código de vinculación', `${fmt} → WhatsApp Web`, 'ok')
      } catch (err) {
        logger.warn(`Pairing code no disponible (${err.message}) — usa QR`)
        modoPairing = false
        patchEstado({
          modo_vinculacion: 'qr',
          recomendacion: 'El código no se pudo generar; escanea el QR en :9300'
        })
      }
    }

    return sockAdapter
  } catch (err) {
    iniciando = false
    logger.error('Error iniciando WhatsApp Web:', err)
    setError(err.message, 'Revisa Chromium en el contenedor: docker compose logs -f bot')
    setFase('error', 'No se pudo iniciar WhatsApp Web')
    throw err
  }
}

async function reiniciarWhatsApp({ nuevaVinculacion = false } = {}) {
  iniciando = false
  modoPairing = false
  telefonoPairing = null
  await destruirCliente()
  resetEstado(nuevaVinculacion ? 'Nueva vinculación — borrando sesión…' : 'Reiniciando…')
  copiarPlantillaQr()
  if (nuevaVinculacion) {
    limpiarSesionDisco()
    registrarPaso('sesion', 'Sesión eliminada', 'Lista para QR WhatsApp Web', 'ok')
    patchEstado({ modo_vinculacion: 'qr', codigo_vinculacion: null })
  }
  await new Promise(r => setTimeout(r, 800))
  return conectarWhatsApp()
}

async function iniciarVinculacionPorQr() {
  iniciando = false
  modoPairing = false
  telefonoPairing = null
  await destruirCliente()
  limpiarSesionDisco()
  resetEstado('Modo QR — WhatsApp Web…')
  patchEstado({ modo_vinculacion: 'qr', codigo_vinculacion: null })
  registrarPaso('sesion', 'Modo QR', 'Sesión limpia — escanea en :9300', 'ok')
  copiarPlantillaQr()
  await new Promise(r => setTimeout(r, 500))
  return conectarWhatsApp()
}

async function pedirNuevoQrManual() {
  if (sockAdapter?.user) throw new Error('WhatsApp ya está conectado')
  return iniciarVinculacionPorQr()
}

async function iniciarVinculacionPorCodigo(telefono) {
  const phone = normalizarTelefono(telefono || process.env.WHATSAPP_PHONE)
  if (!phone || phone.length < 10) {
    throw new Error('Indica teléfono con código de país, ej. 519XXXXXXXX')
  }
  iniciando = false
  modoPairing = true
  telefonoPairing = phone
  process.env.WHATSAPP_PHONE = phone
  await destruirCliente()
  limpiarSesionDisco()
  resetEstado('Modo código — WhatsApp Web…')
  patchEstado({
    modo_vinculacion: 'pairing',
    telefono_vinculacion_display: formatearTelefonoDisplay(phone)
  })
  registrarPaso('pairing', 'Modo código', `Número ${formatearTelefonoDisplay(phone)}`, 'ok')
  await conectarWhatsApp()

  const inicio = Date.now()
  while (Date.now() - inicio < 60_000) {
    const e = obtenerEstadoVinculo()
    if (e.codigo_vinculacion) return e.codigo_vinculacion
    if (e.fase === 'qr_listo' && e.qr_disponible) {
      throw new Error('WhatsApp Web pidió QR. Usa «Iniciar vinculación QR» o escanea en :9300')
    }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error('Tiempo agotado. Prueba vinculación por QR (recomendado con WhatsApp Web).')
}

function obtenerEstadoBot() {
  const v = obtenerEstadoVinculo()
  const user = sockAdapter?.user
  return {
    conectado: !!user,
    puede_enviar: !!user,
    usuario: user?.id || null,
    nombre: user?.name || null,
    cliente: 'whatsapp-web.js',
    diagnostico: v
  }
}

function obtenerDiagnosticoCompleto() {
  const v = obtenerEstadoVinculo()
  return {
    ...v,
    conectado_socket: !!sockAdapter?.user,
    usuario: sockAdapter?.user?.id || null,
    sesion_en_disco: sesionEnDisco(),
    cliente: 'whatsapp-web.js',
    chromium: chromiumPath(),
    rutas: {
      sessions: SESSIONS_DIR,
      wwebjs: WWEB_AUTH_DIR,
      qr: QR_DIR
    }
  }
}

const getSock = () => sockAdapter

module.exports = {
  conectarWhatsApp,
  getSock,
  reiniciarWhatsApp,
  pedirNuevoQrManual,
  iniciarVinculacionPorCodigo,
  iniciarVinculacionPorQr,
  obtenerEstadoBot,
  obtenerDiagnosticoCompleto,
  limpiarSesionDisco
}
