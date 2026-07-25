const MAQUINA_POR_RECETA = {
  'PRUEBA CA 19/05/2026': 'CIM1086751'
}

function fmtFechaExacta(f) {
  if (!f) return 'N/A'
  return new Date(f).toLocaleString('es-PE', {
    timeZone: 'America/Lima',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}

function normalizarReceta(receta) {
  return (receta || '').trim()
}

function resolverMaquinaSerie(receta, manual) {
  const key = normalizarReceta(receta)
  if (key && MAQUINA_POR_RECETA[key]) return MAQUINA_POR_RECETA[key]
  return manual || null
}

function formatearTipoFruta(tipoFruta, variacion) {
  if (!tipoFruta) return null
  const t = tipoFruta.trim()
  const esPalta = /palta|aguacate/i.test(t)
  if (esPalta) {
    const varTxt = variacion?.trim() || 'HASS'
    return `Palta aguacate — variación ${varTxt.toUpperCase()}`
  }
  if (variacion?.trim()) return `${t} — ${variacion.trim()}`
  return t
}

function tieneDatosProceso(p) {
  if (!p) return false
  return !!(p.receta || p.tipo_fruta || p.procedencia || p.fecha_inicio || p.fecha_fin)
}

function formatearSeguimientoProceso(proceso) {
  if (!tieneDatosProceso(proceso)) return ''

  const receta = normalizarReceta(proceso.receta)
  const fruta = formatearTipoFruta(proceso.tipo_fruta, proceso.variacion)
  const maquina = resolverMaquinaSerie(receta, proceso.maquina_serie)

  let bloque =
    `📋 *Seguimiento de proceso CA*\n` +
    `• Receta: ${receta || 'N/A'}\n`

  if (fruta) bloque += `• Fruta: ${fruta}\n`
  if (proceso.procedencia) bloque += `• Procedencia: ${proceso.procedencia}\n`
  bloque += `• Inicio de proceso: ${fmtFechaExacta(proceso.fecha_inicio)}\n`
  bloque += `• Fin de proceso: ${fmtFechaExacta(proceso.fecha_fin)}\n`

  if (maquina) {
    bloque += `\n🏭 *Equipo utilizado*\n`
    bloque += `• Máquina CA — Serie: *${maquina}*\n`
    if (receta && MAQUINA_POR_RECETA[receta]) {
      bloque += `• Asignada automáticamente para receta "${receta}"\n`
    }
  }

  return bloque + '\n'
}

function prepararProcesoParaGuardar(data) {
  const receta = normalizarReceta(data.receta)
  const maquina = resolverMaquinaSerie(receta, data.maquina_serie?.trim() || null)
  let variacion = data.variacion?.trim() || null
  const tipo = data.tipo_fruta?.trim() || null

  if (tipo && /palta|aguacate/i.test(tipo) && !variacion) {
    variacion = 'HASS'
  }

  return {
    receta: receta || null,
    tipo_fruta: tipo,
    variacion,
    procedencia: data.procedencia?.trim() || null,
    fecha_inicio: data.fecha_inicio || null,
    fecha_fin: data.fecha_fin || null,
    maquina_serie: maquina
  }
}

module.exports = {
  MAQUINA_POR_RECETA,
  formatearSeguimientoProceso,
  prepararProcesoParaGuardar,
  resolverMaquinaSerie,
  fmtFechaExacta,
  tieneDatosProceso
}
