/**
 * Historial de conversaciones WhatsApp — persistencia + contexto para el bot.
 */
const { pool } = require('../db')
const { logger } = require('../logger')

function digitos(tel) {
  return String(tel || '').replace(/\D/g, '')
}

function telefonoDeJid(jid) {
  return digitos(String(jid || '').split('@')[0])
}

async function guardarMensaje({
  usuarioId = null,
  telefono = null,
  jid = null,
  direccion,
  tipo = 'text',
  cuerpo = null,
  caption = null,
  intencion = null,
  imeiContexto = null,
  meta = null
}) {
  const tel = digitos(telefono) || telefonoDeJid(jid)
  try {
    const { rows } = await pool.query(
      `INSERT INTO whatsapp_mensajes
         (usuario_id, telefono, jid, direccion, tipo, cuerpo, caption, intencion, imei_contexto, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        usuarioId,
        tel || null,
        jid || null,
        direccion,
        tipo,
        cuerpo,
        caption,
        intencion,
        imeiContexto,
        meta ? JSON.stringify(meta) : null
      ]
    )
    return rows[0]
  } catch (err) {
    logger.warn(`chat-historial guardar: ${err.message}`)
    return null
  }
}

async function guardarEntrante(usuario, jid, cuerpo, { intencion, imeiContexto, meta } = {}) {
  return guardarMensaje({
    usuarioId: usuario?.id,
    telefono: usuario?.telefono,
    jid,
    direccion: 'in',
    tipo: 'text',
    cuerpo,
    intencion,
    imeiContexto,
    meta
  })
}

async function guardarSaliente(jid, { text, caption, tipo = 'text', usuarioId, imeiContexto, meta } = {}) {
  return guardarMensaje({
    usuarioId: usuarioId || null,
    telefono: telefonoDeJid(jid),
    jid,
    direccion: 'out',
    tipo,
    cuerpo: text || caption || null,
    caption: caption || null,
    imeiContexto,
    meta
  })
}

async function listarMensajes({ usuarioId, telefono, limite = 40 } = {}) {
  const params = []
  const where = []
  if (usuarioId) {
    params.push(usuarioId)
    where.push(`usuario_id = $${params.length}`)
  }
  if (telefono) {
    params.push(digitos(telefono))
    where.push(`telefono = $${params.length}`)
  }
  if (!where.length) {
    // Sin filtro: últimos mensajes globales (admin)
    params.push(limite)
    const { rows } = await pool.query(
      `SELECT m.*, u.nombre AS usuario_nombre
       FROM whatsapp_mensajes m
       LEFT JOIN usuarios u ON u.id = m.usuario_id
       ORDER BY m.creado_en DESC
       LIMIT $1`,
      params
    )
    return rows.reverse()
  }
  params.push(limite)
  const { rows } = await pool.query(
    `SELECT m.*, u.nombre AS usuario_nombre
     FROM whatsapp_mensajes m
     LEFT JOIN usuarios u ON u.id = m.usuario_id
     WHERE ${where.join(' AND ')}
     ORDER BY m.creado_en DESC
     LIMIT $${params.length}`,
    params
  )
  return rows.reverse()
}

/** Lista de hilos (por usuario/teléfono) con último mensaje */
async function listarHilos({ limite = 40 } = {}) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (COALESCE(m.usuario_id::text, m.telefono))
       m.usuario_id,
       m.telefono,
       u.nombre AS usuario_nombre,
       u.alertas_habilitadas,
       m.direccion AS ultimo_direccion,
       m.cuerpo AS ultimo_cuerpo,
       m.tipo AS ultimo_tipo,
       m.creado_en AS ultimo_en,
       (SELECT COUNT(*)::int FROM whatsapp_mensajes x
        WHERE (m.usuario_id IS NOT NULL AND x.usuario_id = m.usuario_id)
           OR (m.usuario_id IS NULL AND x.telefono = m.telefono)
       ) AS total_mensajes
     FROM whatsapp_mensajes m
     LEFT JOIN usuarios u ON u.id = m.usuario_id
     ORDER BY COALESCE(m.usuario_id::text, m.telefono), m.creado_en DESC`
  )
  // Ordenar por actividad reciente
  rows.sort((a, b) => new Date(b.ultimo_en) - new Date(a.ultimo_en))
  return rows.slice(0, limite)
}

/**
 * Resumen corto para el motor (últimos N turnos).
 */
async function obtenerContextoChat({ usuarioId, telefono, limite = 12 } = {}) {
  const msgs = await listarMensajes({ usuarioId, telefono, limite })
  const lineas = msgs.map(m => {
    const quien = m.direccion === 'in' ? 'Usuario' : 'Bot'
    const txt = String(m.cuerpo || m.caption || '').replace(/\s+/g, ' ').slice(0, 160)
    return `${quien}: ${txt}`
  })
  const ultimoIn = [...msgs].reverse().find(m => m.direccion === 'in')
  const ultimoOut = [...msgs].reverse().find(m => m.direccion === 'out')
  const sinRespuestaMs = ultimoOut && (!ultimoIn || new Date(ultimoOut.creado_en) > new Date(ultimoIn.creado_en))
    ? Date.now() - new Date(ultimoOut.creado_en).getTime()
    : 0

  return {
    mensajes: msgs,
    resumenTexto: lineas.join('\n'),
    ultimoIn,
    ultimoOut,
    sinRespuestaMs,
    usuarioRespondioTrasUltimoAviso: !!(ultimoIn && ultimoOut && new Date(ultimoIn.creado_en) > new Date(ultimoOut.creado_en))
  }
}

module.exports = {
  guardarMensaje,
  guardarEntrante,
  guardarSaliente,
  listarMensajes,
  listarHilos,
  obtenerContextoChat,
  telefonoDeJid
}
