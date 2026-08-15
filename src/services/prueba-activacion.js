/**
 * Activación obligatoria: el usuario debe responder ≥3 veces a la prueba
 * antes de poder recibir alertas push. Cada paso se registra en conversacion_eventos.
 *
 * Números no activados: aviso diferido (90 s) para contactar a Luis Marcelo.
 * Si ya hay mensajes pendientes en cola, no encolar otra réplica inmediata.
 */
const { db } = require('../db')
const { logger } = require('../logger')
const {
  encolarTexto,
  encolarMensaje,
  jidDeTelefono,
  pendientePorJid,
  tienePendienteTipo
} = require('./outbox')
const { nombrePila, setContexto, getContexto, pick } = require('./conversacion')

const RESPUESTAS_REQUERIDAS = parseInt(process.env.PRUEBA_RESPUESTAS_REQUERIDAS || '3', 10)
const AVISO_NO_ACTIVO_MS = parseInt(process.env.AVISO_NO_ACTIVO_MS || '90000', 10)
const CONTACTO_ACTIVACION_NOMBRE = process.env.CONTACTO_ACTIVACION_NOMBRE || 'Luis Marcelo'
const CONTACTO_ACTIVACION_TEL = process.env.CONTACTO_ACTIVACION_TEL || '908947464'

function puedeRecibirAlertas(usuario) {
  return !!(usuario && usuario.activo && usuario.alertas_habilitadas)
}

function enPruebaPendiente(usuario) {
  return !!(usuario && usuario.prueba_iniciada_en && !usuario.alertas_habilitadas)
}

function mensajesContactoActivacion(usuario) {
  const nombre = nombrePila(usuario?.nombre) || ''
  const quien = CONTACTO_ACTIVACION_NOMBRE
  const tel = CONTACTO_ACTIVACION_TEL
  const pref = nombre ? `${nombre}, ` : ''
  return [
    `${pref}este chat aún *no está activado* para conversación con el monitor ZGroup.\n` +
      `Para habilitarlo, contacta a *${quien}* al *${tel}*.`,
    `${pref}todavía no puedo atenderte aquí: falta la activación.\n` +
      `Escríbele a *${quien}* (*${tel}*) y te habilitan este número.`,
    `Hola${nombre ? ` ${nombre}` : ''} — tu número no tiene conversación activa con el bot.\n` +
      `Coordina con *${quien}* al *${tel}* para la activación.`,
    `${pref}recibí tu mensaje, pero este WhatsApp no está habilitado aún.\n` +
      `Por favor llama o escribe a *${quien}* (*${tel}*).`,
    `Monitor ZGroup: chat pendiente de activación.\n` +
      `${pref}contacta a *${quien}* al *${tel}* para continuar.`
  ]
}

/**
 * Programa aviso (+90 s) a números no activados.
 * Solo si el usuario vuelve a escribir y no hay cooldown / pendiente.
 */
function avisarSiNoActivo(usuario, jid) {
  if (!usuario || usuario.alertas_habilitadas) return { programado: false, motivo: 'ya_activo' }

  if (tienePendienteTipo(jid, 'aviso_no_activo')) {
    logger.info(`⏳ Aviso no-activo ya pendiente → ${usuario.nombre}; no se duplica`)
    return { programado: false, motivo: 'ya_pendiente' }
  }

  const ctx = getContexto(jid) || {}
  const ultimo = ctx.ultimo_aviso_no_activo_en || 0
  const ahora = Date.now()
  if (ultimo && ahora < ultimo) {
    return { programado: false, motivo: 'ya_pendiente' }
  }
  if (ultimo && ahora - ultimo < AVISO_NO_ACTIVO_MS) {
    logger.info(
      `⏳ Aviso no-activo cooldown ${Math.ceil((AVISO_NO_ACTIVO_MS - (ahora - ultimo)) / 1000)}s → ${usuario.nombre}`
    )
    return { programado: false, motivo: 'cooldown' }
  }

  if (pendientePorJid(jid) > 0) {
    logger.info(`⏳ Cola pendiente → ${usuario.nombre}; sin aviso extra (anti doble)`)
    return { programado: false, motivo: 'cola_pendiente' }
  }

  const texto = pick(mensajesContactoActivacion(usuario))
  const enviarDespues = ahora + AVISO_NO_ACTIVO_MS

  encolarMensaje({
    jid,
    tipo: 'text',
    text: texto,
    enviarDespues,
    prioridad: 4,
    usuarioId: usuario.id,
    meta: { tipo: 'aviso_no_activo' },
    chatActivo: false,
    esAlerta: false
  })

  setContexto(jid, {
    ultimo_usuario_id: usuario.id,
    ultimo_aviso_no_activo_en: enviarDespues
  })

  db.registrarEventoConversacion(usuario.id, 'aviso_no_activo_programado', {
    detalle: `Aviso contacto ${CONTACTO_ACTIVACION_NOMBRE} en ${AVISO_NO_ACTIVO_MS / 1000}s`,
    meta: { telefono_contacto: CONTACTO_ACTIVACION_TEL, delay_ms: AVISO_NO_ACTIVO_MS }
  }).catch(() => {})

  logger.info(
    `📨 Aviso no-activo +${AVISO_NO_ACTIVO_MS / 1000}s → ${usuario.nombre} (*${CONTACTO_ACTIVACION_TEL}*)`
  )
  return { programado: true, delayMs: AVISO_NO_ACTIVO_MS }
}

async function iniciarPrueba(usuarioId, { origen = 'test-estado', meta = {} } = {}) {
  const usuario = await db.obtenerUsuarioPorId(usuarioId)
  if (!usuario) throw new Error('Usuario no encontrado')

  if (usuario.alertas_habilitadas) {
    await db.registrarEventoConversacion(usuarioId, 'prueba_reenvio', {
      detalle: 'Usuario ya activado; se reenvía conversación de verificación sin resetear',
      meta: { origen, ...meta }
    })
    return { usuario, reiniciada: false, ya_activado: true }
  }

  const actualizado = await db.iniciarPruebaActivacion(usuarioId)
  await db.registrarEventoConversacion(usuarioId, 'prueba_iniciada', {
    detalle: `Prueba de activación iniciada (${origen}). Se requieren ${RESPUESTAS_REQUERIDAS} respuestas.`,
    meta: { origen, respuestas_requeridas: RESPUESTAS_REQUERIDAS, ...meta }
  })

  const jid = jidDeTelefono(actualizado.telefono)
  setContexto(jid, {
    ultimo_usuario_id: usuarioId,
    esperando: 'prueba_paso_1',
    prueba_activa: true,
    canal: 'privado'
  })

  logger.info(`🧪 Prueba activación iniciada → ${actualizado.nombre} (0/${RESPUESTAS_REQUERIDAS})`)
  return { usuario: actualizado, reiniciada: true, ya_activado: false }
}

function mensajesInicioPrueba(usuario, { totalDisp = 0, criticos = [], yaActivado = false } = {}) {
  const nombre = nombrePila(usuario.nombre) || 'equipo'

  if (yaActivado) {
    return [
      `Hola ${nombre} — ya tienes las alertas activadas.\n` +
        `Sigo en línea en este chat. Escribe *ESTADO*, *GRAFICA* u *OK* cuando quieras.`,
      totalDisp
        ? `Tienes *${totalDisp}* equipo(s) asignados` +
          (criticos.length
            ? `. Revisaría: *${criticos.slice(0, 3).map(c => c.nombre || c.imei).join(', ')}*.`
            : '.')
        : 'Cuando asignen reefers, te avisaré aquí.'
    ]
  }

  const linea1 =
    `Hola ${nombre} — soy el monitor de ZGroup.\n` +
    `Antes de enviarte alarmas reales necesitamos una *conversación corta de activación*.`

  const linea2 =
    `Tienes *${totalDisp}* equipo(s) asignados` +
    (criticos.length
      ? `. Ahora miraría: *${criticos.slice(0, 3).map(c => c.nombre || c.imei).join(', ')}*.`
      : '.') +
    `\nDebes responderme *${RESPUESTAS_REQUERIDAS} veces* en este chat para habilitar avisos.`

  const linea3 =
    `*Paso 1 de ${RESPUESTAS_REQUERIDAS}:* responde *OK* (o “listo”) para confirmar que me lees.\n` +
    `Luego te pediré *ESTADO* y una tercera respuesta. Sin eso no te mandaré alertas.`

  return [linea1, linea2, linea3]
}

function encolarRespuestaPrueba(jid, texto, usuario) {
  if (pendientePorJid(jid) > 0) {
    logger.info(`⏳ Prueba: hay mensaje pendiente → ${usuario.nombre}; no se envía réplica doble`)
    return false
  }
  encolarTexto(jid, texto, { prioridad: 1, usuarioId: usuario.id, meta: { tipo: 'prueba_paso' } })
  return true
}

async function procesarRespuestaPrueba(usuario, jid, { textoRaw, intencion }) {
  if (!enPruebaPendiente(usuario)) return { handled: false }

  const resultado = await db.registrarRespuestaPrueba(usuario.id, {
    texto: textoRaw,
    intencion
  })

  const n = resultado.prueba_respuestas
  const req = RESPUESTAS_REQUERIDAS
  const nombre = nombrePila(resultado.nombre) || ''

  await db.registrarEventoConversacion(usuario.id, 'respuesta_prueba', {
    detalle: `Respuesta ${n}/${req}: "${String(textoRaw).slice(0, 120)}"`,
    meta: { intencion, paso: n, respuestas_requeridas: req }
  })

  setContexto(jid, {
    ultimo_usuario_id: usuario.id,
    prueba_activa: n < req,
    esperando: n < req ? `prueba_paso_${n + 1}` : 'seguimiento'
  })

  if (n >= req && resultado.alertas_habilitadas) {
    await db.registrarEventoConversacion(usuario.id, 'prueba_completada', {
      detalle: `Activación completa: ${req} respuestas. Alertas push habilitadas.`,
      meta: { respuestas: n }
    })
    encolarRespuestaPrueba(
      jid,
      `Perfecto${nombre ? ` ${nombre}` : ''} — conversación de activación *completa* (${req}/${req}).\n` +
        `Desde ahora sí te enviaré alertas de reefers cuando algo crítico pase.\n` +
        `Puedes escribir *ESTADO*, *GRAFICA*, *ALERTAS* u *OK* cuando quieras.`,
      resultado
    )
    logger.info(`✅ Prueba completada → ${resultado.nombre} (alertas habilitadas)`)
    return { handled: true, completada: true, usuario: resultado }
  }

  // Si aún hay mensajes de inicio de prueba en cola, no responder encima (anti doble)
  if (pendientePorJid(jid) > 0) {
    logger.info(`⏳ Prueba paso ${n}: cola pendiente → ${resultado.nombre}; sin réplica extra`)
    return { handled: true, completada: false, usuario: resultado, paso: n, enriquecerEstado: false }
  }

  if (n === 1) {
    encolarRespuestaPrueba(
      jid,
      `Gracias${nombre ? ` ${nombre}` : ''} — te leí (*1/${req}*).\n` +
        `*Paso 2:* escribe *ESTADO* para ver un resumen de tus reefers.`,
      resultado
    )
  } else if (n === 2) {
    const conEstado = intencion === 'estado' || intencion === 'todos'
    encolarRespuestaPrueba(
      jid,
      (conEstado ? `Bien — *2/${req}* anotado.\n` : `Bien — vamos *2/${req}*.\n`) +
        `*Paso 3:* responde *AYUDA* (o *OK*) para cerrar la activación.\n` +
        `Con esa tercera respuesta ya podré avisarte alarmas en el futuro.`,
      resultado
    )
    return {
      handled: true,
      completada: false,
      usuario: resultado,
      paso: n,
      enriquecerEstado: false
    }
  } else {
    encolarRespuestaPrueba(
      jid,
      `Recibido (*${n}/${req}*). Falta${n === req - 1 ? '' : 'n'} ${req - n} respuesta(s) para activar alertas.`,
      resultado
    )
  }

  return { handled: true, completada: false, usuario: resultado, paso: n }
}

async function omitirAlertaPorPrueba(usuario, { imei, codigo } = {}) {
  if (puedeRecibirAlertas(usuario)) return false
  await db.registrarEventoConversacion(usuario.id, 'alerta_bloqueada', {
    detalle: `Alerta omitida: usuario sin activación (${usuario.prueba_respuestas || 0}/${RESPUESTAS_REQUERIDAS})`,
    meta: { imei, codigo, alertas_habilitadas: false }
  })
  logger.info(
    `🚫 Alerta bloqueada → ${usuario.nombre}: falta prueba (${usuario.prueba_respuestas || 0}/${RESPUESTAS_REQUERIDAS})`
  )
  return true
}

async function aprobarPruebaManual(usuarioId, { motivo = 'admin' } = {}) {
  const usuario = await db.obtenerUsuarioPorId(usuarioId)
  if (!usuario) throw new Error('Usuario no encontrado')

  if (usuario.alertas_habilitadas) {
    return { usuario, ya_activado: true }
  }

  const actualizado = await db.aprobarPruebaManual(usuarioId)
  await db.registrarEventoConversacion(usuarioId, 'prueba_aprobada_manual', {
    detalle: `Prueba aprobada manualmente por admin (${motivo}). Alertas push habilitadas.`,
    meta: { origen: 'admin', motivo, respuestas_requeridas: RESPUESTAS_REQUERIDAS }
  })
  logger.info(`✅ Prueba aprobada manual → ${actualizado.nombre}`)
  return { usuario: actualizado, ya_activado: false }
}

async function revocarPruebaManual(usuarioId, { motivo = 'admin' } = {}) {
  const usuario = await db.obtenerUsuarioPorId(usuarioId)
  if (!usuario) throw new Error('Usuario no encontrado')

  const actualizado = await db.revocarPruebaActivacion(usuarioId)
  await db.registrarEventoConversacion(usuarioId, 'prueba_revocada_manual', {
    detalle: `Activación revocada por admin (${motivo}). Deja de recibir alertas push.`,
    meta: { origen: 'admin', motivo }
  })
  logger.info(`⛔ Prueba revocada manual → ${actualizado.nombre}`)
  return { usuario: actualizado }
}

module.exports = {
  RESPUESTAS_REQUERIDAS,
  AVISO_NO_ACTIVO_MS,
  CONTACTO_ACTIVACION_NOMBRE,
  CONTACTO_ACTIVACION_TEL,
  puedeRecibirAlertas,
  enPruebaPendiente,
  iniciarPrueba,
  mensajesInicioPrueba,
  procesarRespuestaPrueba,
  omitirAlertaPorPrueba,
  aprobarPruebaManual,
  revocarPruebaManual,
  avisarSiNoActivo
}
