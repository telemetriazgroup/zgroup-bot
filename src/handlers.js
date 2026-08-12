const { db } = require('./db')
const { logger } = require('./logger')
const { detectarIntencion, parseSilencioHoras } = require('./services/intenciones')
const {
  getContexto,
  setContexto,
  estaMuteado,
  mensajeAyuda,
  mensajeAckOk,
  mensajeResumenEstado,
  mensajeDetalleEquipo,
  resolverEquipoEnTexto,
  listarDispositivosPlanos
} = require('./services/conversacion')
const { encolarConversacion, encolarTexto } = require('./services/outbox')
const { enriquecerDispositivo, calcularRango } = require('./services/estado')
const { analizarYGenerarGrafica } = require('./services/historico')
const {
  enPruebaPendiente,
  procesarRespuestaPrueba,
  RESPUESTAS_REQUERIDAS
} = require('./services/prueba-activacion')
const { guardarEntrante } = require('./services/chat-historial')
const { marcarAckSeguimiento } = require('./services/alerta-seguimiento')

function extraerNumero(jid) {
  return String(jid || '')
    .replace('@s.whatsapp.net', '')
    .replace('@c.us', '')
    .replace('@g.us', '')
    .replace(/\D/g, '')
}

function extraerTexto(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.buttonsResponseMessage?.selectedDisplayText ||
    ''
  ).trim()
}

async function dispositivosUsuario(usuarioId) {
  const { grupos, individuales } = await db.obtenerDispositivosOrganizadosUsuario(usuarioId)
  return { grupos, individuales, planos: listarDispositivosPlanos(grupos, individuales) }
}

async function construirResumen(usuario) {
  const { planos } = await dispositivosUsuario(usuario.id)
  const enriquecidos = []
  for (const d of planos.slice(0, 40)) {
    const e = await enriquecerDispositivo(d)
    e._grupo = d._grupo
    enriquecidos.push(e)
  }
  const conAlerta = enriquecidos.filter(d => d.tiene_alerta || d.rango?.fueraDeRango || d.estado_conexion === 'offline')
  const criticos = conAlerta.slice(0, 5).map(d => ({
    nombre: d.nombre || d.imei,
    imei: d.imei,
    motivo: d.rango?.fueraDeRango
      ? 'fuera de rango'
      : d.estado_conexion === 'offline'
        ? 'offline'
        : 'alerta'
  }))
  return {
    texto: mensajeResumenEstado(usuario, {
      total: planos.length,
      conAlerta: conAlerta.length,
      criticos
    }),
    enriquecidos,
    criticos
  }
}

async function enviarDetalleEquipo(jid, usuario, disp) {
  const d = await enriquecerDispositivo(disp)
  d.rango = d.rango || calcularRango(d)
  setContexto(jid, {
    ultimo_usuario_id: usuario.id,
    ultimo_imei: d.imei,
    ultimo_nombre_equipo: d.nombre || d.imei,
    esperando: 'seguimiento'
  })
  const texto = mensajeDetalleEquipo(d, { grupoNombre: disp._grupo })
  encolarTexto(jid, texto, { prioridad: 2 })
}

async function enviarGrafica(jid, usuario, imei) {
  const disp = await db.obtenerDispositivoPorImei(imei)
  if (!disp) {
    encolarTexto(jid, 'No encuentro ese equipo. Escribe *ESTADO* o el nombre/IMEI.', { prioridad: 2 })
    return
  }
  const d = await enriquecerDispositivo(disp)
  const setRef = d.rango?.setRef ?? d.set_control ?? d.set_point_live
  const delta = d.rango?.delta ?? d.delta ?? 5

  if ((d.link_origen || 'link1') !== 'link1') {
    encolarTexto(
      jid,
      `*${d.nombre || d.imei}* no tiene histórico de 12 h en este enlace. Te dejo el estado:\n` +
        mensajeDetalleEquipo(d),
      { prioridad: 2 }
    )
    return
  }

  encolarTexto(jid, `Voy a revisar la curva de 12 h de *${d.nombre || d.imei}*…`, { prioridad: 2 })

  try {
    const { analisis, imagen } = await analizarYGenerarGrafica(d, { setRef, delta })
    if (!imagen) {
      encolarTexto(jid, 'No pude generar la gráfica ahora. ¿Reintentamos luego o quieres solo *ESTADO*?', { prioridad: 2 })
      return
    }
    const caption =
      `Gráfica 12 h — *${d.nombre || d.imei}*\n` +
      (analisis?.mensajeHoras ? `${analisis.mensajeHoras}\n` : '') +
      `Responde *OK* si ya lo vieron, o *ESTADO* para el resumen.`
    encolarConversacion(jid, [{ tipo: 'image', image: imagen, caption }], { prioridad: 2 })
    setContexto(jid, {
      ultimo_imei: d.imei,
      ultimo_nombre_equipo: d.nombre || d.imei,
      esperando: 'seguimiento'
    })
  } catch (err) {
    logger.error(`GRAFICA ${imei}: ${err.message}`)
    encolarTexto(jid, `No pude armar la gráfica: ${err.message}. Prueba *ESTADO*.`, { prioridad: 2 })
  }
}

async function manejarMensaje(sock, msg) {
  const jid = msg.key.remoteJid
  const numero = extraerNumero(jid)
  const textoRaw = extraerTexto(msg)
  const { intencion, texto, imeiParcial } = detectarIntencion(textoRaw)

  const usuario = await db.buscarUsuarioPorTelefono(numero)
  if (!usuario) {
    logger.info(`📵 Mensaje ignorado de número no registrado: ${numero}`)
    return
  }

  logger.info(`💬 ${usuario.nombre} (${numero}): "${textoRaw}" → ${intencion}`)

  try {
    const ctxPrev = getContexto(jid) || {}
    await guardarEntrante(usuario, jid, textoRaw, {
      intencion,
      imeiContexto: ctxPrev.ultimo_imei || null,
      meta: { raw_from: msg._rawFrom || null }
    })

    // Activación obligatoria: contar respuestas hasta completar la prueba
    if (enPruebaPendiente(usuario)) {
      const r = await procesarRespuestaPrueba(usuario, jid, { textoRaw, intencion })
      if (r.handled) {
        if (r.enriquecerEstado) {
          const { texto: resumen } = await construirResumen(r.usuario || usuario)
          encolarTexto(jid, resumen, { prioridad: 2, usuarioId: usuario.id })
        }
        return
      }
    }

    if (!usuario.alertas_habilitadas && !usuario.prueba_iniciada_en) {
      encolarTexto(
        jid,
        `Hola *${usuario.nombre}*. Aún no activamos este chat para alertas.\n` +
          `ZGroup debe enviarte primero la *prueba de conversación*; luego respondes *${RESPUESTAS_REQUERIDAS} veces* y ya podré avisarte.`,
        { prioridad: 2, usuarioId: usuario.id }
      )
      await db.registrarEventoConversacion(usuario.id, 'mensaje_sin_prueba', {
        detalle: `Mensaje sin prueba iniciada: "${String(textoRaw).slice(0, 120)}"`,
        meta: { intencion }
      })
      return
    }

    if (estaMuteado(jid) && !['activar', 'ayuda', 'estado', 'alertas', 'ok'].includes(intencion)) {
      return
    }

    setContexto(jid, { ultimo_usuario_id: usuario.id, canal: 'privado' })
    const ctx = getContexto(jid) || {}

    await db.registrarEventoConversacion(usuario.id, 'mensaje_usuario', {
      detalle: String(textoRaw).slice(0, 200),
      meta: { intencion }
    })

    switch (intencion) {
      case 'ayuda': {
        encolarTexto(jid, `Hola *${usuario.nombre}*.\n${mensajeAyuda()}`, { prioridad: 2, usuarioId: usuario.id })
        break
      }

      case 'ok': {
        await marcarAckSeguimiento(usuario.id, ctx.ultimo_imei || null, ctx.ultima_alerta_codigo || null)
        encolarTexto(jid, mensajeAckOk(usuario, ctx), { prioridad: 2, usuarioId: usuario.id, imeiContexto: ctx.ultimo_imei })
        setContexto(jid, { esperando: null })
        break
      }

      case 'silencio': {
        const horas = parseSilencioHoras(textoRaw)
        setContexto(jid, { mute_hasta: Date.now() + horas * 3600 * 1000, esperando: null })
        encolarTexto(
          jid,
          `De acuerdo — pauso avisos push ~${horas} h. Sigue pudiendo escribir *ESTADO*. Para reactivar: *avísame*.`,
          { prioridad: 2 }
        )
        break
      }

      case 'activar': {
        setContexto(jid, { mute_hasta: null })
        encolarTexto(jid, 'Listo — vuelvo a avisarte de lo crítico.', { prioridad: 2 })
        break
      }

      case 'grafica': {
        const imei = ctx.ultimo_imei
        if (!imei) {
          encolarTexto(
            jid,
            '¿De qué reefer quieres la gráfica? Escribe el *nombre* o IMEI (o *ESTADO* primero).',
            { prioridad: 2 }
          )
          setContexto(jid, { esperando: 'equipo' })
          break
        }
        await enviarGrafica(jid, usuario, imei)
        break
      }

      case 'estado':
      case 'todos': {
        const { texto: resumen, criticos } = await construirResumen(usuario)
        if (criticos[0]) {
          setContexto(jid, {
            ultimo_imei: criticos[0].imei,
            ultimo_nombre_equipo: criticos[0].nombre,
            esperando: 'seguimiento'
          })
        } else {
          setContexto(jid, { esperando: 'equipo' })
        }
        encolarTexto(jid, resumen, { prioridad: 2 })
        break
      }

      case 'alertas': {
        const alertas = await db.obtenerAlertasActivas(usuario.id)
        if (!alertas.length) {
          encolarTexto(jid, '✅ No tienes alertas activas ahora. Escribe *ESTADO* si quieres el panorama.', { prioridad: 2 })
          break
        }
        const lista = alertas.slice(0, 8).map(a => {
          const equipo = a.equipo_id || a.id_equipo
          return `• *${equipo}* — ${String(a.tipo || '').slice(0, 90)}`
        }).join('\n')
        if (alertas[0]?.equipo_id) {
          setContexto(jid, {
            ultimo_imei: alertas[0].equipo_id,
            ultima_alerta_codigo: alertas[0].codigo,
            esperando: 'seguimiento'
          })
        }
        encolarTexto(
          jid,
          `Tienes *${alertas.length}* aviso(s) activo(s):\n${lista}\n\n¿*GRAFICA* del primero, *detalle* de uno, u *OK*?`,
          { prioridad: 2 }
        )
        break
      }

      case 'mas': {
        if (ctx.ultimo_imei) {
          const d = await db.obtenerDispositivoPorImei(ctx.ultimo_imei)
          if (d) {
            await enviarDetalleEquipo(jid, usuario, d)
            break
          }
        }
        const { texto: resumen } = await construirResumen(usuario)
        encolarTexto(jid, resumen, { prioridad: 2 })
        break
      }

      case 'equipo':
      case 'texto_libre': {
        const { planos } = await dispositivosUsuario(usuario.id)
        const match = resolverEquipoEnTexto(imeiParcial || texto, planos)
        if (match) {
          await enviarDetalleEquipo(jid, usuario, match)
          break
        }
        if (intencion === 'equipo') {
          encolarTexto(jid, 'No ubico ese IMEI en tus asignaciones. Prueba *ESTADO*.', { prioridad: 2 })
          break
        }
        // Charla sin keyword: menú corto (solo privado)
        encolarTexto(
          jid,
          `Hola *${usuario.nombre}*. ${mensajeAyuda()}`,
          { prioridad: 3 }
        )
        break
      }

      default: {
        encolarTexto(jid, mensajeAyuda(), { prioridad: 3 })
      }
    }
  } catch (err) {
    logger.error('Error manejando mensaje:', err)
    try {
      await sock.sendMessage(jid, { text: 'Ocurrió un error. Intenta con *ESTADO* o *AYUDA*.' })
    } catch { /* ignore */ }
  }
}

module.exports = { manejarMensaje }
