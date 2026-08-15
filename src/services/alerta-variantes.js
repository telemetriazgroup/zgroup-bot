/**
 * Variantes de texto para alertas WhatsApp (anti-plantilla).
 * Hasta 20 formas distintas; se rotan por usuario en envíos masivos (>2).
 */

const { nombrePila } = require('./conversacion')

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function hashSimple(s) {
  let h = 0
  const str = String(s || '')
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0
  return h
}

/**
 * Índice estable/rotativo 0..n-1.
 * En lote (>2 usuarios) usa posición en el envío; si no, mezcla usuario+evento.
 */
function indiceVariante({ usuarioId, imei, codigo, indiceLote = 0, totalUsuarios = 1, totalVariantes = 20 }) {
  const n = Math.max(1, totalVariantes)
  if (totalUsuarios > 2) {
    return ((indiceLote % n) + n) % n
  }
  return (hashSimple(`${usuarioId}|${imei}|${codigo}`) + indiceLote) % n
}

function fmtHoras(h) {
  if (h == null || Number.isNaN(Number(h))) return null
  const n = Number(h)
  if (n < 1) return `${Math.round(n * 60)} min`
  const e = Math.floor(n)
  const m = Math.round((n - e) * 60)
  return m ? `${e} h ${m} min` : `${e} h`
}

const CTAS = [
  '¿Lo revisan? *OK* · *GRAFICA* · *ESTADO*',
  'Cuando puedas: *OK*, *GRAFICA* o *TODOS*.',
  'Responde *OK* si ya lo vieron, o *GRAFICA* / *ACTUALIZAR*.',
  '¿Seguimos? *OK* / *ULTIMOS* / *GRAFICA* / *TODOS*.',
  'Dime *OK* o pide *GRAFICA*; *TODOS* vuelve al menú.'
]

function cta(i) {
  return CTAS[i % CTAS.length]
}

function saludo(nombre, i) {
  const forms = [
    () => (nombre ? `Hola ${nombre}` : 'Hola'),
    () => (nombre ? `Buenas ${nombre}` : 'Buenas'),
    () => (nombre ? `Hola de nuevo ${nombre}` : 'Hola de nuevo'),
    () => (nombre ? `${nombre}` : 'Aviso'),
    () => (nombre ? `Quick note ${nombre}` : 'Quick note'),
    () => (nombre ? `Te aviso ${nombre}` : 'Te aviso'),
    () => (nombre ? `${nombre}, un momento` : 'Un momento'),
    () => (nombre ? `Buen día ${nombre}` : 'Buen día')
  ]
  return forms[i % forms.length]()
}

/**
 * 20 plantillas genéricas de alerta push.
 * Placeholders: {saludo} {equipo} {quePaso} {dato} {cta} {horas} {grupo}
 */
const PLANTILLAS_ALERTA = [
  '{saludo} — aviso del reefer *{equipo}*{grupo}.\n{quePaso}{dato}\n\n{cta}',
  '{saludo}. El equipo *{equipo}*{grupo} necesita revisión.\n{quePaso}{dato}\n{cta}',
  'Monitor ZGroup → *{equipo}*{grupo}.\n{quePaso}{dato}\n{cta}',
  '{saludo}: situación en *{equipo}*.\n{quePaso}{dato}\nPuedes confirmar con *OK*. También *GRAFICA* o *ESTADO*.',
  'Alerta operativa — *{equipo}*{grupo}.\n{quePaso}{dato}\n{cta}',
  '{saludo}, miramos *{equipo}* y hay novedad.\n{quePaso}{dato}\n{cta}',
  'Reefer *{equipo}*{grupo}: {quePaso}{dato}\n{cta}',
  '{saludo}. Paso el dato de *{equipo}* para que no se pase.\n{quePaso}{dato}\n{cta}',
  'Seguimiento *{equipo}*{grupo}.\n{quePaso}{dato}\nSi ya lo atendieron, *OK*; si no, *GRAFICA* ayuda.',
  '{saludo} — *{equipo}* reporta condición a revisar.{dato}\n{quePaso}\n{cta}',
  'Nota de planta: *{equipo}*{grupo}.\n{quePaso}{dato}\n{cta}',
  '{saludo}. No es spam: es un aviso puntual de *{equipo}*.\n{quePaso}{dato}\n{cta}',
  'Condición detectada en *{equipo}*{grupo}.\n{quePaso}{dato}\nRespuesta corta: *OK* o *GRAFICA*.',
  '{saludo}, *{equipo}* está en el radar.{dato}\n{quePaso}\n{cta}',
  'ZGroup · *{equipo}*{grupo}\n{quePaso}{dato}\n{cta}',
  '{saludo}. Resumen rápido de *{equipo}*:\n{quePaso}{dato}\n{cta}',
  'Para tu lista: *{equipo}*{grupo} → {quePaso}{dato}\n{cta}',
  '{saludo} — chequeo de *{equipo}*.\n{quePaso}{dato}\n¿*ACTUALIZAR*, *GRAFICA* u *OK*?',
  'Incidencia *{equipo}*{grupo}.\n{quePaso}{dato}\n{cta}',
  '{saludo}. Dejo constancia de *{equipo}*:\n{quePaso}{dato}\nLuego *TODOS* si quieres el menú.'
]

const PLANTILLAS_FUERA = [
  '{saludo} — *{equipo}* lleva fuera de rango{horasPart}.\n{dato}\n{cta}',
  '{saludo}. Temperatura de *{equipo}* fuera de banda{horasPart}.\n{dato}\n{cta}',
  'Fuera de rango: *{equipo}*{horasPart}.\n{dato}\n{cta}',
  '{saludo}: *{equipo}* no está en el rango esperado{horasPart}.\n{dato}\n{cta}',
  'Monitor · *{equipo}* desviado{horasPart}.\n{dato}\n¿Lo revisan en planta? *OK* / *GRAFICA*.',
  '{saludo}, *{equipo}* sigue fuera{horasPart}.\n{dato}\n{cta}',
  'Aviso térmico — *{equipo}*{horasPart}.\n{dato}\n{cta}',
  '{saludo}. *{equipo}* necesita mirada{horasPart}.\n{dato}\n{cta}',
  'Reefer *{equipo}*: fuera de rango{horasPart}.\n{dato}\n{cta}',
  '{saludo} — update de *{equipo}*{horasPart}.\n{dato}\n{cta}',
  'Seguimiento temperatura *{equipo}*{horasPart}.\n{dato}\n{cta}',
  '{saludo}. Paso el desvío de *{equipo}*{horasPart}.\n{dato}\n{cta}',
  'Planta: *{equipo}* fuera{horasPart}.\n{dato}\n{cta}',
  '{saludo}, chequeo *{equipo}*{horasPart}.\n{dato}\n*OK* si ya lo vieron.',
  'ZGroup alerta · *{equipo}*{horasPart}.\n{dato}\n{cta}',
  '{saludo}. *{equipo}* no vuelve al set{horasPart}.\n{dato}\n{cta}',
  'Desvío en *{equipo}*{horasPart}.\n{dato}\n{cta}',
  '{saludo} — *{equipo}* aún desviado{horasPart}.\n{dato}\n{cta}',
  'Condición de rango · *{equipo}*{horasPart}.\n{dato}\n{cta}',
  '{saludo}. Constancia: *{equipo}* fuera{horasPart}.\n{dato}\n{cta}'
]

const PLANTILLAS_SIN_DATO = [
  '{saludo} — *{equipo}* sin datos recientes{horasPart}.\n{dato}\n{cta}',
  '{saludo}. *{equipo}* dejó de reportar{horasPart}.\n{dato}\n{cta}',
  'Sin telemetría: *{equipo}*{horasPart}.\n{dato}\n{cta}',
  '{saludo}: *{equipo}* en espera / sin dato{horasPart}.\n{dato}\n{cta}',
  'Conexión · *{equipo}* no manda lectura{horasPart}.\n{dato}\n{cta}',
  '{saludo}, *{equipo}* está quieto en datos{horasPart}.\n{dato}\n{cta}',
  'Aviso wait — *{equipo}*{horasPart}.\n{dato}\n{cta}',
  '{saludo}. Revisar enlace de *{equipo}*{horasPart}.\n{dato}\n{cta}',
  'Reefer *{equipo}*: sin reporte{horasPart}.\n{dato}\n{cta}',
  '{saludo} — update *{equipo}* offline/wait{horasPart}.\n{dato}\n{cta}',
  'Seguimiento enlace *{equipo}*{horasPart}.\n{dato}\n{cta}',
  '{saludo}. *{equipo}* no responde datos{horasPart}.\n{dato}\n{cta}',
  'Planta: *{equipo}* sin señal de dato{horasPart}.\n{dato}\n{cta}',
  '{saludo}, chequeo *{equipo}*{horasPart}.\n{dato}\n{cta}',
  'ZGroup · *{equipo}* sin dato{horasPart}.\n{dato}\n{cta}',
  '{saludo}. Pérdida de reporte en *{equipo}*{horasPart}.\n{dato}\n{cta}',
  'Estado conexión *{equipo}*{horasPart}.\n{dato}\n{cta}',
  '{saludo} — *{equipo}* sigue sin dato{horasPart}.\n{dato}\n{cta}',
  'Condición wait · *{equipo}*{horasPart}.\n{dato}\n{cta}',
  '{saludo}. Constancia: *{equipo}* sin datos{horasPart}.\n{dato}\n{cta}'
]

const PLANTILLAS_OK_RANGO = [
  '{saludo}: *{equipo}* ya volvió *al rango*.{extra}\n{cta}',
  'Buenas noticias{nombrePart}: *{equipo}* recuperó el rango.{extra}\n{cta}',
  'Listo — *{equipo}* dentro de banda otra vez.{extra}\n{cta}',
  '{saludo}. Cierre positivo en *{equipo}*.{extra}\n{cta}',
  'Update: *{equipo}* en rango.{extra}\nSi quieres curva, *GRAFICA*; si no, *OK*.',
  '{saludo} — *{equipo}* normalizado.{extra}\n{cta}',
  'Recuperación · *{equipo}*.{extra}\n{cta}',
  '{saludo}. *{equipo}* ya no está desviado.{extra}\n{cta}',
  'ZGroup: *{equipo}* OK en temperatura.{extra}\n{cta}',
  '{saludo}, *{equipo}* volvió al set.{extra}\n{cta}',
  'Planta al día: *{equipo}* en rango.{extra}\n{cta}',
  '{saludo}. Cierro el aviso de *{equipo}*.{extra}\n{cta}',
  'Condición resuelta · *{equipo}*.{extra}\n{cta}',
  '{saludo} — *{equipo}* estable otra vez.{extra}\n{cta}',
  'Monitor: *{equipo}* dentro de límites.{extra}\n{cta}',
  '{saludo}. Buen cierre en *{equipo}*.{extra}\n{cta}',
  'Temperatura *{equipo}* recuperada.{extra}\n{cta}',
  '{saludo}: todo OK en *{equipo}*.{extra}\n{cta}',
  'Aviso verde · *{equipo}*.{extra}\n{cta}',
  '{saludo}. Dejo *{equipo}* como recuperado.{extra}\n{cta}'
]

function aplicarPlantilla(tpl, vars) {
  return tpl
    .replace(/\{saludo\}/g, vars.saludo || 'Hola')
    .replace(/\{equipo\}/g, vars.equipo || 'equipo')
    .replace(/\{grupo\}/g, vars.grupo || '')
    .replace(/\{quePaso\}/g, vars.quePaso || '')
    .replace(/\{dato\}/g, vars.dato || '')
    .replace(/\{cta\}/g, vars.cta || cta(0))
    .replace(/\{horasPart\}/g, vars.horasPart || '')
    .replace(/\{extra\}/g, vars.extra || '')
    .replace(/\{nombrePart\}/g, vars.nombrePart || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function mensajeAlertaVariante(usuario, {
  nombreEquipo,
  imei,
  codigo = 'alerta',
  quePaso = '',
  datoClave = null,
  grupoNombre = null,
  horas = null,
  indiceLote = 0,
  totalUsuarios = 1,
  familia = null
} = {}) {
  const nombre = nombrePila(usuario?.nombre) || ''
  const equipo = nombreEquipo || imei || 'equipo'
  const cod = String(codigo || '').toLowerCase()

  let plantillas = PLANTILLAS_ALERTA
  if (familia === 'fuera' || cod.includes('fuera') || cod.includes('rango')) {
    plantillas = PLANTILLAS_FUERA
  } else if (
    familia === 'sin_dato' ||
    ['wait', 'offline', 'fuera_linea'].includes(cod) ||
    cod.includes('linea') ||
    cod.includes('wait') ||
    cod.includes('offline')
  ) {
    plantillas = PLANTILLAS_SIN_DATO
  } else if (familia === 'recuperacion' || cod === 'en_rango') {
    plantillas = PLANTILLAS_OK_RANGO
  }

  const idx = indiceVariante({
    usuarioId: usuario?.id,
    imei,
    codigo: cod,
    indiceLote,
    totalUsuarios,
    totalVariantes: plantillas.length
  })

  const horasTxt = fmtHoras(horas)
  const vars = {
    saludo: saludo(nombre, idx),
    equipo,
    grupo: grupoNombre ? ` (${grupoNombre})` : '',
    quePaso: quePaso || '',
    dato: datoClave ? `\n${datoClave}` : '',
    cta: cta(idx),
    horasPart: horasTxt ? ` (~${horasTxt})` : '',
    extra: horasTxt ? ` Había estado desviado ~${horasTxt}.` : '',
    nombrePart: nombre ? ` ${nombre}` : ''
  }

  return {
    texto: aplicarPlantilla(plantillas[idx], vars),
    variante: idx,
    totalVariantes: plantillas.length
  }
}

module.exports = {
  mensajeAlertaVariante,
  indiceVariante,
  PLANTILLAS_ALERTA,
  pick
}
