/**
 * Seguimiento de alertas: umbrales configurables, reavisos naturales, ack.
 */
const { pool } = require('../db')
const { logger } = require('../logger')
const { nombrePila } = require('./conversacion')
const { obtenerContextoChat } = require('./chat-historial')

function diaLima(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d)
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function leerUmbrales(config) {
  const minMinutos = Math.max(15, parseInt(config?.fuera_rango_minutos_min ?? 120, 10) || 120)
  const pasoHoras = Math.max(0.5, parseFloat(config?.reaviso_paso_horas ?? 1) || 1)
  const maxHorasDia = Math.max(minMinutos / 60, parseFloat(config?.reaviso_max_horas_dia ?? 20) || 20)
  return {
    minMinutos,
    minHoras: minMinutos / 60,
    pasoHoras,
    maxHorasDia,
    avisarEnRango: config?.alerta_en_rango !== false,
    avisarOnline: config?.alerta_online === true
  }
}

/**
 * Decide si corresponde notificar según horas continuas fuera de rango.
 * @returns {{ notificar: boolean, umbral: number, esPrimera: boolean, esReaviso: boolean } | null}
 */
function decidirNotificacionFuera(horasContinuas, seguimiento, umbrales) {
  const { minHoras, pasoHoras, maxHorasDia } = umbrales
  if (horasContinuas < minHoras) {
    return { notificar: false, umbral: 0, esPrimera: false, esReaviso: false, motivo: 'bajo_umbral' }
  }
  if (horasContinuas > maxHorasDia) {
    // Ya pasó el tope del día: solo notificar si nunca se avisó el tope
    const ultimo = parseFloat(seguimiento?.ultimo_umbral_horas || 0)
    if (ultimo >= maxHorasDia) {
      return { notificar: false, umbral: maxHorasDia, esPrimera: false, esReaviso: false, motivo: 'tope_dia' }
    }
    return { notificar: true, umbral: maxHorasDia, esPrimera: !seguimiento?.ultima_notificacion_en, esReaviso: !!seguimiento?.ultima_notificacion_en }
  }

  // Umbral a cruzar: min, luego min+paso, min+2*paso... floor to hours for messaging
  const ultimo = parseFloat(seguimiento?.ultimo_umbral_horas || 0)
  let siguiente = minHoras
  while (siguiente <= ultimo + 0.001) {
    siguiente += pasoHoras
  }
  if (siguiente > maxHorasDia) siguiente = maxHorasDia

  if (horasContinuas + 0.001 >= siguiente && siguiente > ultimo) {
    return {
      notificar: true,
      umbral: Math.round(siguiente * 100) / 100,
      esPrimera: !seguimiento?.ultima_notificacion_en,
      esReaviso: !!seguimiento?.ultima_notificacion_en
    }
  }
  return { notificar: false, umbral: ultimo, esPrimera: false, esReaviso: false, motivo: 'esperando_siguiente' }
}

async function obtenerSeguimientoActivo(usuarioId, imei, codigo) {
  const { rows } = await pool.query(
    `SELECT * FROM alerta_seguimiento
     WHERE usuario_id = $1 AND imei = $2 AND codigo = $3 AND estado = 'activo'
     LIMIT 1`,
    [usuarioId, imei, codigo]
  )
  return rows[0] || null
}

async function upsertSeguimientoNotificado(usuarioId, imei, codigo, umbralHoras, meta = {}) {
  const dia = diaLima()
  const existing = await obtenerSeguimientoActivo(usuarioId, imei, codigo)
  if (existing) {
    const { rows } = await pool.query(
      `UPDATE alerta_seguimiento SET
         ultima_notificacion_en = NOW(),
         ultimo_umbral_horas = $2,
         dia_lima = $3,
         meta = COALESCE(meta, '{}'::jsonb) || $4::jsonb
       WHERE id = $1 RETURNING *`,
      [existing.id, umbralHoras, dia, JSON.stringify(meta)]
    )
    return rows[0]
  }
  const { rows } = await pool.query(
    `INSERT INTO alerta_seguimiento
       (usuario_id, imei, codigo, iniciado_en, ultima_notificacion_en, ultimo_umbral_horas, estado, dia_lima, meta)
     VALUES ($1,$2,$3,NOW(),NOW(),$4,'activo',$5,$6)
     RETURNING *`,
    [usuarioId, imei, codigo, umbralHoras, dia, JSON.stringify(meta)]
  )
  return rows[0]
}

async function marcarAckSeguimiento(usuarioId, imei, codigo = null) {
  const params = [usuarioId]
  let extra = ''
  if (imei) {
    params.push(imei)
    extra += ` AND imei = $${params.length}`
  }
  if (codigo) {
    params.push(codigo)
    extra += ` AND codigo = $${params.length}`
  }
  await pool.query(
    `UPDATE alerta_seguimiento SET ack_en = NOW(), estado = 'ack'
     WHERE usuario_id = $1 AND estado = 'activo' ${extra}`,
    params
  )
}

async function resolverSeguimiento(imei, codigo) {
  await pool.query(
    `UPDATE alerta_seguimiento SET estado = 'resuelto'
     WHERE imei = $1 AND codigo = $2 AND estado IN ('activo','ack')`,
    [imei, codigo]
  )
}

function fmtHorasHumanas(h) {
  if (h < 1) return `${Math.round(h * 60)} min`
  const enteras = Math.floor(h)
  const mins = Math.round((h - enteras) * 60)
  if (mins === 0) return enteras === 1 ? '1 hora' : `${enteras} horas`
  return `${enteras} h ${mins} min`
}

/**
 * Mensaje natural según umbral y si el usuario respondió.
 */
async function redactarAvisoFuera(usuario, {
  nombreEquipo,
  imei,
  horas,
  umbral,
  esPrimera,
  esReaviso,
  datoClave,
  sensorVal,
  setRef,
  delta
}) {
  const nombre = nombrePila(usuario.nombre) || ''
  const equipo = nombreEquipo || imei
  const ctx = await obtenerContextoChat({ usuarioId: usuario.id, telefono: usuario.telefono, limite: 8 })
  const sinRespuesta = esReaviso && !ctx.usuarioRespondioTrasUltimoAviso
  const horasTxt = fmtHorasHumanas(horas)

  const datos =
    datoClave ||
    (sensorVal != null && setRef != null
      ? `Retorno *${sensorVal} °C* con set *${setRef} °C* (±${delta ?? 5}).`
      : null)

  if (esPrimera) {
    return (
      `${pick(['Hola', 'Buenas'])}${nombre ? ` ${nombre}` : ''} — el reefer *${equipo}* lleva fuera de rango unas *${horasTxt}*.\n` +
      (datos ? `${datos}\n` : '') +
      `¿Lo revisan en planta? Puedes responder *OK*, pedir *GRAFICA* o *ESTADO*.`
    )
  }

  if (sinRespuesta) {
    const variantes = [
      `${nombre ? `${nombre}, ` : ''}sigo viendo *${equipo}* fuera de rango (~${horasTxt}). ¿Alguien en planta ya lo miró? Si sí, responde *OK*; si quieres la curva, *GRAFICA*.`,
      `Solo para no dejarte a ciegas: *${equipo}* sigue desviado hace ~${horasTxt}.` +
        (datos ? `\n${datos}` : '') +
        `\nCuando puedas: *OK* / *GRAFICA* / *ESTADO*.`,
      `Aviso suave — *${equipo}* aún no vuelve al rango (lleva ~${horasTxt}). No te saturo: dime *OK* si ya lo vieron o *GRAFICA* si quieres números.`
    ]
    return pick(variantes)
  }

  return (
    `${pick(['Update', 'Sigo el tema', 'Buenas de nuevo'])}${nombre ? ` ${nombre}` : ''}: *${equipo}* acumula ~${horasTxt} fuera de rango` +
    (umbral ? ` (umbral ${fmtHorasHumanas(umbral)})` : '') +
    `.\n` +
    (datos ? `${datos}\n` : '') +
    `¿Seguimos? *OK* / *GRAFICA* / *ESTADO*.`
  )
}

function redactarRecuperacionRango(usuario, { nombreEquipo, imei, horasFuera }) {
  const nombre = nombrePila(usuario.nombre) || ''
  const equipo = nombreEquipo || imei
  const extra = horasFuera ? ` Había estado desviado ~${fmtHorasHumanas(horasFuera)}.` : ''
  return (
    `${pick(['Buenas noticias', 'Listo', 'Update'])}${nombre ? ` ${nombre}` : ''}: *${equipo}* ya volvió *al rango*.${extra}\n` +
    `Si necesitas el cierre con gráfica, escribe *GRAFICA*; si no, *OK* basta.`
  )
}

function redactarOnline(usuario, { nombreEquipo, imei }) {
  const nombre = nombrePila(usuario.nombre) || ''
  const equipo = nombreEquipo || imei
  return (
    `${pick(['Hola', 'Aviso'])}${nombre ? ` ${nombre}` : ''}: *${equipo}* ya volvió a estar *en línea*.\n` +
    `Escribe *ESTADO* si quieres ver temperaturas.`
  )
}

module.exports = {
  diaLima,
  leerUmbrales,
  decidirNotificacionFuera,
  obtenerSeguimientoActivo,
  upsertSeguimientoNotificado,
  marcarAckSeguimiento,
  resolverSeguimiento,
  redactarAvisoFuera,
  redactarRecuperacionRango,
  redactarOnline,
  fmtHorasHumanas
}
