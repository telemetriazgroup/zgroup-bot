/**
 * Menú navegable: grupos + individuales, paginado 5, selección por número o código ZGRU.
 */
const { normalizar, quitarTildes } = require('./intenciones')
const { nombrePila, pick } = require('./conversacion')

const PAGE_SIZE = 5

const INTROS_RAIZ = [
  'Tienes estos equipos disponibles:',
  'Estos están tus grupos y reefers:',
  'Así está tu lista ahora:',
  'Puedes elegir de esta lista:'
]

const INTROS_RAIZ_VUELTA = [
  'Volvimos — siguen disponibles:',
  'De nuevo el menú amplio:',
  'Aquí el panorama otra vez:',
  'Listo, volvemos a la lista:'
]

const INTROS_GRUPO = [
  g => `En *${g}* están:`,
  g => `Equipos del grupo *${g}*:`,
  g => `Dentro de *${g}* tienes:`,
  g => `Así se ve *${g}*:`
]

const CIERRES_RAIZ = [
  'Responde el *número*, el código *ZGRU…*, o *ver más* si aparece.',
  'Elige un *número*, escribe el *ZGRU* del equipo, o *ver más*.',
  'Mándame la opción (1, 2…) o el código del reefer (*ZGRU…*).'
]

const CIERRES_GRUPO = [
  'Elige el *número* o el *ZGRU*. Para volver: *anterior* o *todos*.',
  'Número / *ZGRU* del equipo. *Anterior* o *todos* = menú general.',
  'Selecciona uno, o di *todos* / *anterior* para salir del grupo.'
]

const CIERRES_DISP = [
  'Puedes pedir *GRAFICA*, *ULTIMOS* (10 datos), *ACTUALIZAR* o *TODOS* (menú).',
  'Opciones: *gráfica* · *últimos* · *actualizar* · *todos* para volver.',
  '¿*GRAFICA*, *ULTIMOS 10*, *ACTUALIZAR* estado, o *TODOS*?'
]

function etiquetaEquipo(d) {
  const nom = String(d?.nombre || '').trim()
  if (nom) return nom
  return String(d?.imei || 'equipo')
}

function construirItemsMenu(grupos, individuales) {
  const items = []
  const gruposOrd = [...(grupos || [])].sort((a, b) =>
    String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es')
  )
  for (const g of gruposOrd) {
    items.push({
      tipo: 'grupo',
      id: g.id,
      label: `Grupo ${g.nombre}`,
      grupoId: g.id,
      grupoNombre: g.nombre,
      dispositivos: [...(g.dispositivos || [])].sort((a, b) =>
        etiquetaEquipo(a).localeCompare(etiquetaEquipo(b), 'es')
      )
    })
  }
  const inds = [...(individuales || [])].sort((a, b) =>
    etiquetaEquipo(a).localeCompare(etiquetaEquipo(b), 'es')
  )
  for (const d of inds) {
    items.push({
      tipo: 'dispositivo',
      id: d.id,
      label: etiquetaEquipo(d),
      imei: d.imei,
      dispositivo: d
    })
  }
  return items
}

function paginaDeItems(items, page = 0, pageSize = PAGE_SIZE) {
  const p = Math.max(0, parseInt(page, 10) || 0)
  const total = items.length
  const start = p * pageSize
  const slice = items.slice(start, start + pageSize)
  const hasMore = start + pageSize < total
  const hasPrev = p > 0
  return { page: p, slice, hasMore, hasPrev, total, pageSize }
}

function formatearLineasOpciones(slice, { conVerMas = false } = {}) {
  const lineas = slice.map((it, i) => `${i + 1} - ${it.label}`)
  if (conVerMas) {
    lineas.push(`${slice.length + 1} - Ver más`)
  }
  return lineas.join('\n')
}

/**
 * Arma página raíz y opciones resolubles (números → item o ver_mas).
 */
function armarPaginaRaiz(items, page = 0, { vuelta = false } = {}) {
  const { slice, hasMore, hasPrev, page: p, total } = paginaDeItems(items, page)
  const opciones = slice.map(it => ({ ...it }))
  if (hasMore) {
    opciones.push({ tipo: 'ver_mas', id: 'ver_mas', label: 'Ver más' })
  }

  const intro = vuelta ? pick(INTROS_RAIZ_VUELTA) : pick(INTROS_RAIZ)
  const cuerpo = formatearLineasOpciones(slice, { conVerMas: hasMore })
  let texto = `${intro}\n\n${cuerpo}`
  if (hasPrev) texto += `\n\nTambién puedes escribir *anterior* para la página previa.`
  texto += `\n\n${pick(CIERRES_RAIZ)}`
  if (total === 0) {
    texto = 'No tienes equipos asignados todavía. Pide a ZGroup que te vincule reefers o grupos.'
  }

  return {
    texto,
    opciones,
    menu_vista: 'raiz',
    menu_page: p,
    menu_grupo_id: null,
    total
  }
}

function armarPaginaGrupo(grupoItem, page = 0) {
  const dispositivos = grupoItem.dispositivos || []
  const items = dispositivos.map(d => ({
    tipo: 'dispositivo',
    id: d.id,
    label: etiquetaEquipo(d),
    imei: d.imei,
    dispositivo: d,
    grupoId: grupoItem.id,
    grupoNombre: grupoItem.grupoNombre || grupoItem.label
  }))
  const { slice, hasMore, hasPrev, page: p, total } = paginaDeItems(items, page)
  const opciones = slice.map(it => ({ ...it }))
  if (hasMore) opciones.push({ tipo: 'ver_mas', id: 'ver_mas', label: 'Ver más' })

  const nombreG = grupoItem.grupoNombre || String(grupoItem.label || '').replace(/^Grupo\s+/i, '')
  const intro = pick(INTROS_GRUPO)(nombreG)
  const cuerpo = formatearLineasOpciones(slice, { conVerMas: hasMore })
  let texto = `${intro}\n\n${cuerpo}`
  if (hasPrev) texto += `\n\n*Anterior* = página previa del grupo.`
  texto += `\n\n${pick(CIERRES_GRUPO)}`

  return {
    texto,
    opciones,
    menu_vista: 'grupo',
    menu_page: p,
    menu_grupo_id: grupoItem.id,
    menu_grupo_nombre: nombreG,
    total
  }
}

function mensajeOpcionesDispositivo(d, { grupoNombre } = {}) {
  const nombre = etiquetaEquipo(d)
  const g = grupoNombre ? ` · ${grupoNombre}` : ''
  return (
    `Equipo *${nombre}*${g}.\n` +
    pick(CIERRES_DISP)
  )
}

function extraerCodigoZgru(texto) {
  const n = normalizar(texto)
  const m = n.match(/\bzgru\s*[-_]?\s*(\d{4,})\b/) || n.match(/\b(zgru\d{4,})\b/)
  if (!m) return null
  if (m[1] && /^\d/.test(m[1])) return `zgru${m[1]}`
  return String(m[1] || m[0]).replace(/\s+/g, '')
}

/**
 * Interpreta texto del usuario contra el menú en contexto.
 * @returns {{ accion: string, opcion?: object, pageDelta?: number } | null}
 */
function resolverSeleccionMenu(texto, ctx) {
  const n = normalizar(texto)
  if (!n) return null

  if (/^(todos|todas|menu|inicio|amplio)$/.test(n) || n === 'el grupo' || n.includes('volver al menu')) {
    return { accion: 'raiz' }
  }
  if (/^(anterior|atras|volver)$/.test(n)) {
    return { accion: 'anterior' }
  }
  if (/^(ver mas|vermás|mas equipos|siguiente)$/.test(n)) {
    return { accion: 'ver_mas' }
  }
  if (/^(actualizar|refresh|status|estatus|actualizar estado)$/.test(n)) {
    return { accion: 'actualizar' }
  }
  if (/^(ultimos|últimos|ultimos 10|últimos 10|10 datos|ultimas)$/.test(n) || /\bultimos\b/.test(n)) {
    return { accion: 'ultimos' }
  }

  const zgru = extraerCodigoZgru(texto)
  if (zgru) return { accion: 'zgru', codigo: zgru }

  // Número de opción (1–9) solo si hay menú activo
  const mNum = n.match(/^(\d{1,2})$/)
  if (mNum && ctx?.menu_opciones?.length) {
    const idx = parseInt(mNum[1], 10) - 1
    const opcion = ctx.menu_opciones[idx]
    if (!opcion) return { accion: 'opcion_invalida', idx: idx + 1 }
    if (opcion.tipo === 'ver_mas') return { accion: 'ver_mas' }
    return { accion: 'opcion', opcion }
  }

  return null
}

function saludoMenu(usuario, { primera = true } = {}) {
  const nombre = nombrePila(usuario.nombre) || ''
  if (!primera) return ''
  const base = pick([
    `Hola${nombre ? ` ${nombre}` : ''}`,
    `Buenas${nombre ? ` ${nombre}` : ''}`,
    `Hola de nuevo${nombre ? ` ${nombre}` : ''}`
  ])
  return `${base} — soy el monitor de ZGroup.\n`
}

module.exports = {
  PAGE_SIZE,
  etiquetaEquipo,
  construirItemsMenu,
  armarPaginaRaiz,
  armarPaginaGrupo,
  mensajeOpcionesDispositivo,
  resolverSeleccionMenu,
  extraerCodigoZgru,
  saludoMenu,
  paginaDeItems
}
