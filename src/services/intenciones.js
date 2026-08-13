/**
 * Normalización y detección de intenciones (reglas, sin LLM).
 * Nota: números sueltos (1–5) los resuelve el menú en handlers, no aquí.
 */

function quitarTildes(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function normalizar(texto) {
  return quitarTildes(String(texto || ''))
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

const REGLAS = [
  { intencion: 'ayuda', patrones: [/^(ayuda|menu|comandos|hola|buenas|buenos dias|buen dia|hey|que tal)$/] },
  { intencion: 'ok', patrones: [/^(ok|okay|visto|ya|listo|gracias|atendido|ya lo vieron)$/] },
  { intencion: 'grafica', patrones: [/^(grafica|grafico|curva|12h|historico)$/, /\bgrafica\b/, /\bcurva\b/] },
  { intencion: 'ultimos', patrones: [/^(ultimos|últimos|ultimos 10|últimos 10|10 datos)$/, /\bultimos\b/] },
  { intencion: 'actualizar', patrones: [/^(actualizar|refresh|estatus|status|actualizar estado)$/, /\bactualizar\b/] },
  { intencion: 'ver_mas', patrones: [/^(ver mas|vermás|mas equipos|siguiente pagina)$/] },
  { intencion: 'anterior', patrones: [/^(anterior|atras|atrás|volver)$/] },
  { intencion: 'alertas', patrones: [/^(alertas|pendientes|problemas)$/, /\balertas\b/, /que paso/] },
  { intencion: 'estado', patrones: [/^(estado|resumen|reporte|dispositivos|equipos)$/, /como estan/, /\bestado\b/, /reporte/] },
  { intencion: 'mas', patrones: [/^(detalle|ampliar|completo)$/, /\bdetalle\b/] },
  { intencion: 'todos', patrones: [/^(todos|todas|el grupo|los demas|inicio)$/] },
  { intencion: 'silencio', patrones: [/^silencio/, /^mute/, /no avises/] },
  { intencion: 'activar', patrones: [/avisame/, /reactivar/, /quiero alertas/] }
]

function detectarIntencion(texto) {
  const n = normalizar(texto)
  if (!n) return { intencion: 'vacio', texto: n, raw: texto }

  // Código ZGRU → equipo (antes que reglas genéricas)
  if (/\bzgru\s*[-_]?\s*\d{4,}\b/.test(n) || /\bzgru\d{4,}\b/.test(n)) {
    return { intencion: 'equipo', texto: n, raw: texto }
  }

  for (const r of REGLAS) {
    for (const p of r.patrones) {
      if (p.test(n)) return { intencion: r.intencion, texto: n, raw: texto }
    }
  }

  // Número suelto: lo maneja el menú (selección)
  if (/^\d{1,2}$/.test(n)) {
    return { intencion: 'opcion_num', texto: n, raw: texto, numero: parseInt(n, 10) }
  }

  const imeiMatch = n.match(/\b(\d{6,})\b/)
  if (imeiMatch) {
    return { intencion: 'equipo', texto: n, raw: texto, imeiParcial: imeiMatch[1] }
  }

  return { intencion: 'texto_libre', texto: n, raw: texto }
}

function parseSilencioHoras(texto) {
  const n = normalizar(texto)
  const m = n.match(/(\d+)\s*h/)
  if (m) return Math.min(8, Math.max(1, parseInt(m[1], 10)))
  return 2
}

module.exports = { normalizar, detectarIntencion, parseSilencioHoras, quitarTildes }
