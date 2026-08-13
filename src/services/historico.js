const { db } = require('../db')
const { logger } = require('../logger')

const URL_HISTORICO_DEFAULT = 'http://161.132.53.51:9050/Tunel/decodificado/imei/'
const HORAS_MINIMAS = 2

async function fetchHistorico12h(imei, linkOrigen = 'link1') {
  const link = await db.obtenerConfigLink(linkOrigen)
  const url = link?.url_historico || URL_HISTORICO_DEFAULT

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imei })
  })

  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`[${linkOrigen}] API histórico respondió ${res.status}: ${txt.slice(0, 200)}`)
  }

  const data = await res.json()
  const registros = data.registros || data.data || []
  if (!registros.length) throw new Error(`[${linkOrigen}] Sin registros históricos para ${imei}`)

  return { registros, url, link_id: linkOrigen }
}

/**
 * Rango efectivo: con prioridad ztrack usa min/max de la API;
 * si no, set±delta local (o los pasados por el caller).
 */
function resolverRangoAnalisis(disp, { setRef = null, delta = null } = {}) {
  const zr = disp?.ztrack_rango && typeof disp.ztrack_rango === 'object'
    ? disp.ztrack_rango
    : null

  if (disp?.prioridad_monitor && zr && zr.min != null && zr.max != null) {
    const min = parseFloat(zr.min)
    const max = parseFloat(zr.max)
    const set = zr.setPoint != null ? parseFloat(zr.setPoint) : (min + max) / 2
    return {
      origen: 'ztrack',
      setControl: set,
      min,
      max,
      delta: Math.max(Math.abs(set - min), Math.abs(max - set))
    }
  }

  const set =
    setRef != null && !Number.isNaN(parseFloat(setRef))
      ? parseFloat(setRef)
      : disp?.set_control != null
        ? parseFloat(disp.set_control)
        : null
  const dlt =
    delta != null && !Number.isNaN(parseFloat(delta))
      ? parseFloat(delta)
      : disp?.delta != null
        ? parseFloat(disp.delta)
        : 5

  if (set == null || Number.isNaN(set)) {
    return { origen: 'ninguno', setControl: null, min: null, max: null, delta: dlt }
  }

  return {
    origen: 'local',
    setControl: set,
    min: set - dlt,
    max: set + dlt,
    delta: dlt
  }
}

function estaFueraDeRangoAbs(returnAir, min, max) {
  if (returnAir == null || min == null || max == null) return false
  return returnAir < min || returnAir > max
}

function estaFueraDeRango(returnAir, setRef, delta) {
  if (returnAir == null || setRef == null || delta == null) return false
  return estaFueraDeRangoAbs(returnAir, setRef - delta, setRef + delta)
}

function analizarFueraDeRango(registros, rango) {
  const min = rango.min
  const max = rango.max
  const setControl = rango.setControl
  const delta = rango.delta

  const sorted = registros
    .filter(r => r.return_air != null)
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha))

  if (!sorted.length || min == null || max == null) {
    return {
      maxHorasContinuas: 0,
      horasActualesContinuas: 0,
      mensajeHoras: null,
      puntos: [],
      totalFuera: 0,
      actualmenteFuera: false,
      origenRango: rango.origen
    }
  }

  let maxMs = 0
  let currentMs = 0
  let prevTime = null
  let totalFuera = 0
  let lastFuera = false

  for (const r of sorted) {
    const t = new Date(r.fecha).getTime()
    const fuera = estaFueraDeRangoAbs(parseFloat(r.return_air), min, max)
    const intervalMs = prevTime != null ? Math.max(0, t - prevTime) : 0

    if (fuera) {
      currentMs += intervalMs
      totalFuera++
      lastFuera = true
    } else if (currentMs > 0) {
      maxMs = Math.max(maxMs, currentMs)
      currentMs = 0
      lastFuera = false
    } else {
      lastFuera = false
    }
    prevTime = t
  }
  maxMs = Math.max(maxMs, currentMs)

  const maxHorasContinuas = maxMs / (1000 * 60 * 60)
  // Horas del episodio ACTUAL (al final de la serie), no el máximo del día
  const horasActualesContinuas = lastFuera ? currentMs / (1000 * 60 * 60) : 0
  const horasParaMensaje = lastFuera ? horasActualesContinuas : 0
  const horasEnteras = Math.floor(horasParaMensaje)

  const mensajeHoras = horasEnteras >= HORAS_MINIMAS
    ? `Lleva unas *${horasEnteras} h* seguidas fuera de rango (rango ${rango.origen}: ${min}…${max} °C).`
    : null

  const puntos = sorted.map(r => {
    const setRef = setControl != null ? setControl : parseFloat(r.set_point)
    return {
      fecha: r.fecha,
      return_air: parseFloat(r.return_air),
      set_point: setRef,
      min,
      max,
      fuera: estaFueraDeRangoAbs(parseFloat(r.return_air), min, max)
    }
  })

  return {
    maxHorasContinuas,
    horasActualesContinuas,
    mensajeHoras,
    horasEnteras,
    puntos,
    totalFuera,
    totalRegistros: sorted.length,
    actualmenteFuera: lastFuera,
    origenRango: rango.origen,
    rango: { min, max, set: setControl, delta, origen: rango.origen }
  }
}

function fmtHora(fecha, { yaEsLima = true } = {}) {
  const s = String(fecha ?? '')
  const m = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?/)
  if (m) {
    return `${String(m[1]).padStart(2, '0')}:${m[2]}`
  }
  const d = new Date(fecha)
  if (Number.isNaN(d.getTime())) return '--:--'
  if (yaEsLima) {
    return d.toLocaleTimeString('en-GB', {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
  }
  return d.toLocaleTimeString('es-PE', {
    timeZone: 'America/Lima',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

function muestrearPuntos(puntos, maxPuntos = 72) {
  if (puntos.length <= maxPuntos) return puntos
  const step = Math.ceil(puntos.length / maxPuntos)
  return puntos.filter((_, i) => i % step === 0 || i === puntos.length - 1)
}

async function generarGrafica12h(puntos, { imei, nombre, delta, min, max, origenRango = 'local', yaEsLima = true }) {
  const muestreados = muestrearPuntos(puntos)
  const labels = muestreados.map(p => fmtHora(p.fecha, { yaEsLima }))
  const returnAir = muestreados.map(p => p.return_air)
  const setPoint = muestreados.map(p => p.set_point)
  const bandMin = muestreados.map(p => p.min)
  const bandMax = muestreados.map(p => p.max)
  const limLabel = origenRango === 'ztrack'
    ? `Banda ztrack (${min}…${max})`
    : `Límite ±${delta}°C`

  const chartConfig = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Retorno (°C)',
          data: returnAir,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59,130,246,0.1)',
          fill: false,
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.2
        },
        {
          label: 'Set point (°C)',
          data: setPoint,
          borderColor: '#22c55e',
          borderDash: [6, 4],
          fill: false,
          pointRadius: 0,
          borderWidth: 2
        },
        {
          label: `${limLabel} máx`,
          data: bandMax,
          borderColor: 'rgba(239,68,68,0.5)',
          borderDash: [2, 4],
          fill: false,
          pointRadius: 0,
          borderWidth: 1
        },
        {
          label: `${limLabel} mín`,
          data: bandMin,
          borderColor: 'rgba(239,68,68,0.5)',
          borderDash: [2, 4],
          fill: false,
          pointRadius: 0,
          borderWidth: 1
        }
      ]
    },
    options: {
      title: {
        display: true,
        text: `Trazabilidad 12h (hora Lima) — ${nombre || imei} [${origenRango}]`,
        fontSize: 14
      },
      legend: { display: true, position: 'bottom' },
      scales: {
        xAxes: [{ scaleLabel: { display: true, labelString: 'Hora Lima (GMT-5)' } }],
        yAxes: [{ scaleLabel: { display: true, labelString: 'Temperatura °C' } }]
      }
    }
  }

  const chartUrl = `https://quickchart.io/chart?width=900&height=480&format=png&c=${encodeURIComponent(JSON.stringify(chartConfig))}`
  const res = await fetch(chartUrl)
  if (!res.ok) throw new Error(`QuickChart respondió ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

function mensajeHorasDesdeZtrack(disp, analisis) {
  // Priorizar el análisis de la curva con la misma banda dibujada (ztrack min/max).
  // Evita reportar el máximo histórico de la ventana (ej. 11 h) cuando el episodio actual es ~2 h.
  if (analisis?.mensajeHoras) return analisis.mensajeHoras

  const epi = disp?.ztrack_episodio
  if (disp?.prioridad_monitor && epi?.since && analisis?.actualmenteFuera !== false) {
    const h = Math.max(0, (Date.now() - new Date(epi.since).getTime()) / 3600000)
    const enteras = Math.floor(h)
    if (enteras >= HORAS_MINIMAS) {
      return `Episodio ztrack (*${epi.kind || 'fuera'}*): ~${enteras} h activas. Rango API ${analisis?.rango?.min}…${analisis?.rango?.max} °C.`
    }
  }
  return null
}

async function analizarYGenerarGrafica(disp, { setRef, delta, conImagen = true } = {}) {
  if (disp.link_origen && disp.link_origen !== 'link1') {
    return { analisis: null, imagen: null }
  }

  const link = await db.obtenerConfigLink(disp.link_origen || 'link1')
  if (!link?.url_historico) return { analisis: null, imagen: null }

  const configApi = await db.obtenerConfigApi().catch(() => null)
  const yaEsLima = configApi?.historico_fecha_ya_lima !== false

  try {
    const { registros } = await fetchHistorico12h(disp.imei, disp.link_origen || 'link1')
    const rango = resolverRangoAnalisis(disp, { setRef, delta })
    const analisis = analizarFueraDeRango(registros, rango)
    analisis.mensajeHoras = mensajeHorasDesdeZtrack(disp, analisis) || analisis.mensajeHoras

    let imagen = null
    if (conImagen && analisis.puntos.length && rango.min != null) {
      imagen = await generarGrafica12h(analisis.puntos, {
        imei: disp.imei,
        nombre: disp.nombre,
        delta: rango.delta,
        min: rango.min,
        max: rango.max,
        origenRango: rango.origen,
        yaEsLima
      })
    }

    return { analisis, imagen, rango }
  } catch (err) {
    logger.warn(`Histórico 12h falló para ${disp.imei}: ${err.message}`)
    return { analisis: null, imagen: null, error: err.message }
  }
}

/**
 * Últimos N puntos de retorno (más recientes primero en el texto).
 */
async function obtenerUltimosDatos(disp, { limit = 10 } = {}) {
  const { registros } = await fetchHistorico12h(disp.imei, disp.link_origen || 'link1')
  const sorted = [...registros]
    .filter(r => r.return_air != null || r.fecha)
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha))
  const ultimos = sorted.slice(-Math.max(1, Math.min(30, limit)))
  const lineas = [...ultimos].reverse().map(r => {
    const h = fmtHora(r.fecha, { yaEsLima: true })
    const t = r.return_air != null ? `${parseFloat(r.return_air)}°C` : 'N/A'
    const set = r.set_point != null ? ` · set ${parseFloat(r.set_point)}°C` : ''
    return `• ${h} — retorno ${t}${set}`
  })
  return { lineas, total: ultimos.length }
}

module.exports = {
  fetchHistorico12h,
  analizarFueraDeRango,
  generarGrafica12h,
  analizarYGenerarGrafica,
  resolverRangoAnalisis,
  obtenerUltimosDatos,
  fmtHora,
  estaFueraDeRango,
  HORAS_MINIMAS
}
