const { db }     = require('./db')
const { logger } = require('./logger')

// Número normalizado: 51987654321@s.whatsapp.net → 51987654321
function extraerNumero(jid) {
  return jid.replace('@s.whatsapp.net', '').replace('@g.us', '')
}

// Texto principal del mensaje (texto plano o botón)
function extraerTexto(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.buttonsResponseMessage?.selectedDisplayText ||
    ''
  ).trim().toUpperCase()
}

async function manejarMensaje(sock, msg) {
  const jid    = msg.key.remoteJid
  const numero = extraerNumero(jid)
  const texto  = extraerTexto(msg)

  // Solo responder a usuarios internos registrados en la BD
  const usuario = await db.buscarUsuarioPorTelefono(numero)
  if (!usuario) {
    logger.info(`📵 Mensaje ignorado de número no registrado: ${numero}`)
    return
  }

  logger.info(`💬 Mensaje de ${usuario.nombre} (${numero}): "${texto}"`)

  try {
    switch (texto) {

      case 'ESTADO':
      case '1': {
        const equipos = await db.obtenerEquiposPorUsuario(usuario.id)
        if (!equipos.length) {
          await enviar(sock, jid, '📦 No tienes equipos asignados.')
          break
        }
        const lista = equipos.map(e =>
          `*${e.nombre}* (${e.id_equipo})\n` +
          `🌡️ Temp: ${e.temperatura}°C  |  💧 Hum: ${e.humedad}%\n` +
          `📍 ${e.ubicacion}\n` +
          `🕐 Actualizado: ${formatFecha(e.ultima_actualizacion)}`
        ).join('\n\n')
        await enviar(sock, jid, `📦 *Estado de tus equipos:*\n\n${lista}`)
        break
      }

      case 'ALERTAS':
      case '2': {
        const alertas = await db.obtenerAlertasActivas(usuario.id)
        if (!alertas.length) {
          await enviar(sock, jid, '✅ No tienes alertas activas.')
          break
        }
        const lista = alertas.map(a =>
          `🔴 *${a.id_equipo}* — ${a.tipo}\n🕐 ${formatFecha(a.fecha)}`
        ).join('\n')
        await enviar(sock, jid, `⚠️ *Alertas activas:*\n\n${lista}`)
        break
      }

      case 'AYUDA':
      case '0': {
        await enviar(sock, jid,
          `🤖 *ZGroup Bot — Comandos*\n\n` +
          `*1* o *ESTADO*  — Ver tus equipos\n` +
          `*2* o *ALERTAS* — Ver alertas activas\n` +
          `*0* o *AYUDA*   — Este menú`
        )
        break
      }

      default: {
        // Primera interacción: mostrar menú de bienvenida
        await enviar(sock, jid,
          `👋 Hola *${usuario.nombre}*, bienvenido a *ZGroup Bot*.\n\n` +
          `Escribe:\n` +
          `• *ESTADO* — ver estado de equipos\n` +
          `• *ALERTAS* — ver alertas activas\n` +
          `• *AYUDA* — ver todos los comandos`
        )
      }
    }
  } catch (err) {
    logger.error('Error manejando mensaje:', err)
    await enviar(sock, jid, '❌ Ocurrió un error. Intenta nuevamente.')
  }
}

async function enviar(sock, jid, texto) {
  await sock.sendMessage(jid, { text: texto })
}

function formatFecha(fecha) {
  return new Date(fecha).toLocaleString('es-PE', { timeZone: 'America/Lima' })
}

module.exports = { manejarMensaje }
