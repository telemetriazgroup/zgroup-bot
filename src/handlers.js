const { db } = require('./db')
const { logger } = require('./logger')
const { detectarIntencion, parseSilencioHoras } = require('./services/intenciones')
const {
  getContexto,
  setContexto,
  estaMuteado,
  mensajeAckOk,
  mensajeDetalleEquipo,
  resolverEquipoEnTexto,
  listarDispositivosPlanos
} = require('./services/conversacion')
const {
  construirItemsMenu,
  armarPaginaRaiz,
  armarPaginaGrupo,
  resolverSeleccionMenu,
  saludoMenu,
  etiquetaEquipo
} = require('./services/menu-navegacion')
const { encolarConversacion, encolarTexto, marcarActividadInbound } = require('./services/outbox')
const { enriquecerDispositivo, calcularRango } = require('./services/estado')
const { analizarYGenerarGrafica, obtenerUltimosDatos } = require('./services/historico')
const {
  enPruebaPendiente,
  procesarRespuestaPrueba,
  avisarSiNoActivo
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
  return {
    grupos,
    individuales,
    planos: listarDispositivosPlanos(grupos, individuales),
    items: construirItemsMenu(grupos, individuales)
  }
}

function guardarMenuCtx(jid, usuario, pagina, { extra = {} } = {}) {
  setContexto(jid, {
    ultimo_usuario_id: usuario.id,
    menu_vista: pagina.menu_vista,
    menu_page: pagina.menu_page,
    menu_grupo_id: pagina.menu_grupo_id ?? null,
    menu_grupo_nombre: pagina.menu_grupo_nombre || null,
    menu_opciones: pagina.opciones,
    esperando: 'menu',
    ...extra
  })
}

async function enviarMenuRaiz(jid, usuario, { page = 0, vuelta = false, conSaludo = false } = {}) {
  const { items } = await dispositivosUsuario(usuario.id)
  const pagina = armarPaginaRaiz(items, page, { vuelta })
  const pref = conSaludo ? saludoMenu(usuario, { primera: true }) : ''
  guardarMenuCtx(jid, usuario, pagina, {
    extra: { ultimo_imei: null, menu_grupo_id: null }
  })
  encolarTexto(jid, `${pref}${pagina.texto}`, { prioridad: 2, usuarioId: usuario.id })
}

async function enviarMenuGrupo(jid, usuario, grupoItem, { page = 0 } = {}) {
  const pagina = armarPaginaGrupo(grupoItem, page)
  guardarMenuCtx(jid, usuario, pagina)
  encolarTexto(jid, pagina.texto, { prioridad: 2, usuarioId: usuario.id })
}

async function abrirGrupoPorId(jid, usuario, grupoId, { page = 0 } = {}) {
  const { items } = await dispositivosUsuario(usuario.id)
  const grupoItem = items.find(it => it.tipo === 'grupo' && Number(it.id) === Number(grupoId))
  if (!grupoItem) {
    encolarTexto(jid, 'No encuentro ese grupo. Te dejo el menú general.', { prioridad: 2 })
    await enviarMenuRaiz(jid, usuario, { vuelta: true })
    return
  }
  await enviarMenuGrupo(jid, usuario, grupoItem, { page })
}

async function enviarDetalleEquipo(jid, usuario, disp, { desdeGrupo = null } = {}) {
  const d = await enriquecerDispositivo(disp)
  d.rango = d.rango || calcularRango(d)
  const grupoNombre = desdeGrupo || disp._grupo || null
  setContexto(jid, {
    ultimo_usuario_id: usuario.id,
    ultimo_imei: d.imei,
    ultimo_nombre_equipo: etiquetaEquipo(d),
    menu_vista: 'dispositivo',
    menu_grupo_id: desdeGrupo ? (getContexto(jid)?.menu_grupo_id || null) : getContexto(jid)?.menu_grupo_id || null,
    menu_grupo_nombre: grupoNombre,
    menu_opciones: [],
    esperando: 'seguimiento'
  })
  const texto = mensajeDetalleEquipo(d, { grupoNombre, conOpciones: true })
  encolarTexto(jid, texto, { prioridad: 2, usuarioId: usuario.id, imeiContexto: d.imei })
}

async function enviarGrafica(jid, usuario, imei) {
  const disp = await db.obtenerDispositivoPorImei(imei)
  if (!disp) {
    encolarTexto(jid, 'No encuentro ese equipo. Escribe *estado* o el código *ZGRU…*.', { prioridad: 2 })
    return
  }
  const d = await enriquecerDispositivo(disp)
  const setRef = d.rango?.setRef ?? d.set_control ?? d.set_point_live
  const delta = d.rango?.delta ?? d.delta ?? 5
  const nombre = etiquetaEquipo(d)

  if ((d.link_origen || 'link1') !== 'link1') {
    encolarTexto(
      jid,
      `*${nombre}* no tiene histórico de 12 h en este enlace. Te dejo el estado:\n` +
        mensajeDetalleEquipo(d),
      { prioridad: 2 }
    )
    return
  }

  encolarTexto(jid, `Voy a revisar la curva de 12 h de *${nombre}*…`, { prioridad: 2 })

  try {
    const { analisis, imagen, rango } = await analizarYGenerarGrafica(d, { setRef, delta })
    if (!imagen) {
      encolarTexto(jid, 'No pude generar la gráfica ahora. ¿*ACTUALIZAR* estado o *TODOS*?', { prioridad: 2 })
      return
    }
    const banda = rango?.min != null
      ? `Rango ${rango.origen}: ${rango.min}…${rango.max} °C` +
        (rango.setControl != null ? ` (set ${rango.setControl})` : '')
      : null
    const caption =
      `Gráfica 12 h — *${nombre}*\n` +
      (banda ? `${banda}\n` : '') +
      (analisis?.mensajeHoras ? `${analisis.mensajeHoras}\n` : '') +
      `*OK* si ya lo vieron · *ULTIMOS* · *ACTUALIZAR* · *TODOS*`
    encolarConversacion(jid, [{ tipo: 'image', image: imagen, caption }], {
      prioridad: 2,
      usuarioId: usuario.id,
      imeiContexto: d.imei
    })
    setContexto(jid, {
      ultimo_imei: d.imei,
      ultimo_nombre_equipo: nombre,
      menu_vista: 'dispositivo',
      esperando: 'seguimiento'
    })
  } catch (err) {
    logger.error(`GRAFICA ${imei}: ${err.message}`)
    encolarTexto(jid, `No pude armar la gráfica: ${err.message}. Prueba *ACTUALIZAR* o *TODOS*.`, { prioridad: 2 })
  }
}

async function enviarUltimosDatos(jid, usuario, imei) {
  const disp = await db.obtenerDispositivoPorImei(imei)
  if (!disp) {
    encolarTexto(jid, 'No tengo un equipo en contexto. Elige uno del menú (*estado*).', { prioridad: 2 })
    return
  }
  const nombre = etiquetaEquipo(disp)
  if ((disp.link_origen || 'link1') !== 'link1') {
    encolarTexto(jid, `*${nombre}* no tiene histórico en este enlace. Prueba *ACTUALIZAR*.`, { prioridad: 2 })
    return
  }
  try {
    const { lineas, total } = await obtenerUltimosDatos(disp, { limit: 10 })
    if (!total) {
      encolarTexto(jid, `Sin puntos recientes para *${nombre}*.`, { prioridad: 2 })
      return
    }
    encolarTexto(
      jid,
      `Últimos *${total}* datos — *${nombre}* (hora Lima):\n${lineas.join('\n')}\n\n¿*GRAFICA*, *ACTUALIZAR* o *TODOS*?`,
      { prioridad: 2, usuarioId: usuario.id, imeiContexto: imei }
    )
    setContexto(jid, {
      ultimo_imei: imei,
      ultimo_nombre_equipo: nombre,
      menu_vista: 'dispositivo',
      esperando: 'seguimiento'
    })
  } catch (err) {
    logger.error(`ULTIMOS ${imei}: ${err.message}`)
    encolarTexto(jid, `No pude leer los últimos datos: ${err.message}`, { prioridad: 2 })
  }
}

async function manejarNavegacionMenu(jid, usuario, textoRaw, intencion) {
  const ctx = getContexto(jid) || {}
  const sel = resolverSeleccionMenu(textoRaw, ctx)

  // Intenciones explícitas de navegación / acciones de dispositivo
  if (intencion === 'todos' || sel?.accion === 'raiz') {
    await enviarMenuRaiz(jid, usuario, { vuelta: true })
    return true
  }

  if (intencion === 'ver_mas' || sel?.accion === 'ver_mas') {
    const vista = ctx.menu_vista || 'raiz'
    const nextPage = (ctx.menu_page || 0) + 1
    if (vista === 'grupo' && ctx.menu_grupo_id) {
      await abrirGrupoPorId(jid, usuario, ctx.menu_grupo_id, { page: nextPage })
    } else {
      await enviarMenuRaiz(jid, usuario, { page: nextPage, vuelta: true })
    }
    return true
  }

  if (intencion === 'anterior' || sel?.accion === 'anterior') {
    const vista = ctx.menu_vista
    if (vista === 'dispositivo') {
      if (ctx.menu_grupo_id) {
        await abrirGrupoPorId(jid, usuario, ctx.menu_grupo_id, { page: 0 })
      } else {
        await enviarMenuRaiz(jid, usuario, { vuelta: true })
      }
      return true
    }
    if (vista === 'grupo') {
      const page = ctx.menu_page || 0
      if (page > 0) {
        await abrirGrupoPorId(jid, usuario, ctx.menu_grupo_id, { page: page - 1 })
      } else {
        await enviarMenuRaiz(jid, usuario, { vuelta: true })
      }
      return true
    }
    if (vista === 'raiz' && (ctx.menu_page || 0) > 0) {
      await enviarMenuRaiz(jid, usuario, { page: (ctx.menu_page || 0) - 1, vuelta: true })
      return true
    }
    await enviarMenuRaiz(jid, usuario, { vuelta: true })
    return true
  }

  if (intencion === 'actualizar' || sel?.accion === 'actualizar') {
    if (!ctx.ultimo_imei) {
      await enviarMenuRaiz(jid, usuario, { conSaludo: false })
      return true
    }
    const d = await db.obtenerDispositivoPorImei(ctx.ultimo_imei)
    if (!d) {
      encolarTexto(jid, 'Ese equipo ya no está en tu lista. Te muestro el menú.', { prioridad: 2 })
      await enviarMenuRaiz(jid, usuario, { vuelta: true })
      return true
    }
    await enviarDetalleEquipo(jid, usuario, d, { desdeGrupo: ctx.menu_grupo_nombre })
    return true
  }

  if (intencion === 'ultimos' || sel?.accion === 'ultimos') {
    if (!ctx.ultimo_imei) {
      encolarTexto(jid, 'Primero elige un equipo del menú (número o *ZGRU…*).', { prioridad: 2 })
      await enviarMenuRaiz(jid, usuario)
      return true
    }
    await enviarUltimosDatos(jid, usuario, ctx.ultimo_imei)
    return true
  }

  if (sel?.accion === 'zgru' || (sel?.accion === 'opcion' && sel.opcion?.tipo === 'dispositivo')) {
    // handled below with opcion / zgru
  }

  if (sel?.accion === 'opcion_invalida') {
    encolarTexto(
      jid,
      `Esa opción no está en la lista. Elige 1–${(ctx.menu_opciones || []).length} o escribe *todos*.`,
      { prioridad: 2 }
    )
    return true
  }

  if (sel?.accion === 'opcion' && sel.opcion) {
    const op = sel.opcion
    if (op.tipo === 'grupo') {
      await abrirGrupoPorId(jid, usuario, op.id, { page: 0 })
      return true
    }
    if (op.tipo === 'dispositivo') {
      const disp = op.dispositivo || (await db.obtenerDispositivoPorImei(op.imei))
      if (!disp) {
        encolarTexto(jid, 'No pude abrir ese equipo. Prueba *todos*.', { prioridad: 2 })
        return true
      }
      await enviarDetalleEquipo(jid, usuario, { ...disp, _grupo: op.grupoNombre || ctx.menu_grupo_nombre }, {
        desdeGrupo: op.grupoNombre || ctx.menu_grupo_nombre
      })
      return true
    }
  }

  if (sel?.accion === 'zgru') {
    const { planos } = await dispositivosUsuario(usuario.id)
    const match = resolverEquipoEnTexto(sel.codigo || textoRaw, planos)
    if (match) {
      await enviarDetalleEquipo(jid, usuario, match)
      return true
    }
    encolarTexto(jid, `No ubico *${sel.codigo}* en tus asignaciones. Mira el menú con *estado*.`, { prioridad: 2 })
    return true
  }

  // Número sin menú cargado → abrir menú
  if (intencion === 'opcion_num' && !ctx.menu_opciones?.length) {
    await enviarMenuRaiz(jid, usuario, { conSaludo: true })
    return true
  }

  return false
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

  marcarActividadInbound(jid)
  logger.info(`💬 ${usuario.nombre} (${numero}): "${textoRaw}" → ${intencion}`)

  try {
    const ctxPrev = getContexto(jid) || {}
    await guardarEntrante(usuario, jid, textoRaw, {
      intencion,
      imeiContexto: ctxPrev.ultimo_imei || null,
      meta: { raw_from: msg._rawFrom || null }
    })

    if (enPruebaPendiente(usuario)) {
      const r = await procesarRespuestaPrueba(usuario, jid, { textoRaw, intencion })
      if (r.handled) {
        if (r.enriquecerEstado) {
          await enviarMenuRaiz(jid, r.usuario || usuario, { conSaludo: true })
        }
        return
      }
    }

    // Número registrado pero sin conversación activada → aviso diferido (90 s) a Luis Marcelo
    if (!usuario.alertas_habilitadas) {
      avisarSiNoActivo(usuario, jid)
      await db.registrarEventoConversacion(usuario.id, 'mensaje_sin_activacion', {
        detalle: `Mensaje sin activación: "${String(textoRaw).slice(0, 120)}"`,
        meta: { intencion }
      })
      return
    }

    if (
      estaMuteado(jid) &&
      !['activar', 'ayuda', 'estado', 'alertas', 'ok', 'todos', 'anterior'].includes(intencion)
    ) {
      return
    }

    setContexto(jid, { ultimo_usuario_id: usuario.id, canal: 'privado' })
    const ctx = getContexto(jid) || {}

    await db.registrarEventoConversacion(usuario.id, 'mensaje_usuario', {
      detalle: String(textoRaw).slice(0, 200),
      meta: { intencion }
    })

    // Navegación de menú / acciones de dispositivo (número, anterior, ver más, etc.)
    const navIntents = [
      'todos', 'ver_mas', 'anterior', 'actualizar', 'ultimos', 'opcion_num'
    ]
    if (
      navIntents.includes(intencion) ||
      ctx.esperando === 'menu' ||
      (ctx.menu_opciones?.length && /^\d{1,2}$/.test(String(textoRaw).trim()))
    ) {
      const handled = await manejarNavegacionMenu(jid, usuario, textoRaw, intencion)
      if (handled) return
    }

    // Acciones con equipo en contexto aunque no vengan por navIntents
    if (['actualizar', 'ultimos'].includes(intencion)) {
      const handled = await manejarNavegacionMenu(jid, usuario, textoRaw, intencion)
      if (handled) return
    }

    switch (intencion) {
      case 'ayuda':
      case 'estado': {
        await enviarMenuRaiz(jid, usuario, { conSaludo: true, page: 0 })
        break
      }

      case 'ok': {
        await marcarAckSeguimiento(usuario.id, ctx.ultimo_imei || null, ctx.ultima_alerta_codigo || null)
        encolarTexto(jid, mensajeAckOk(usuario, ctx), {
          prioridad: 2,
          usuarioId: usuario.id,
          imeiContexto: ctx.ultimo_imei
        })
        setContexto(jid, { esperando: ctx.menu_vista === 'dispositivo' ? 'seguimiento' : 'menu' })
        break
      }

      case 'silencio': {
        const horas = parseSilencioHoras(textoRaw)
        setContexto(jid, { mute_hasta: Date.now() + horas * 3600 * 1000, esperando: null })
        encolarTexto(
          jid,
          `De acuerdo — pauso avisos push ~${horas} h. Sigue pudiendo escribir *estado*. Para reactivar: *avísame*.`,
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
            '¿De qué reefer quieres la gráfica? Elige del menú o escribe el *ZGRU…*.',
            { prioridad: 2 }
          )
          await enviarMenuRaiz(jid, usuario)
          break
        }
        await enviarGrafica(jid, usuario, imei)
        break
      }

      case 'alertas': {
        const alertas = await db.obtenerAlertasActivas(usuario.id)
        if (!alertas.length) {
          encolarTexto(
            jid,
            'No tienes alertas activas ahora. Te dejo el menú de equipos.',
            { prioridad: 2 }
          )
          await enviarMenuRaiz(jid, usuario, { vuelta: true })
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
            menu_vista: 'dispositivo',
            esperando: 'seguimiento'
          })
        }
        encolarTexto(
          jid,
          `Tienes *${alertas.length}* aviso(s) activo(s):\n${lista}\n\n¿*GRAFICA*, *ACTUALIZAR*, u *OK*? También *TODOS* para el menú.`,
          { prioridad: 2 }
        )
        break
      }

      case 'mas': {
        if (ctx.ultimo_imei) {
          const d = await db.obtenerDispositivoPorImei(ctx.ultimo_imei)
          if (d) {
            await enviarDetalleEquipo(jid, usuario, d, { desdeGrupo: ctx.menu_grupo_nombre })
            break
          }
        }
        await enviarMenuRaiz(jid, usuario, { vuelta: true })
        break
      }

      case 'equipo':
      case 'texto_libre': {
        // Si hay menú y escribieron un número raro ya se manejó; intentar ZGRU/nombre
        const { planos } = await dispositivosUsuario(usuario.id)
        const match = resolverEquipoEnTexto(imeiParcial || texto || textoRaw, planos)
        if (match) {
          await enviarDetalleEquipo(jid, usuario, match)
          break
        }

        // Selección de menú por texto libre (por si no entró al bloque nav)
        const handled = await manejarNavegacionMenu(jid, usuario, textoRaw, intencion)
        if (handled) break

        if (intencion === 'equipo') {
          encolarTexto(
            jid,
            'No ubico ese código en tus asignaciones. Te muestro el menú.',
            { prioridad: 2 }
          )
          await enviarMenuRaiz(jid, usuario, { vuelta: true })
          break
        }

        await enviarMenuRaiz(jid, usuario, { conSaludo: true })
        break
      }

      default: {
        await enviarMenuRaiz(jid, usuario, { conSaludo: true })
      }
    }
  } catch (err) {
    logger.error('Error manejando mensaje:', err)
    try {
      await sock.sendMessage(jid, { text: 'Ocurrió un error. Intenta con *estado* o *hola*.' })
    } catch { /* ignore */ }
  }
}

module.exports = { manejarMensaje }
