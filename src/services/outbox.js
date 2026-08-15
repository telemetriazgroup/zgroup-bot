/**
 * Cola de salida WhatsApp — ritmo humano (anti-blast / anti-spam).
 * - Alertas push a varios usuarios: 1 conversación nueva por minuto
 * - Conversación activa (usuario escribió): ≤10 s entre mensajes
 * - Chats activos tienen prioridad sobre alertas frías
 */
const { logger } = require('../logger')

function getSock() {
  return require('../bot').getSock()
}

/** Espacio entre destinatarios distintos al enviar ALERTAS (push) */
const GAP_ALERTA_CHAT_MS = parseInt(process.env.OUTBOX_GAP_ALERTA_MS || '60000', 10)
/** Réplicas / conversación activa: máximo entre mensajes del mismo chat */
const GAP_ACTIVO_MS = parseInt(process.env.OUTBOX_GAP_ACTIVO_MS || '10000', 10)
/** Entre mensajes del mismo chat en una ráfaga (gráfica + texto, etc.) */
const GAP_MISMO_CHAT_MS = parseInt(process.env.OUTBOX_GAP_SAME_MS || String(GAP_ACTIVO_MS), 10)
/** Legacy / chats fríos no-alerta (p.ej. prueba) */
const GAP_ENTRE_CHATS_MS = parseInt(process.env.OUTBOX_GAP_CHAT_MS || String(GAP_ALERTA_CHAT_MS), 10)
const ACTIVO_MS = parseInt(process.env.OUTBOX_ACTIVO_MS || String(15 * 60 * 1000), 10)
const TICK_MS = 2000

/** @type {Array<object>} */
const cola = []
let seq = 1
let workerTimer = null
let enviando = false
let ultimoEnvioGlobal = 0
const ultimoEnvioPorJid = new Map()
const ultimoInboundPorJid = new Map()
/** Slot para alertas push (1/min entre usuarios) */
let siguienteSlotAlerta = 0
/** Slot genérico chats fríos no-alerta */
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
  // Activo primero; luego menor prioridad numérica; alertas después de réplicas
  cola.sort((a, b) =>
    a.enviarDespues - b.enviarDespues ||
    (Number(b.chatActivo) - Number(a.chatActivo)) ||
    (Number(a.esAlerta) - Number(b.esAlerta)) ||
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
  chatActivo = false,
  esAlerta = false
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
    chatActivo: !!chatActivo,
    esAlerta: !!esAlerta
  }
  cola.push(job)
  ordenarCola()
  return job.id
}

/**
 * @param {object} [opts]
 * @param {'alerta'|'conversacion'} [opts.modo] - alerta = 1 min entre usuarios; conversacion = línea libre
 * @param {boolean} [opts.esAlerta] - alias de modo=alerta
 */
function encolarConversacion(jid, mensajes, {
  prioridad = 5,
  usuarioId,
  imeiContexto,
  meta,
  modo = null,
  esAlerta = false
} = {}) {
  if (!jid || !mensajes?.length) return { jobIds: [], iniciaEn: ahora() }

  const t = ahora()
  const alerta = esAlerta || modo === 'alerta'
  const activo = !alerta && esChatActivo(jid)
  const prio = activo ? Math.min(prioridad, 1) : (alerta ? Math.max(prioridad, 3) : prioridad)

  let inicio
  let tipoSlot = 'frio'
  if (activo) {
    const lastJid = ultimoEnvioPorJid.get(jid) || 0
    inicio = Math.max(t, lastJid ? lastJid + GAP_ACTIVO_MS : t)
    tipoSlot = 'activo'
  } else if (alerta) {
    inicio = Math.max(t, siguienteSlotAlerta)
    siguienteSlotAlerta = inicio + GAP_ALERTA_CHAT_MS
    tipoSlot = 'alerta'
  } else {
    inicio = Math.max(t, siguienteSlotConversacion)
    siguienteSlotConversacion = inicio + GAP_ENTRE_CHATS_MS
    tipoSlot = 'frio'
  }

  const gapMsg = activo ? Math.min(GAP_MISMO_CHAT_MS, GAP_ACTIVO_MS) : GAP_MISMO_CHAT_MS
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
      chatActivo: activo,
      esAlerta: alerta
    })
    jobIds.push(id)
    offset += gapMsg
  }

  logger.info(
    `📤 Outbox: → ${jid} (${mensajes.length} msg, ${tipoSlot}, inicia ${Math.round((inicio - t) / 1000)}s)`
  )
  return { jobIds, iniciaEn: inicio, chatActivo: activo, esAlerta: alerta, tipoSlot }
}

function encolarTexto(jid, text, opts = {}) {
  return encolarConversacion(jid, [text], opts)
}

function pendiente() {
  return cola.length
}

function pendientePorJid(jid) {
  return cola.filter(j => j.jid === jid).length
}

function tienePendienteTipo(jid, tipoMeta) {
  return cola.some(j => j.jid === jid && j.meta?.tipo === tipoMeta)
}

function cancelarPendientesTipo(jid, tipoMeta) {
  let n = 0
  for (let i = cola.length - 1; i >= 0; i--) {
    if (cola[i].jid === jid && cola[i].meta?.tipo === tipoMeta) {
      cola.splice(i, 1)
      n++
    }
  }
  return n
}

async function procesarUno() {
  if (enviando || !cola.length) return

  const t = ahora()
  // 1) réplicas activas listas  2) cualquier otro listo
  let idx = cola.findIndex(j => j.enviarDespues <= t && j.chatActivo)
  if (idx < 0) idx = cola.findIndex(j => j.enviarDespues <= t && !j.esAlerta)
  if (idx < 0) idx = cola.findIndex(j => j.enviarDespues <= t)
  if (idx < 0) return

  const job = cola[idx]
  const lastJid = ultimoEnvioPorJid.get(job.jid) || 0
  const gapSame = job.chatActivo ? GAP_ACTIVO_MS : GAP_MISMO_CHAT_MS
  const waitSame = lastJid ? gapSame - (t - lastJid) : 0
  // Entre alertas a distintos chats: respetar ~1s mínimo global; activos sin freno global
  const waitGlobal = (!job.chatActivo && ultimoEnvioGlobal)
    ? Math.min(job.esAlerta ? 3000 : 2000, gapSame / 2) - (t - ultimoEnvioGlobal)
    : 0
  const wait = Math.max(0, waitSame, waitGlobal)
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

  // Avisos a no activos: si ya se activó, descartar
  if (job.meta?.tipo === 'aviso_no_activo' && job.usuarioId) {
    try {
      const { db } = require('../db')
      const u = await db.obtenerUsuarioPorId(job.usuarioId)
      if (!u || u.alertas_habilitadas) {
        logger.info(`⏭️ Outbox: omitido aviso_no_activo → ${job.jid} (activado o inexistente)`)
        return
      }
    } catch (err) {
      logger.warn(`aviso_no_activo check: ${err.message}`)
    }
  }

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
    `📬 Outbox: alertas ${GAP_ALERTA_CHAT_MS / 1000}s/usuario · activo ≤${GAP_ACTIVO_MS / 1000}s · ventana activo ${ACTIVO_MS / 60000} min`
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
  pendientePorJid,
  tienePendienteTipo,
  cancelarPendientesTipo,
  jidDeTelefono,
  marcarActividadInbound,
  esChatActivo,
  GAP_ALERTA_CHAT_MS,
  GAP_ACTIVO_MS,
  GAP_ENTRE_CHATS_MS,
  GAP_MISMO_CHAT_MS,
  ACTIVO_MS
}
