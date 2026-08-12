/**
 * Activación obligatoria: el usuario debe responder ≥3 veces a la prueba
 * antes de poder recibir alertas push. Cada paso se registra en conversacion_eventos.
 */
const { db } = require('../db')
const { logger } = require('../logger')
const { encolarTexto, jidDeTelefono } = require('./outbox')
const { nombrePila, setContexto } = require('./conversacion')

const RESPUESTAS_REQUERIDAS = parseInt(process.env.PRUEBA_RESPUESTAS_REQUERIDAS || '3', 10)

function puedeRecibirAlertas(usuario) {
  return !!(usuario && usuario.activo && usuario.alertas_habilitadas)
}

function enPruebaPendiente(usuario) {
  return !!(usuario && usuario.prueba_iniciada_en && !usuario.alertas_habilitadas)
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

/**
 * Procesa una respuesta durante la prueba. Devuelve true si consumió el mensaje
 * (no hay que seguir con el handler normal de intenciones).
 */
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
    encolarTexto(
      jid,
      `Perfecto${nombre ? ` ${nombre}` : ''} — conversación de activación *completa* (${req}/${req}).\n` +
        `Desde ahora sí te enviaré alertas de reefers cuando algo crítico pase.\n` +
        `Puedes escribir *ESTADO*, *GRAFICA*, *ALERTAS* u *OK* cuando quieras.`,
      { prioridad: 1 }
    )
    logger.info(`✅ Prueba completada → ${resultado.nombre} (alertas habilitadas)`)
    return { handled: true, completada: true, usuario: resultado }
  }

  if (n === 1) {
    encolarTexto(
      jid,
      `Gracias${nombre ? ` ${nombre}` : ''} — te leí (*1/${req}*).\n` +
        `*Paso 2:* escribe *ESTADO* para ver un resumen de tus reefers.`,
      { prioridad: 1 }
    )
  } else if (n === 2) {
    const conEstado = intencion === 'estado' || intencion === 'todos'
    encolarTexto(
      jid,
      (conEstado ? `Bien — *2/${req}* anotado.\n` : `Bien — vamos *2/${req}*.\n`) +
        `*Paso 3:* responde *AYUDA* (o *OK*) para cerrar la activación.\n` +
        `Con esa tercera respuesta ya podré avisarte alarmas en el futuro.`,
      { prioridad: 1 }
    )
    return {
      handled: true,
      completada: false,
      usuario: resultado,
      paso: n,
      enriquecerEstado: conEstado
    }
  } else {
    encolarTexto(
      jid,
      `Recibido (*${n}/${req}*). Falta${n === req - 1 ? '' : 'n'} ${req - n} respuesta(s) para activar alertas.`,
      { prioridad: 1 }
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

/** Admin: marcar prueba como aprobada sin las 3 respuestas por WhatsApp */
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
  puedeRecibirAlertas,
  enPruebaPendiente,
  iniciarPrueba,
  mensajesInicioPrueba,
  procesarRespuestaPrueba,
  omitirAlertaPorPrueba,
  aprobarPruebaManual,
  revocarPruebaManual
}
