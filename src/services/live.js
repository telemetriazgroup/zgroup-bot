const { db } = require('../db')
const { logger } = require('../logger')

const URL_LIVE_DEFAULT = 'http://161.132.53.51:9050/Tunel/decodificado/live/'

const SENSORES = {
  temp_supply_1:    'Sensor de Suministro',
  return_air:       'Sensor de Retorno',
  evaporation_coil: 'Sensor de Evaporador',
  set_point:        'Set de Temperatura',
  compress_coil_1:  'Temperatura de Compresor'
}

async function fetchLiveData(imei) {
  const config = await db.obtenerConfigApi()
  const url = config?.url_live || URL_LIVE_DEFAULT

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imei })
  })

  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`API live respondió ${res.status}: ${txt.slice(0, 200)}`)
  }

  const data = await res.json()
  if (!data.ultimo) throw new Error('Sin datos de telemetría en respuesta live')

  return data
}

function extraerTelemetria(ultimo) {
  return {
    temp_supply_1:    ultimo.temp_supply_1 ?? null,
    return_air:       ultimo.return_air ?? null,
    evaporation_coil: ultimo.evaporation_coil ?? null,
    set_point_live:   ultimo.set_point ?? null,
    compress_coil_1:  ultimo.compress_coil_1 ?? null,
    fecha_live:       ultimo.fecha || ultimo.created_at || null
  }
}

function formatearSensores(ultimo) {
  return Object.entries(SENSORES).map(([key, label]) => ({
    key,
    label,
    valor: ultimo[key === 'set_point' ? 'set_point' : key] ?? null
  }))
}

module.exports = { fetchLiveData, extraerTelemetria, formatearSensores, SENSORES, URL_LIVE_DEFAULT }
