/**
 * Cola de salida WhatsApp — ritmo humano (anti-blast).
 * - 1 conversación (destinatario distinto) por minuto
 * - 8–15 s entre mensajes al mismo chat
 */
const { logger } = require('../logger')

function getSock() {
  return require('../bot').getSock()
}

const GAP_ENTRE_CHATS_MS = parseInt(process.env.OUTBOX_GAP_CHAT_MS || '60000', 10)
const GAP_MISMO_CHAT_MS = parseInt(process.env.OUTBOX_GAP_SAME_MS || '10000', 10)
const TICK_MS = 2000

/** @type {Array<{ id: number, jid: string, tipo: 'text'|'image', text?: string, image?: Buffer, caption?: string, enviarDespues: number, prioridad: number, intentos: number }>} */
const cola = []
let seq = 1
let workerTimer = null
let enviando = false
let ultimoEnvioGlobal = 0
const ultimoEnvioPorJid = new Map()
/** Siguiente slot libre para iniciar conversación con un jid nuevo */
let siguienteSlotConversacion = 0

function ahora() {
  return Date.now()
}

function encolarMensaje({ jid, tipo = 'text', text, image, caption, enviarDespues, prioridad = 5, usuarioId, imeiContexto, meta }) {
  const job = {
    id: seq++,
    jid,
    tipo,
    text,
    image,
    caption,
    enviarDespues: enviarDespues || ahora(),
    prioridad,
    intentos: 0,
    usuarioId: usuarioId || null,
    imeiContexto: imeiContexto || null,
    meta: meta || null
  }
  cola.push(job)
  cola.sort((a, b) => a.enviarDespues - b.enviarDespues || a.prioridad - b.prioridad || a.id - b.id)
  return job.id
}

/**
 * Encola una conversación (varios mensajes al mismo chat) respetando
 * el espaciado entre destinatarios distintos.
 * @returns {{ jobIds: number[], iniciaEn: number }}
 */
function encolarConversacion(jid, mensajes, { prioridad = 5, usuarioId, imeiContexto, meta } = {}) {
  if (!jid || !mensajes?.length) return { jobIds: [], iniciaEn: ahora() }

  const t = ahora()
  const inicio = Math.max(t, siguienteSlotConversacion)
  siguienteSlotConversacion = inicio + GAP_ENTRE_CHATS_MS

  const jobIds = []
  let offset = 0
  for (const m of mensajes) {
    const payload = typeof m === 'string' ? { tipo: 'text', text: m } : m
    const id = encolarMensaje({
      jid,
      tipo: payload.tipo || 'text',
      text: payload.text,
      image: payload.image,
      caption: payload.caption,
      enviarDespues: inicio + offset,
      prioridad,
      usuarioId: payload.usuarioId || usuarioId,
      imeiContexto: payload.imeiContexto || imeiContexto,
      meta: payload.meta || meta
    })
    jobIds.push(id)
    offset += GAP_MISMO_CHAT_MS
  }

  logger.info(
    `📤 Outbox: conversación → ${jid} (${mensajes.length} msg, inicia en ${Math.round((inicio - t) / 1000)}s)`
  )
  return { jobIds, iniciaEn: inicio }
}

function encolarTexto(jid, text, opts = {}) {
  return encolarConversacion(jid, [text], opts)
}

function pendiente() {
  return cola.length
}

async function procesarUno() {
  if (enviando || !cola.length) return

  const t = ahora()
  const idx = cola.findIndex(j => j.enviarDespues <= t)
  if (idx < 0) return

  const job = cola[idx]
  const lastJid = ultimoEnvioPorJid.get(job.jid) || 0
  const waitSame = lastJid ? GAP_MISMO_CHAT_MS - (t - lastJid) : 0
  const waitGlobal = ultimoEnvioGlobal ? Math.min(3000, GAP_MISMO_CHAT_MS / 2) - (t - ultimoEnvioGlobal) : 0
  const wait = Math.max(0, waitSame, waitGlobal)
  if (wait > 0) {
    job.enviarDespues = t + wait
    cola.sort((a, b) => a.enviarDespues - b.enviarDespues || a.prioridad - b.prioridad || a.id - b.id)
    return
  }

  const sock = getSock()
  if (!sock) {
    job.enviarDespues = t + 5000
    return
  }

  cola.splice(idx, 1)
  enviando = true
  try {
    if (job.tipo === 'image' && job.image) {
      await sock.sendMessage(job.jid, { image: job.image, caption: job.caption || '' })
    } else {
      await sock.sendMessage(job.jid, { text: job.text || '' })
    }
    ultimoEnvioGlobal = ahora()
    ultimoEnvioPorJid.set(job.jid, ultimoEnvioGlobal)
    try {
      const { guardarSaliente } = require('./chat-historial')
      await guardarSaliente(job.jid, {
        text: job.text,
        caption: job.caption,
        tipo: job.tipo || 'text',
        usuarioId: job.usuarioId || null,
        imeiContexto: job.imeiContexto || null,
        meta: job.meta || null
      })
    } catch (err) {
      logger.warn(`Historial out: ${err.message}`)
    }
  } catch (err) {
    job.intentos++
    logger.error(`Outbox error #${job.id} → ${job.jid}: ${err.message}`)
    if (job.intentos < 3) {
      job.enviarDespues = ahora() + 15000
      cola.push(job)
      cola.sort((a, b) => a.enviarDespues - b.enviarDespues || a.prioridad - b.prioridad || a.id - b.id)
    }
  } finally {
    enviando = false
  }
}

function iniciarOutbox() {
  if (workerTimer) return
  workerTimer = setInterval(() => {
    procesarUno().catch(err => logger.error('Outbox worker:', err.message))
  }, TICK_MS)
  logger.info(
    `📬 Outbox iniciado (gap chats ${GAP_ENTRE_CHATS_MS / 1000}s, mismo chat ${GAP_MISMO_CHAT_MS / 1000}s)`
  )
}

function jidDeTelefono(telefono) {
  const n = String(telefono || '').replace(/\D/g, '')
  return `${n}@s.whatsapp.net`
}

module.exports = {
  encolarConversacion,
  encolarTexto,
  encolarMensaje,
  iniciarOutbox,
  pendiente,
  jidDeTelefono,
  GAP_ENTRE_CHATS_MS,
  GAP_MISMO_CHAT_MS
}
