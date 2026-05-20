const { db } = require('../db')
const { logger } = require('../logger')

function parseFecha(str) {
  if (!str) return null
  return new Date(str.replace(' ', 'T'))
}

function normalizarDispositivo(item, estado_conexion) {
  return {
    imei: item.imei,
    tipo: item.tipo || 'Tunel',
    estado_conexion,
    ultimo_dato: parseFecha(item.ultimo_dato),
    last_ip: item.last_ip,
    fecha_registro: parseFecha(item.fecha)
  }
}

async function fetchDispositivosExternos(config) {
  const now = new Date()
  const body = {
    mes: now.getMonth() + 1,
    anio: now.getFullYear(),
    online_hasta_horas: parseFloat(config.online_hasta_horas),
    wait_hasta_horas: parseFloat(config.wait_hasta_horas)
  }

  const res = await fetch(config.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`API dispositivos respondió ${res.status}: ${txt.slice(0, 200)}`)
  }

  return res.json()
}

async function sincronizarDispositivos() {
  const config = await db.obtenerConfigApi()
  if (!config) throw new Error('Configuración API no encontrada')

  const data = await fetchDispositivosExternos(config)
  const anteriores = await db.listarDispositivos()
  const mapAnterior = Object.fromEntries(anteriores.map(d => [d.imei, d]))

  const todos = [
    ...(data.online || []).map(d => normalizarDispositivo(d, 'online')),
    ...(data.wait || []).map(d => normalizarDispositivo(d, 'wait')),
    ...(data.offline || []).map(d => normalizarDispositivo(d, 'offline'))
  ]

  const cambios = []
  for (const d of todos) {
    const prev = mapAnterior[d.imei]
    const guardado = await db.upsertDispositivo({ ...d, link_origen: config.link_id || 'link1' })

    if (prev && prev.estado_conexion !== d.estado_conexion && guardado.alarmas_activas) {
      cambios.push({ imei: d.imei, de: prev.estado_conexion, a: d.estado_conexion, dispositivo: guardado })
    }
  }

  logger.info(`📡 Sincronizados ${todos.length} dispositivos (${data.totales?.online || 0} online, ${data.totales?.wait || 0} wait, ${data.totales?.offline || 0} offline)`)

  return {
    sincronizados: todos.length,
    totales: data.totales,
    umbrales: data.umbrales,
    referencia: data.referencia_servidor,
    cambios
  }
}

module.exports = { sincronizarDispositivos, fetchDispositivosExternos }
