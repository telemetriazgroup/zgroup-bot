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

function estaFueraDeRango(returnAir, setRef, delta) {
  if (returnAir == null || setRef == null) return false
  const min = setRef - delta
  const max = setRef + delta
  return returnAir < min || returnAir > max
}

function analizarFueraDeRango(registros, { setControl, delta }) {
  const sorted = registros
    .filter(r => r.return_air != null && (r.set_point != null || setControl != null))
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha))

  if (!sorted.length) {
    return { maxHorasContinuas: 0, mensajeHoras: null, puntos: [], totalFuera: 0 }
  }

  let maxMs = 0
  let currentMs = 0
  let prevTime = null
  let totalFuera = 0

  for (const r of sorted) {
    const t = new Date(r.fecha).getTime()
    const setRef = setControl != null ? parseFloat(setControl) : parseFloat(r.set_point)
    const fuera = estaFueraDeRango(parseFloat(r.return_air), setRef, delta)
    const intervalMs = prevTime != null ? Math.max(0, t - prevTime) : 0

    if (fuera) {
      currentMs += intervalMs
      totalFuera++
    } else if (currentMs > 0) {
      maxMs = Math.max(maxMs, currentMs)
      currentMs = 0
    }
    prevTime = t
  }
  maxMs = Math.max(maxMs, currentMs)

  const maxHorasContinuas = maxMs / (1000 * 60 * 60)
  const horasEnteras = Math.floor(maxHorasContinuas)
  const mensajeHoras = horasEnteras >= HORAS_MINIMAS
    ? `Lleva más de ${horasEnteras} h seguidas fuera de rango (revisión 12 h).`
    : null

  const puntos = sorted.map(r => {
    const setRef = setControl != null ? parseFloat(setControl) : parseFloat(r.set_point)
    return {
      fecha: r.fecha,
      return_air: parseFloat(r.return_air),
      set_point: setRef,
      min: setRef - delta,
      max: setRef + delta,
      fuera: estaFueraDeRango(parseFloat(r.return_air), setRef, delta)
    }
  })

  return { maxHorasContinuas, mensajeHoras, horasEnteras, puntos, totalFuera, totalRegistros: sorted.length }
}

function fmtHora(fecha, { yaEsLima = true } = {}) {
  // API histórico ya entrega hora Lima (GMT-5). No reaplicar America/Lima.
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

async function generarGrafica12h(puntos, { imei, nombre, delta, yaEsLima = true }) {
  const muestreados = muestrearPuntos(puntos)
  const labels = muestreados.map(p => fmtHora(p.fecha, { yaEsLima }))
  const returnAir = muestreados.map(p => p.return_air)
  const setPoint = muestreados.map(p => p.set_point)
  const bandMin = muestreados.map(p => p.min)
  const bandMax = muestreados.map(p => p.max)

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
          label: `Límite +${delta}°C`,
          data: bandMax,
          borderColor: 'rgba(239,68,68,0.5)',
          borderDash: [2, 4],
          fill: false,
          pointRadius: 0,
          borderWidth: 1
        },
        {
          label: `Límite -${delta}°C`,
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
        text: `Trazabilidad 12h (hora Lima) — ${nombre || imei}`,
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
    const setControl = disp.set_control != null ? parseFloat(disp.set_control) : null
    const analisis = analizarFueraDeRango(registros, { setControl, delta })

    let imagen = null
    if (conImagen && analisis.puntos.length) {
      imagen = await generarGrafica12h(analisis.puntos, {
        imei: disp.imei,
        nombre: disp.nombre,
        delta,
        yaEsLima
      })
    }

    return { analisis, imagen }
  } catch (err) {
    logger.warn(`Histórico 12h falló para ${disp.imei}: ${err.message}`)
    return { analisis: null, imagen: null, error: err.message }
  }
}

module.exports = {
  fetchHistorico12h,
  analizarFueraDeRango,
  generarGrafica12h,
  analizarYGenerarGrafica,
  fmtHora,
  HORAS_MINIMAS
}
