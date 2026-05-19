const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const path   = require('path')
const fs     = require('fs')
const { logger } = require('./logger')
const { manejarMensaje } = require('./handlers')

let sock = null

// Carpeta donde se guarda el QR como imagen para verlo vía nginx
const QR_DIR  = path.join(__dirname, '..', 'qr')
const QR_FILE = path.join(QR_DIR, 'index.html')

function paginaEsperando() {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="5">
<title>ZGroup Bot — Esperando QR</title></head>
<body style="font-family:sans-serif;text-align:center;padding:48px">
<h2>🤖 ZGroup Bot</h2><p>Generando código QR…</p></body></html>`
}

function paginaConectado() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>ZGroup Bot — Conectado</title>
  <style>
    body { font-family: sans-serif; display:flex; flex-direction:column;
           align-items:center; justify-content:center; min-height:100vh;
           background:#f5f5f5; margin:0; }
    .card { background:#fff; border-radius:16px; padding:32px;
            box-shadow:0 4px 24px rgba(0,0,0,.1); text-align:center; max-width:400px; }
    h2 { color:#1a1a1a; margin-bottom:8px; }
    p  { color:#666; font-size:14px; line-height:1.5; }
    .badge { background:#25D366; color:#fff; border-radius:20px;
             padding:8px 18px; font-size:14px; margin-top:16px; display:inline-block; }
  </style>
</head>
<body>
  <div class="card">
    <h2>✅ WhatsApp vinculado</h2>
    <p>El bot está conectado y listo para enviar alertas.</p>
    <span class="badge">ZGroup Bot activo</span>
    <p style="margin-top:24px;font-size:12px">Ya puedes cerrar esta página.</p>
  </div>
</body>
</html>`
}

function guardarQR(qr) {
  if (!fs.existsSync(QR_DIR)) fs.mkdirSync(QR_DIR, { recursive: true })

  QRCode.toDataURL(qr, { width: 400 }, (err, url) => {
    if (err) return logger.error('Error generando QR:', err)

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="15">
  <title>ZGroup Bot — Escanear QR</title>
  <style>
    body { font-family: sans-serif; display:flex; flex-direction:column;
           align-items:center; justify-content:center; min-height:100vh;
           background:#f5f5f5; margin:0; }
    .card { background:#fff; border-radius:16px; padding:32px;
            box-shadow:0 4px 24px rgba(0,0,0,.1); text-align:center; }
    h2 { color:#1a1a1a; margin-bottom:8px; }
    p  { color:#666; margin-bottom:24px; font-size:14px; }
    img { border-radius:8px; }
    .badge { background:#25D366; color:#fff; border-radius:20px;
             padding:4px 14px; font-size:12px; margin-top:16px; display:inline-block; }
  </style>
</head>
<body>
  <div class="card">
    <h2>🤖 ZGroup Bot</h2>
    <p>Abre WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
    <img src="${url}" alt="QR WhatsApp" width="300" height="300"/>
    <br>
    <span class="badge">Se actualiza cada 15 seg</span>
  </div>
</body>
</html>`
    fs.writeFileSync(QR_FILE, html)
    logger.info(`📱 QR disponible en http://TU_SERVIDOR:9300`)
  })
}

async function conectarWhatsApp() {
  if (!fs.existsSync(QR_DIR)) fs.mkdirSync(QR_DIR, { recursive: true })
  if (!fs.existsSync(QR_FILE)) fs.writeFileSync(QR_FILE, paginaEsperando())

  const { state, saveCreds } = await useMultiFileAuthState('./sessions')
  const { version }          = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,   // también en consola como respaldo
    logger: require('pino')({ level: 'silent' }) // silenciar logs internos de Baileys
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {

    // Nuevo QR disponible → guardar como página web
    if (qr) guardarQR(qr)

    if (connection === 'close') {
      const codigo = lastDisconnect?.error?.output?.statusCode
      const debeReconectar = codigo !== DisconnectReason.loggedOut

      logger.warn(`❌ Conexión cerrada. Código: ${codigo}. Reconectar: ${debeReconectar}`)

      if (debeReconectar) {
        logger.info('🔄 Reconectando en 5 segundos...')
        setTimeout(conectarWhatsApp, 5000)
      } else {
        logger.error('🚫 Sesión cerrada. Elimina la carpeta sessions/ y reinicia.')
      }
    }

    if (connection === 'open') {
      logger.info('✅ Bot conectado a WhatsApp correctamente')
      fs.writeFileSync(QR_FILE, paginaConectado())
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return   // ignorar mensajes propios
    await manejarMensaje(sock, msg)
  })

  return sock
}

const getSock = () => sock

module.exports = { conectarWhatsApp, getSock }
