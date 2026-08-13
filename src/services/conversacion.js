/**
 * Memoria corta de conversación + plantillas de tono humano.
 */
const { normalizar, quitarTildes } = require('./intenciones')

/** @type {Map<string, object>} */
const contextos = new Map()
const TTL_MS = 90 * 60 * 1000

const SALUDOS = ['Hola', 'Buenas', 'Hola de nuevo']

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function nombrePila(nombre) {
  if (!nombre) return ''
  return String(nombre).trim().split(/\s+/)[0]
}

function getContexto(chatId) {
  const c = contextos.get(chatId)
  if (!c) return null
  if (Date.now() - (c.actualizado_en || 0) > TTL_MS) {
    contextos.delete(chatId)
    return null
  }
  return c
}

function setContexto(chatId, patch) {
  const prev = getContexto(chatId) || { chat_id: chatId }
  const next = {
    ...prev,
    ...patch,
    chat_id: chatId,
    actualizado_en: Date.now()
  }
  contextos.set(chatId, next)
  return next
}

function estaMuteado(chatId) {
  const c = getContexto(chatId)
  return !!(c?.mute_hasta && c.mute_hasta > Date.now())
}

function mensajePruebaConexion(usuario, { totalDisp = 0, criticos = [] } = {}) {
  const nombre = nombrePila(usuario.nombre) || 'equipo'
  const saludo = pick(SALUDOS)
  const linea1 =
    `${saludo} ${nombre} — soy el monitor de ZGroup.\n` +
    `Quedaré en línea en este chat para avisarte si un reefer se sale de rango o pierde conexión.`

  let linea2 =
    `Tienes *${totalDisp}* equipo(s) asignado(s) a tu usuario.`
  if (criticos.length) {
    const lista = criticos.slice(0, 3).map(c => c.nombre || c.imei).join(', ')
    linea2 += `\nAhora mismo revisaría: *${lista}*.`
  } else {
    linea2 += `\nPor ahora no veo alertas críticas en tu lista.`
  }

  const linea3 =
    `Cuando quieras, escribe *ESTADO*, el nombre del reefer, *GRAFICA* o *OK*.\n` +
    `No te mandaré ráfagas: te aviso de lo importante y el detalle lo pides tú.`

  return [linea1, linea2, linea3]
}

function mensajeAvisoAlerta(usuario, {
  nombreEquipo,
  imei,
  quePaso,
  datoClave,
  grupoNombre
} = {}) {
  const nombre = nombrePila(usuario.nombre) || ''
  const saludo = pick(['Hola', 'Buenas', 'Aviso rápido'])
  const equipo = nombreEquipo || imei
  const grupo = grupoNombre ? ` (${grupoNombre})` : ''
  const pref = nombre ? `${saludo} ${nombre}` : saludo

  return (
    `${pref} — aviso del reefer *${equipo}*${grupo}.\n` +
    `${quePaso}` +
    (datoClave ? `\n${datoClave}` : '') +
    `\n\n¿Lo revisan en planta? Responde *OK*, *GRAFICA* o *ESTADO*.`
  )
}

function mensajeAckOk(usuario, ctx) {
  const nombre = nombrePila(usuario.nombre) || ''
  const equipo = ctx?.ultimo_nombre_equipo || ctx?.ultimo_imei
  if (equipo) {
    return pick([
      `Gracias${nombre ? ` ${nombre}` : ''} — dejo *${equipo}* en seguimiento. ¿*GRAFICA*, *ULTIMOS* o *TODOS*?`,
      `Perfecto${nombre ? ` ${nombre}` : ''} — *${equipo}* queda anotado. *Actualizar*, *gráfica* o *todos* para el menú.`,
      `Ok${nombre ? ` ${nombre}` : ''} — seguimiento en *${equipo}*. También puedes pedir *últimos* o volver con *todos*.`
    ])
  }
  return pick([
    `Perfecto${nombre ? ` ${nombre}` : ''} — quedo atento. Escribe *estado* para el menú.`,
    `Listo${nombre ? ` ${nombre}` : ''}. Cuando quieras, *hola* o *estado* y navegas tus equipos.`
  ])
}

function mensajeAyuda() {
  return (
    `Puedes navegar así:\n` +
    `• *hola* / *estado* → menú de grupos y equipos\n` +
    `• número de la lista o código *ZGRU…*\n` +
    `• *gráfica* · *últimos* · *actualizar* · *todos*\n` +
    `• *silencio 2h* si no quieres avisos un rato`
  )
}

function mensajeResumenEstado(usuario, { total, conAlerta, criticos }) {
  const nombre = nombrePila(usuario.nombre) || ''
  const saludo = pick(SALUDOS)
  let msg =
    `${saludo}${nombre ? ` ${nombre}` : ''} — tienes *${total}* reefer(s) asignados`
  if (conAlerta > 0) msg += `; *${conAlerta}* con alerta`
  msg += '.\n'

  if (criticos?.length) {
    const top = criticos.slice(0, 3).map(c => {
      const n = c.nombre || c.imei
      const motivo = c.motivo || 'alerta'
      return `• ${n} (${motivo})`
    }).join('\n')
    msg += `Los que miraría primero:\n${top}\n`
  } else {
    msg += `Sin alertas críticas en este momento.\n`
  }
  msg += `\n¿Detalle de alguno? Escribe el *nombre*, IMEI, *TODOS*, *GRAFICA* u *OK*.`
  return msg
}

function mensajeDetalleEquipo(d, { grupoNombre, conOpciones = true } = {}) {
  const nombre = d.nombre || d.imei
  const r = d.rango || {}
  const lineas = [
    `*${nombre}* — ${(d.estado_conexion || 'unknown').toUpperCase()}`
  ]
  if (grupoNombre) lineas[0] += ` · ${grupoNombre}`

  if (r.sensorVal != null && (r.min != null || r.setRef != null)) {
    if (r.origen === 'ztrack' && r.min != null && r.max != null) {
      lineas.push(
        `${r.sensorNombre || 'Sensor'}: *${r.sensorVal} °C* · rango ztrack ${r.min}…${r.max} °C` +
          (r.setRef != null ? ` (set ${r.setRef})` : '')
      )
    } else if (r.setRef != null) {
      lineas.push(
        `${r.sensorNombre || 'Sensor'}: *${r.sensorVal} °C* · set *${r.setRef} °C* (±${r.delta ?? 5})`
      )
    }
    if (r.fueraDeRango) lineas.push(`Está *fuera de rango*.`)
  } else if (d.return_air != null) {
    lineas.push(`Retorno: *${d.return_air} °C* · set ${d.set_point_live ?? 'N/A'} °C`)
  }

  if (d.ultimo_dato) {
    try {
      const f = new Date(d.ultimo_dato).toLocaleString('es-PE', { timeZone: 'America/Lima' })
      lineas.push(`Último dato: ${f}`)
    } catch { /* ignore */ }
  }
  if (conOpciones) {
    lineas.push(`¿*GRAFICA*, *ULTIMOS*, *ACTUALIZAR* o *TODOS*?`)
  }
  return lineas.join('\n')
}

function codigoATextoHumano(codigo) {
  const map = {
    fuera_de_rango: 'está fuera de rango',
    offline: 'no tiene conexión / dejó de reportar',
    wait: 'hace rato no manda datos',
    cambio_setpoint: 'cambiaron el set point',
    online: 'volvió a conectar'
  }
  return map[codigo] || codigo
}

/**
 * Busca equipo por nombre o IMEI parcial entre los asignados al usuario.
 */
function resolverEquipoEnTexto(texto, dispositivos) {
  const n = normalizar(texto)
  if (!dispositivos?.length) return null

  // Código cliente ZGRU… (prioridad sobre IMEI)
  const zgru =
    (n.match(/\bzgru\s*[-_]?\s*(\d{4,})\b/) || [])[0] ||
    (n.match(/\b(zgru\d{4,})\b/) || [])[0]
  if (zgru) {
    const code = normalizar(zgru).replace(/\s+/g, '').replace(/[-_]/g, '')
    const byZ = dispositivos.find(d => {
      const nom = normalizar(d.nombre || '').replace(/[-_\s]/g, '')
      return nom.includes(code) || code.includes(nom.slice(0, code.length))
    })
    if (byZ) return byZ
  }

  const digits = (n.match(/\d{6,}/) || [])[0]
  if (digits) {
    const byImei = dispositivos.find(d => String(d.imei).includes(digits))
    if (byImei) return byImei
    // También dígitos del ZGRU sin prefijo
    const byNomDig = dispositivos.find(d => normalizar(d.nombre || '').includes(digits))
    if (byNomDig) return byNomDig
  }

  let best = null
  let bestScore = 0
  for (const d of dispositivos) {
    const nom = normalizar(d.nombre || '')
    const imei = normalizar(d.imei || '')
    if (!nom && !imei) continue
    if (nom && (n.includes(nom) || nom.includes(n))) {
      const score = nom.length
      if (score > bestScore) { best = d; bestScore = score }
    }
    const tokens = nom.split(/[\s\-_]+/).filter(t => t.length >= 3)
    const hits = tokens.filter(t => n.includes(t)).length
    if (hits && hits * 10 > bestScore) {
      best = d
      bestScore = hits * 10
    }
  }
  return best
}

function listarDispositivosPlanos(grupos, individuales) {
  const out = []
  for (const g of grupos || []) {
    for (const d of g.dispositivos || []) {
      out.push({ ...d, _grupo: g.nombre })
    }
  }
  for (const d of individuales || []) {
    out.push({ ...d, _grupo: 'Individual' })
  }
  return out
}

module.exports = {
  getContexto,
  setContexto,
  estaMuteado,
  nombrePila,
  pick,
  mensajePruebaConexion,
  mensajeAvisoAlerta,
  mensajeAckOk,
  mensajeAyuda,
  mensajeResumenEstado,
  mensajeDetalleEquipo,
  codigoATextoHumano,
  resolverEquipoEnTexto,
  listarDispositivosPlanos,
  quitarTildes,
  normalizar
}
