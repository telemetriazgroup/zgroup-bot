const { db } = require('../db')
const { logger } = require('../logger')

/**
 * Fechas del reporte de dispositivos ya vienen en hora Lima (GMT-5),
 * normalmente sin zona (`2026-08-11 21:45:40`). Si se parsean como UTC
 * y luego se muestran con America/Lima, se restan 5 h de más.
 */
function parseFecha(str) {
  if (!str) return null
  let s = String(str).trim()
  if (!s) return null
  if (s.includes(' ') && !s.includes('T')) s = s.replace(' ', 'T')
  // Ya trae zona explícita → respetar
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? null : d
  }
  // Sin zona: interpretar como Lima (sin DST)
  const d = new Date(`${s}-05:00`)
  return Number.isNaN(d.getTime()) ? null : d
}

function normalizarDispositivo(item, estado_conexion, linkConfig) {
  let imei = String(item.imei ?? '').trim()
  if (!imei) return null
  // Columna VARCHAR(64); TermoKing a veces manda IDs largos/corruptos
  if (imei.length > 64) {
    logger.warn(`[${linkConfig.link_id}] IMEI truncado (${imei.length}→64): ${imei.slice(0, 40)}…`)
    imei = imei.slice(0, 64)
  }
  const tipo = String(item.tipo || linkConfig.tipo_default || linkConfig.nombre || '').slice(0, 50)
  const lastIp = item.last_ip != null ? String(item.last_ip).slice(0, 50) : null
  return {
    imei,
    tipo: tipo || null,
    estado_conexion,
    ultimo_dato: parseFecha(item.ultimo_dato),
    last_ip: lastIp,
    fecha_registro: parseFecha(item.fecha),
    link_origen: linkConfig.link_id
  }
}

async function fetchDispositivosExternos(linkConfig, umbrales) {
  const now = new Date()
  const body = {
    mes: now.getMonth() + 1,
    anio: now.getFullYear(),
    online_hasta_horas: parseFloat(umbrales.online_hasta_horas),
    wait_hasta_horas: parseFloat(umbrales.wait_hasta_horas)
  }

  const res = await fetch(linkConfig.url_reporte, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`[${linkConfig.link_id}] API dispositivos respondió ${res.status}: ${txt.slice(0, 200)}`)
  }

  return res.json()
}

async function sincronizarLink(linkConfig, umbrales, mapAnterior) {
  const data = await fetchDispositivosExternos(linkConfig, umbrales)
  const todos = [
    ...(data.online || []).map(d => normalizarDispositivo(d, 'online', linkConfig)),
    ...(data.wait || []).map(d => normalizarDispositivo(d, 'wait', linkConfig)),
    ...(data.offline || []).map(d => normalizarDispositivo(d, 'offline', linkConfig))
  ].filter(Boolean)

  const cambios = []
  for (const d of todos) {
    const prev = mapAnterior[d.imei]
    let guardado
    try {
      guardado = await db.upsertDispositivo(d)
    } catch (err) {
      logger.error(`[${linkConfig.link_id}] upsert ${d.imei}: ${err.message}`)
      continue
    }
    mapAnterior[d.imei] = guardado

    if (prev && prev.estado_conexion !== d.estado_conexion && guardado.alarmas_activas) {
      cambios.push({ imei: d.imei, de: prev.estado_conexion, a: d.estado_conexion, dispositivo: guardado, link: linkConfig.link_id })
    }
  }

  logger.info(
    `📡 [${linkConfig.link_id}] ${linkConfig.nombre}: ${todos.length} dispositivos ` +
    `(${data.totales?.online || 0} online, ${data.totales?.wait || 0} wait, ${data.totales?.offline || 0} offline) ` +
    `— mes ${new Date().getMonth() + 1}/${new Date().getFullYear()}`
  )

  return {
    link_id: linkConfig.link_id,
    nombre: linkConfig.nombre,
    sincronizados: todos.length,
    totales: data.totales,
    umbrales: data.umbrales,
    referencia: data.referencia_servidor,
    cambios
  }
}

async function sincronizarDispositivos() {
  const config = await db.obtenerConfigApi()
  if (!config) throw new Error('Configuración API no encontrada')

  const links = await db.listarConfigLinksActivos()
  if (!links.length) throw new Error('No hay links de API configurados')

  const anteriores = await db.listarDispositivos()
  const mapAnterior = Object.fromEntries(anteriores.map(d => [d.imei, d]))

  const por_link = []
  const cambios = []
  let sincronizados = 0

  for (const link of links) {
    try {
      const r = await sincronizarLink(link, config, mapAnterior)
      por_link.push(r)
      sincronizados += r.sincronizados
      cambios.push(...r.cambios)
    } catch (err) {
      logger.error(`Error sincronizando ${link.link_id} (${link.url_reporte}): ${err.message}`)
      por_link.push({ link_id: link.link_id, nombre: link.nombre, error: err.message, sincronizados: 0 })
    }
  }

  return { sincronizados, por_link, cambios }
}

module.exports = { sincronizarDispositivos, fetchDispositivosExternos, sincronizarLink }
