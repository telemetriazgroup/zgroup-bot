const path = require('path')
const fs = require('fs')
const QRCode = require('qrcode')
const { logger } = require('./logger')

const QR_DIR = path.join(__dirname, '..', 'qr')
const STATUS_FILE = path.join(QR_DIR, 'status.json')

const estadoInicial = () => ({
  actualizado: new Date().toISOString(),
  conectado: false,
  fase: 'iniciando',
  mensaje: 'Iniciando bot…',
  pasos: [],
  ultimo_error: null,
  codigo_desconexion: null,
  qr_disponible: false,
  qr_imagen: null,
  qr_generado_en: null,
  qr_valido_hasta: null,
  vinculacion_en_curso: false,
  codigo_vinculacion: null,
  telefono_vinculacion: null,
  telefono_vinculacion_display: null,
  modo_vinculacion: 'qr',
  posible_bloqueo_wa: false,
  recomendacion: null,
  tiene_sesion: false,
  sesion_registrada: false
})

let estado = estadoInicial()

function asegurarDir() {
  if (!fs.existsSync(QR_DIR)) fs.mkdirSync(QR_DIR, { recursive: true })
}

function guardarEstado() {
  try {
    asegurarDir()
    estado.actualizado = new Date().toISOString()
    fs.writeFileSync(STATUS_FILE, JSON.stringify(estado, null, 2), { mode: 0o664 })
  } catch (err) {
    logger.error(`No se pudo escribir ${STATUS_FILE}:`, err.message)
  }
}

function initEstadoVinculo(mensaje = 'Iniciando bot…') {
  estado = estadoInicial()
  estado.mensaje = mensaje
  registrarPaso('init', 'Estado de vinculación', 'Archivo status.json listo', 'ok')
}

function registrarPaso(id, titulo, detalle, status = 'ok') {
  const hora = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' })
  const idx = estado.pasos.findIndex(p => p.id === id)
  const entry = { id, titulo, detalle, status, hora }
  if (idx >= 0) estado.pasos[idx] = entry
  else estado.pasos.push(entry)
  guardarEstado()
}

function setFase(fase, mensaje, extra = {}) {
  estado.fase = fase
  estado.mensaje = mensaje
  Object.assign(estado, extra)
  guardarEstado()
}

function setError(mensaje, recomendacion) {
  estado.ultimo_error = mensaje
  estado.recomendacion = recomendacion || estado.recomendacion
  registrarPaso('error', 'Error', mensaje, 'error')
  guardarEstado()
}

async function setQr(qrString, opts = {}) {
  try {
    const validoMs = opts.validoMs || 120_000
    const url = await QRCode.toDataURL(qrString, {
      width: 512,
      margin: 4,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#FFFFFF' }
    })
    const ahora = Date.now()
    estado.qr_imagen = url
    estado.qr_disponible = true
    estado.qr_generado_en = new Date(ahora).toISOString()
    estado.qr_valido_hasta = new Date(ahora + validoMs).toISOString()
    estado.vinculacion_en_curso = false
    const min = Math.round(validoMs / 60_000)
    setFase('qr_listo', `Escanea el QR (válido ~${min} min; luego pedir otro manualmente si hace falta)`, {
      ultimo_error: null,
      modo_vinculacion: 'qr',
      codigo_vinculacion: null
    })
    registrarPaso('qr', 'Código QR generado', `Mismo código ~${min} min — no se renueva solo`, 'ok')
  } catch (err) {
    setError(`No se pudo generar imagen QR: ${err.message}`, 'Revisa logs del contenedor bot')
  }
}

function marcarVinculacionEnCurso(mensaje = 'Completando vinculación…') {
  estado.vinculacion_en_curso = true
  estado.qr_disponible = false
  estado.qr_imagen = null
  estado.qr_valido_hasta = null
  setFase('vinculando', mensaje, { ultimo_error: null })
  guardarEstado()
}

function marcarConectado(usuario) {
  estado.conectado = true
  estado.qr_disponible = false
  estado.qr_imagen = null
  estado.vinculacion_en_curso = false
  estado.qr_valido_hasta = null
  estado.codigo_vinculacion = null
  setFase('conectado', `Conectado como ${usuario || 'WhatsApp'}`, {
    ultimo_error: null,
    recomendacion: null
  })
  registrarPaso('open', 'WhatsApp conectado', usuario || 'Sesión activa', 'ok')
}

function resetEstado(mensaje = 'Reiniciando vinculación…') {
  estado = estadoInicial()
  estado.mensaje = mensaje
  estado.fase = 'reiniciando'
  guardarEstado()
}

function obtenerEstadoVinculo() {
  return { ...estado, pasos: [...estado.pasos] }
}

function patchEstado(partial) {
  Object.assign(estado, partial)
  guardarEstado()
}

function leerEstadoArchivo() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'))
    }
  } catch { /* noop */ }
  return null
}

module.exports = {
  QR_DIR,
  STATUS_FILE,
  registrarPaso,
  setFase,
  setError,
  setQr,
  marcarVinculacionEnCurso,
  marcarConectado,
  resetEstado,
  obtenerEstadoVinculo,
  patchEstado,
  leerEstadoArchivo,
  guardarEstado,
  asegurarDir,
  initEstadoVinculo
}
