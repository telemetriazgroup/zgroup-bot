/**
 * Cola de salida WhatsApp — ritmo humano (anti-blast).
 * - Chats fríos: 1 conversación nueva cada 30 s (por defecto)
 * - Réplicas mismo chat: ~5 s
 * - Chats activos (inbound reciente): prioridad y sin consumir el slot global
 */
const { logger } = require('../logger')

function getSock() {
  return require('../bot').getSock()
}

const GAP_ENTRE_CHATS_MS = parseInt(process.env.OUTBOX_GAP_CHAT_MS || '30000', 10)
const GAP_MISMO_CHAT_MS = parseInt(process.env.OUTBOX_GAP_SAME_MS || '5000', 10)
const ACTIVO_MS = parseInt(process.env.OUTBOX_ACTIVO_MS || String(15 * 60 * 1000), 10)
const TICK_MS = 2000

/** @type {Array<object>} */
const cola = []
let seq = 1
let workerTimer = null
let enviando = false
let ultimoEnvioGlobal = 0
const ultimoEnvioPorJid = new Map()
/** Último mensaje entrante por jid (prioridad interactiva) */
const ultimoInboundPorJid = new Map()
/** Siguiente slot libre para iniciar conversación con un jid frío */
let siguienteSlotConversacion = 0

function ahora() {
  return Date.now()
}

function marcarActividadInbound(jid) {
  if (!jid) return
  ultimoInboundPorJid.set(jid, ahora())
}

function esChatActivo(jid) {
  const t = ultimoInboundPorJid.get(jid) || 0
  return !!(t && ahora() - t < ACTIVO_MS)
}

function ordenarCola() {
  cola.sort((a, b) =>
    a.enviarDespues - b.enviarDespues ||
    (Number(b.chatActivo) - Number(a.chatActivo)) ||
    a.prioridad - b.prioridad ||
    a.id - b.id
  )
}

function encolarMensaje({
  jid,
  tipo = 'text',
  text,
  image,
  caption,
  enviarDespues,
  prioridad = 5,
  usuarioId,
  imeiContexto,
  meta,
  chatActivo = false
}) {
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
    meta: meta || null,
    chatActivo: !!chatActivo
  }
  cola.push(job)
  ordenarCola()
  return job.id
}

/**
 * Encola una conversación (varios mensajes al mismo chat).
 * Chat activo: responde rápido sin empujar el slot global de chats fríos.
 */
function encolarConversacion(jid, mensajes, { prioridad = 5, usuarioId, imeiContexto, meta } = {}) {
  if (!jid || !mensajes?.length) return { jobIds: [], iniciaEn: ahora() }

  const t = ahora()
  const activo = esChatActivo(jid)
  const prio = activo ? Math.min(prioridad, 2) : prioridad

  let inicio
  if (activo) {
    const lastJid = ultimoEnvioPorJid.get(jid) || 0
    inicio = Math.max(t, lastJid ? lastJid + GAP_MISMO_CHAT_MS : t)
  } else {
    inicio = Math.max(t, siguienteSlotConversacion)
    siguienteSlotConversacion = inicio + GAP_ENTRE_CHATS_MS
  }

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
      prioridad: prio,
      usuarioId: payload.usuarioId || usuarioId,
      imeiContexto: payload.imeiContexto || imeiContexto,
      meta: payload.meta || meta,
      chatActivo: activo
    })
    jobIds.push(id)
    offset += GAP_MISMO_CHAT_MS
  }

  logger.info(
    `📤 Outbox: → ${jid} (${mensajes.length} msg, ${activo ? 'activo' : 'frío'}, inicia ${Math.round((inicio - t) / 1000)}s)`
  )
  return { jobIds, iniciaEn: inicio, chatActivo: activo }
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
  // Preferir job listo de chat activo
  let idx = cola.findIndex(j => j.enviarDespues <= t && j.chatActivo)
  if (idx < 0) idx = cola.findIndex(j => j.enviarDespues <= t)
  if (idx < 0) return

  const job = cola[idx]
  const lastJid = ultimoEnvioPorJid.get(job.jid) || 0
  const waitSame = lastJid ? GAP_MISMO_CHAT_MS - (t - lastJid) : 0
  const waitGlobal = ultimoEnvioGlobal
    ? Math.min(2000, GAP_MISMO_CHAT_MS / 2) - (t - ultimoEnvioGlobal)
    : 0
  // Chats activos: no esperar gap global largo entre destinatarios
  const wait = Math.max(0, waitSame, job.chatActivo ? 0 : waitGlobal)
  if (wait > 0) {
    job.enviarDespues = t + wait
    ordenarCola()
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
      ordenarCola()
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
    `📬 Outbox iniciado (chats fríos ${GAP_ENTRE_CHATS_MS / 1000}s, réplicas ${GAP_MISMO_CHAT_MS / 1000}s, activo ${ACTIVO_MS / 60000} min)`
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
  marcarActividadInbound,
  esChatActivo,
  GAP_ENTRE_CHATS_MS,
  GAP_MISMO_CHAT_MS,
  ACTIVO_MS
}
