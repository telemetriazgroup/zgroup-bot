/**
 * Normalización y detección de intenciones (reglas, sin LLM).
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
  { intencion: 'ayuda', patrones: [/^(ayuda|menu|comandos|hola|buenas|buenos dias|buen dia|0)$/] },
  { intencion: 'ok', patrones: [/^(ok|okay|visto|ya|listo|gracias|atendido|ya lo vieron|9)$/] },
  { intencion: 'grafica', patrones: [/^(grafica|grafico|curva|12h|historico|3)$/, /\bgrafica\b/, /\bcurva\b/] },
  { intencion: 'alertas', patrones: [/^(alertas|pendientes|problemas|2)$/, /\balertas\b/, /que paso/] },
  { intencion: 'estado', patrones: [/^(estado|resumen|reporte|1)$/, /como estan/, /\bestado\b/, /reporte/] },
  { intencion: 'mas', patrones: [/^(mas|detalle|ampliar|completo)$/, /\bdetalle\b/] },
  { intencion: 'todos', patrones: [/^(todos|todas|el grupo|los demas)$/] },
  { intencion: 'silencio', patrones: [/^silencio/, /^mute/, /no avises/] },
  { intencion: 'activar', patrones: [/avisame/, /reactivar/, /quiero alertas/] }
]

function detectarIntencion(texto) {
  const n = normalizar(texto)
  if (!n) return { intencion: 'vacio', texto: n, raw: texto }

  for (const r of REGLAS) {
    for (const p of r.patrones) {
      if (p.test(n)) return { intencion: r.intencion, texto: n, raw: texto }
    }
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
