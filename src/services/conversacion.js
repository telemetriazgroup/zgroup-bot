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
    return `Gracias${nombre ? ` ${nombre}` : ''} — dejo *${equipo}* en seguimiento. Si necesitan números, escriban *ESTADO* o *GRAFICA*.`
  }
  return `Perfecto${nombre ? ` ${nombre}` : ''} — quedo atento. Escribe *ESTADO* cuando quieras el resumen.`
}

function mensajeAyuda() {
  return (
    `Puedes escribirme como en el día a día:\n` +
    `• *estado* o “cómo están los reefers”\n` +
    `• nombre o IMEI del equipo\n` +
    `• *gráfica* / *alertas* / *ok*\n` +
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

function mensajeDetalleEquipo(d, { grupoNombre } = {}) {
  const nombre = d.nombre || d.imei
  const r = d.rango || {}
  const lineas = [
    `*${nombre}* — ${(d.estado_conexion || 'unknown').toUpperCase()}`
  ]
  if (grupoNombre) lineas[0] += ` · ${grupoNombre}`

  if (r.sensorVal != null && r.setRef != null) {
    lineas.push(
      `${r.sensorNombre || 'Sensor'}: *${r.sensorVal} °C* · set *${r.setRef} °C* (±${r.delta ?? 5})`
    )
    if (r.fueraDeRango) lineas.push(`Está *fuera de rango*.`)
  } else if (d.return_air != null) {
    lineas.push(`Retorno: *${d.return_air} °C* · set ${d.set_point_live ?? 'N/A'} °C`)
  }

  if (d.last_ip) lineas.push(`Última IP: ${d.last_ip}`)
  lineas.push(`¿*GRAFICA*, *ALERTAS* u *OK*?`)
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

  const digits = (n.match(/\d{6,}/) || [])[0]
  if (digits) {
    const byImei = dispositivos.find(d => String(d.imei).includes(digits))
    if (byImei) return byImei
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
    // tokens del nombre
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
