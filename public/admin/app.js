const API = '/api'
let secret = sessionStorage.getItem('api_secret') || ''
let equiposCache = []
let gruposCache = []
let dispositivosCache = []
let usuariosCache = []
let filtroEstado = ''
let testDispositivoId = null

// ── Auth ────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Secret': secret,
      ...(opts.headers || {})
    }
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`)
  return data
}

async function login() {
  secret = document.getElementById('login-secret').value.trim()
  try {
    await api('/bot/status')
    sessionStorage.setItem('api_secret', secret)
    document.getElementById('login-screen').classList.add('hidden')
    document.getElementById('app').classList.remove('hidden')
    initApp()
  } catch {
    const el = document.getElementById('login-error')
    el.textContent = 'Token inválido. Verifica API_SECRET en .env'
    el.classList.remove('hidden')
  }
}

function logout() {
  sessionStorage.removeItem('api_secret')
  location.reload()
}

// ── Navegación ──────────────────────────────────────────────

document.querySelectorAll('.nav-item[data-section]').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'))
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'))
    el.classList.add('active')
    document.getElementById('sec-' + el.dataset.section).classList.add('active')
    const loaders = {
      dashboard: cargarDashboard,
      dispositivos: cargarDispositivos,
      grupos: cargarGrupos,
      asignaciones: cargarAsignaciones,
      usuarios: cargarUsuarios,
      equipos: cargarEquipos,
      alertas: () => cargarAlertas(true),
      config: cargarConfig
    }
    loaders[el.dataset.section]?.()
  })
})

document.getElementById('disp-filters').addEventListener('click', e => {
  const btn = e.target.closest('.filter-btn')
  if (!btn) return
  document.querySelectorAll('#disp-filters .filter-btn').forEach(b => b.classList.remove('active'))
  btn.classList.add('active')
  filtroEstado = btn.dataset.estado
  cargarDispositivos()
})

// ── Utilidades ──────────────────────────────────────────────

function toast(msg, type = 'success') {
  const el = document.createElement('div')
  el.className = `toast ${type}`
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 3500)
}

function fmtFecha(f) {
  if (!f) return '—'
  return new Date(f).toLocaleString('es-PE', { timeZone: 'America/Lima' })
}

function badgeEstado(e) {
  const cls = { online: 'badge-online', wait: 'badge-wait', offline: 'badge-offline' }
  return `<span class="badge ${cls[e] || ''}">${e || '—'}</span>`
}

function cerrarModal(id) { document.getElementById(id).classList.add('hidden') }

// ── Dashboard ───────────────────────────────────────────────

async function cargarDashboard() {
  try {
    const [stats, bot] = await Promise.all([
      api('/dispositivos/stats'),
      api('/bot/status')
    ])
    const map = Object.fromEntries(stats.map(s => [s.estado_conexion, s]))
    document.getElementById('stats-grid').innerHTML = `
      <div class="stat-card online"><div class="label">Online</div><div class="value">${map.online?.total || 0}</div></div>
      <div class="stat-card wait"><div class="label">Wait</div><div class="value">${map.wait?.total || 0}</div></div>
      <div class="stat-card offline"><div class="label">Offline</div><div class="value">${map.offline?.total || 0}</div></div>
      <div class="stat-card"><div class="label">Con alarma activa</div><div class="value">${stats.reduce((a, s) => a + (s.con_alarma || 0), 0)}</div></div>
    `
    document.getElementById('bot-status-text').innerHTML = bot.conectado
      ? `<span class="status-dot on"></span>Conectado (${bot.usuario || 'WhatsApp'})`
      : `<span class="status-dot off"></span>Desconectado — escanea QR en puerto 9300`
  } catch (err) { toast(err.message, 'error') }
}

async function syncDispositivos(conAlertas) {
  try {
    toast('Sincronizando dispositivos…')
    const q = conAlertas ? '?alertas=true' : ''
    const r = await api('/dispositivos/sync' + q, { method: 'POST' })
    const detalle = (r.por_link || [])
      .map(l => l.error ? `${l.link_id}: error` : `${l.link_id}: ${l.sincronizados}`)
      .join(' · ')
    toast(`Sincronizados ${r.sincronizados} dispositivos${detalle ? ` (${detalle})` : ''}`)
    cargarDashboard()
    if (document.getElementById('sec-dispositivos').classList.contains('active')) cargarDispositivos()
  } catch (err) { toast(err.message, 'error') }
}

// ── Dispositivos ────────────────────────────────────────────

async function cargarDispositivos() {
  try {
    const q = filtroEstado ? `?estado=${filtroEstado}` : ''
    dispositivosCache = await api('/dispositivos' + q)
    renderDispositivos()
  } catch (err) { toast(err.message, 'error') }
}

function renderDispositivos() {
  const buscar = (document.getElementById('disp-buscar')?.value || '').trim().toLowerCase()
  const tbody = document.getElementById('tbody-dispositivos')
  const contador = document.getElementById('disp-buscar-contador')

  const list = dispositivosCache.filter(d => {
    if (!buscar) return true
    const txt = `${d.imei} ${d.nombre || ''} ${d.last_ip || ''} ${d.link_origen || ''} ${d.estado_conexion}`.toLowerCase()
    return txt.includes(buscar)
  })

  if (contador) {
    contador.textContent = buscar
      ? `${list.length} de ${dispositivosCache.length} dispositivo(s)`
      : `${dispositivosCache.length} dispositivo(s)`
  }

  if (!list.length) {
    tbody.innerHTML = buscar
      ? '<tr><td colspan="9" class="empty">Ningún dispositivo coincide con la búsqueda.</td></tr>'
      : '<tr><td colspan="9" class="empty">Sin dispositivos. Pulsa Sincronizar API.</td></tr>'
    return
  }
  tbody.innerHTML = list.map(d => `
      <tr>
        <td><span class="badge badge-link">${d.link_origen || 'link1'}</span></td>
        <td>
          <label class="switch">
            <input type="checkbox" ${d.alarmas_activas ? 'checked' : ''} onchange="toggleAlarma(${d.id}, this.checked)">
            <span class="slider"></span>
          </label>
        </td>
        <td><code>${d.imei}</code></td>
        <td>${d.nombre || '<span style="color:var(--muted)">Sin nombre</span>'}</td>
        <td>${badgeEstado(d.estado_conexion)}</td>
        <td>${d.total_usuarios > 0
          ? `<span class="badge badge-ok">${d.total_usuarios}</span>`
          : '<span class="badge badge-off">0</span>'}</td>
        <td>${fmtFecha(d.ultimo_dato)}</td>
        <td>${d.last_ip || '—'}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm btn-secondary" onclick="abrirControlDisp(${d.id})" title="Configurar monitoreo">⚙️</button>
          <button class="btn btn-sm btn-primary" onclick="abrirTestAlarma(${d.id})" title="Enviar prueba">🧪</button>
          <button class="btn btn-sm btn-secondary" onclick="editarNombreDisp(${d.id}, '${(d.nombre || '').replace(/'/g, "\\'")}')">✏️</button>
        </td>
      </tr>
    `).join('')
}

async function toggleAlarma(id, activa) {
  try {
    await api(`/dispositivos/${id}/alarma`, { method: 'PATCH', body: JSON.stringify({ activa }) })
    toast(activa ? 'Monitoreo activado' : 'Monitoreo desactivado')
    if (activa) abrirControlDisp(id)
    else cargarDispositivos()
  } catch (err) {
    toast(err.message, 'error')
    cargarDispositivos()
  }
}

let controlDispId = null

async function abrirControlDisp(id) {
  controlDispId = id
  document.getElementById('control-disp-id').value = id
  document.getElementById('modal-control').classList.remove('hidden')
  await cargarLiveControl(id)
}

function toDatetimeLocal(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromDatetimeLocal(val) {
  if (!val) return null
  return new Date(val).toISOString()
}

function toggleCaVariacion() {
  const tipo = document.getElementById('ca-tipo-fruta')?.value || ''
  const wrap = document.getElementById('ca-variacion-wrap')
  const input = document.getElementById('ca-variacion')
  const esPalta = /palta|aguacate/i.test(tipo)
  if (wrap) wrap.style.display = esPalta || tipo === 'Otro' ? '' : 'none'
  if (esPalta && input && !input.value) input.value = 'HASS'
}

function actualizarHintMaquinaCa() {
  const receta = (document.getElementById('ca-receta')?.value || '').trim()
  const hint = document.getElementById('ca-maquina-auto-hint')
  const serie = document.getElementById('ca-maquina-serie')
  if (receta === 'PRUEBA CA 19/05/2026') {
    hint?.classList.remove('hidden')
    if (serie && !serie.value) serie.value = 'CIM1086751'
  } else {
    hint?.classList.add('hidden')
  }
}

document.getElementById('ca-receta')?.addEventListener('input', actualizarHintMaquinaCa)

async function cargarProcesoCa(id) {
  try {
    const { proceso } = await api(`/dispositivos/${id}/proceso-ca`)
    const p = proceso || {}
    document.getElementById('ca-receta').value = p.receta || ''
    document.getElementById('ca-tipo-fruta').value = p.tipo_fruta || ''
    document.getElementById('ca-variacion').value = p.variacion || ''
    document.getElementById('ca-procedencia').value = p.procedencia || ''
    document.getElementById('ca-fecha-inicio').value = toDatetimeLocal(p.fecha_inicio)
    document.getElementById('ca-fecha-fin').value = toDatetimeLocal(p.fecha_fin)
    document.getElementById('ca-maquina-serie').value = p.maquina_serie || ''
    toggleCaVariacion()
    actualizarHintMaquinaCa()
  } catch {
    /* sin proceso CA aún */
  }
}

async function guardarProcesoCa(id) {
  const body = {
    receta: document.getElementById('ca-receta').value,
    tipo_fruta: document.getElementById('ca-tipo-fruta').value,
    variacion: document.getElementById('ca-variacion').value,
    procedencia: document.getElementById('ca-procedencia').value,
    fecha_inicio: fromDatetimeLocal(document.getElementById('ca-fecha-inicio').value),
    fecha_fin: fromDatetimeLocal(document.getElementById('ca-fecha-fin').value),
    maquina_serie: document.getElementById('ca-maquina-serie').value
  }
  const vacio = !body.receta && !body.tipo_fruta && !body.procedencia && !body.fecha_inicio && !body.fecha_fin
  if (vacio) {
    await api(`/dispositivos/${id}/proceso-ca`, { method: 'PUT', body: JSON.stringify({ limpiar: true }) })
    return
  }
  await api(`/dispositivos/${id}/proceso-ca`, { method: 'PUT', body: JSON.stringify(body) })
}

async function cargarLiveControl(id) {
  try {
    const data = await api(`/dispositivos/${id}/live`)
    const d = data.dispositivo
    document.getElementById('control-disp-info').innerHTML =
      `<strong>${d.nombre || d.imei}</strong> · IMEI ${d.imei} · ${badgeEstado(d.estado_conexion)}`

    const offlineMsg = document.getElementById('control-offline-msg')
    offlineMsg.classList.toggle('hidden', d.estado_conexion === 'online')

    document.getElementById('control-set').value = d.set_control ?? ''
    document.getElementById('control-delta').value = d.delta ?? ''
    document.getElementById('control-sensor').value = d.sensor_control || 'return_air'
    document.getElementById('control-alerta-setpoint').checked = d.alerta_setpoint !== false
    document.getElementById('control-alarma-activa').checked = d.alarmas_activas

    const grid = document.getElementById('control-sensores')
    const sensores = data.sensores.length ? data.sensores : [
      { label: 'Sensor de Suministro', valor: d.temp_supply_1 },
      { label: 'Sensor de Retorno', valor: d.return_air },
      { label: 'Sensor de Evaporador', valor: d.evaporation_coil },
      { label: 'Set de Temperatura', valor: d.set_point_live },
      { label: 'Temperatura de Compresor', valor: d.compress_coil_1 }
    ]

    grid.innerHTML = sensores.map(s => `
      <div class="stat-card">
        <div class="label">${s.label}</div>
        <div class="value" style="font-size:1.4rem">${s.valor != null ? s.valor + '°C' : '—'}</div>
      </div>
    `).join('')

    const errEl = document.getElementById('control-live-error')
    if (data.error) {
      errEl.textContent = data.error
      errEl.classList.remove('hidden')
    } else {
      errEl.classList.add('hidden')
    }

    const rangoEl = document.getElementById('control-rango-info')
    if (data.rango) {
      const r = data.rango
      rangoEl.textContent = `Rango válido (${r.sensor}): ${r.min}°C a ${r.max}°C · Set ${r.set}°C ±${r.delta}°C`
    } else {
      rangoEl.textContent = 'Configure set/delta o espere datos live para ver el rango.'
    }
    await cargarProcesoCa(id)
  } catch (err) { toast(err.message, 'error') }
}

function refrescarLiveControl() {
  if (controlDispId) cargarLiveControl(controlDispId)
}

async function guardarMonitoreo(e) {
  e.preventDefault()
  const id = parseInt(document.getElementById('control-disp-id').value)
  const setVal = document.getElementById('control-set').value
  const deltaVal = document.getElementById('control-delta').value
  const body = {
    set_control: setVal !== '' ? parseFloat(setVal) : null,
    delta: deltaVal !== '' ? parseFloat(deltaVal) : null,
    sensor_control: document.getElementById('control-sensor').value,
    alerta_setpoint: document.getElementById('control-alerta-setpoint').checked,
    alarmas_activas: document.getElementById('control-alarma-activa').checked
  }
  try {
    const r = await api(`/dispositivos/${id}/monitoreo`, { method: 'PUT', body: JSON.stringify(body) })
    await guardarProcesoCa(id)
    const alertas = r.evaluacion?.alertas || []
    toast(alertas.length
      ? `Guardado. Alertas: ${alertas.join(', ')}`
      : 'Configuración guardada')
    cerrarModal('modal-control')
    cargarDispositivos()
  } catch (err) { toast(err.message, 'error') }
}

async function evaluarAhora() {
  if (!controlDispId) return
  try {
    const r = await api(`/dispositivos/${controlDispId}/evaluar`, { method: 'POST' })
    if (r.online === false) {
      toast(`Dispositivo ${r.estado}. Alertas: ${(r.alertas || []).join(', ') || 'ninguna'}`, r.alertas?.length ? 'error' : 'success')
    } else if (r.alertas?.length) {
      toast(`Alertas generadas: ${r.alertas.join(', ')}`, 'error')
    } else {
      toast('Evaluación OK — sin alertas')
    }
    await cargarLiveControl(controlDispId)
  } catch (err) { toast(err.message, 'error') }
}

async function editarNombreDisp(id, actual) {
  const nombre = prompt('Nombre del dispositivo:', actual)
  if (nombre === null) return
  try {
    await api(`/dispositivos/${id}/nombre`, { method: 'PATCH', body: JSON.stringify({ nombre }) })
    toast('Nombre actualizado')
    cargarDispositivos()
  } catch (err) { toast(err.message, 'error') }
}

async function abrirTestAlarma(id) {
  testDispositivoId = id
  try {
    const { dispositivo, usuarios } = await api(`/dispositivos/${id}/usuarios`)
    const nombre = dispositivo.nombre || dispositivo.imei
    document.getElementById('test-disp-info').textContent =
      `Reefer: ${nombre} · IMEI ${dispositivo.imei} · Estado: ${dispositivo.estado_conexion}`

    const lista = document.getElementById('test-usuarios-list')
    const sinUsuarios = document.getElementById('test-sin-usuarios')
    const wrap = document.getElementById('test-usuarios-wrap')
    const btn = document.getElementById('btn-confirmar-test')

    if (!usuarios.length) {
      wrap.classList.add('hidden')
      sinUsuarios.classList.remove('hidden')
      btn.disabled = true
    } else {
      wrap.classList.remove('hidden')
      sinUsuarios.classList.add('hidden')
      btn.disabled = false
      lista.innerHTML = usuarios.map(u =>
        `<li style="padding:8px 0;border-bottom:1px solid var(--border)">
          <strong>${u.nombre}</strong> · ${u.telefono}
        </li>`
      ).join('')
    }

    document.getElementById('modal-test').classList.remove('hidden')
  } catch (err) { toast(err.message, 'error') }
}

async function confirmarTestAlarma() {
  if (!testDispositivoId) return
  const btn = document.getElementById('btn-confirmar-test')
  btn.disabled = true
  btn.textContent = 'Enviando…'
  try {
    const r = await api(`/dispositivos/${testDispositivoId}/test-alarma`, { method: 'POST' })
    if (r.advertencia) {
      toast(r.advertencia, 'error')
    } else {
      toast(`Prueba enviada a ${r.enviados}/${r.total_usuarios} usuarios`)
      cerrarModal('modal-test')
    }
  } catch (err) {
    toast(err.message, 'error')
  } finally {
    btn.disabled = false
    btn.textContent = 'Enviar prueba'
  }
}

let grupoDispSeleccionados = new Set()
let grupoDispFiltroEstado = ''

// ── Grupos ──────────────────────────────────────────────────

async function cargarGrupos() {
  try {
    gruposCache = await api('/grupos')
    document.getElementById('tbody-grupos').innerHTML = gruposCache.length
      ? gruposCache.map(g => `
        <tr>
          <td><strong>${g.nombre}</strong></td>
          <td>${g.descripcion || '—'}</td>
          <td><span class="badge badge-ok">${g.total_dispositivos}</span></td>
          <td><span class="badge badge-ok">${g.total_usuarios}</span></td>
          <td>${g.activo ? '✅' : '—'}</td>
          <td>
            <button class="btn btn-sm btn-secondary" onclick="editarGrupo(${g.id})">Editar</button>
            <button class="btn btn-sm btn-danger" onclick="eliminarGrupo(${g.id})">Eliminar</button>
          </td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="empty">No hay grupos. Crea uno para agrupar dispositivos.</td></tr>'
  } catch (err) { toast(err.message, 'error') }
}

async function llenarSelectDispositivos(selectId, selected = []) {
  if (!dispositivosCache.length) dispositivosCache = await api('/dispositivos')
  const sel = document.getElementById(selectId)
  sel.innerHTML = dispositivosCache.map(d =>
    `<option value="${d.id}" ${selected.includes(d.id) ? 'selected' : ''}>${d.nombre || d.imei} (${d.estado_conexion})</option>`
  ).join('')
}

async function llenarSelectGrupos(selectId, selected = []) {
  if (!gruposCache.length) gruposCache = await api('/grupos')
  const sel = document.getElementById(selectId)
  sel.innerHTML = gruposCache.filter(g => g.activo !== false).map(g =>
    `<option value="${g.id}" ${selected.includes(g.id) ? 'selected' : ''}>${g.nombre}</option>`
  ).join('')
}

async function initGrupoDispositivos(selectedIds = []) {
  if (!dispositivosCache.length) dispositivosCache = await api('/dispositivos')
  grupoDispSeleccionados = new Set(selectedIds)
  grupoDispFiltroEstado = ''
  document.getElementById('grupo-disp-buscar').value = ''
  document.querySelectorAll('#grupo-disp-filtros .filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.estado === '')
  })
  renderGrupoDispositivos()
}

function filtrarGrupoDispositivos() {
  renderGrupoDispositivos()
}

function renderGrupoDispositivos() {
  const buscar = (document.getElementById('grupo-disp-buscar')?.value || '').trim().toLowerCase()
  const lista = document.getElementById('grupo-disp-lista')
  const vacio = document.getElementById('grupo-disp-vacio')
  const chips = document.getElementById('grupo-disp-seleccionados')
  const contador = document.getElementById('grupo-disp-contador')

  const filtrados = dispositivosCache.filter(d => {
    if (grupoDispFiltroEstado && d.estado_conexion !== grupoDispFiltroEstado) return false
    if (!buscar) return true
    const txt = `${d.imei} ${d.nombre || ''} ${d.last_ip || ''} ${d.estado_conexion}`.toLowerCase()
    return txt.includes(buscar)
  })

  contador.textContent = `${grupoDispSeleccionados.size} seleccionados`

  const seleccionados = dispositivosCache.filter(d => grupoDispSeleccionados.has(d.id))
  if (seleccionados.length) {
    chips.classList.remove('hidden')
    chips.innerHTML = seleccionados.map(d => `
      <span class="grupo-chip">
        ${d.nombre || d.imei}
        <button type="button" onclick="toggleGrupoDisp(${d.id}, false)" title="Quitar">×</button>
      </span>
    `).join('')
  } else {
    chips.classList.add('hidden')
    chips.innerHTML = ''
  }

  if (!filtrados.length) {
    lista.innerHTML = ''
    vacio.classList.remove('hidden')
    return
  }
  vacio.classList.add('hidden')

  lista.innerHTML = filtrados.map(d => {
    const sel = grupoDispSeleccionados.has(d.id)
    return `
      <label class="disp-picker-item ${sel ? 'selected in-group' : ''}" data-id="${d.id}">
        <input type="checkbox" ${sel ? 'checked' : ''} onchange="toggleGrupoDisp(${d.id}, this.checked)">
        <div>
          <div class="imei">${d.imei}</div>
          <div style="font-size:0.8rem;color:var(--muted)">${d.nombre || 'Sin nombre'}</div>
        </div>
        <div class="meta">${badgeEstado(d.estado_conexion)} ${d.last_ip || ''}</div>
      </label>`
  }).join('')
}

function toggleGrupoDisp(id, checked) {
  if (checked) grupoDispSeleccionados.add(id)
  else grupoDispSeleccionados.delete(id)
  renderGrupoDispositivos()
}

function grupoSeleccionarVisibles(agregar) {
  const buscar = (document.getElementById('grupo-disp-buscar')?.value || '').trim().toLowerCase()
  dispositivosCache.forEach(d => {
    if (grupoDispFiltroEstado && d.estado_conexion !== grupoDispFiltroEstado) return
    if (buscar) {
      const txt = `${d.imei} ${d.nombre || ''} ${d.last_ip || ''}`.toLowerCase()
      if (!txt.includes(buscar)) return
    }
    if (agregar) grupoDispSeleccionados.add(d.id)
    else grupoDispSeleccionados.delete(d.id)
  })
  renderGrupoDispositivos()
}

function grupoLimpiarSeleccion() {
  grupoDispSeleccionados.clear()
  renderGrupoDispositivos()
}

document.getElementById('grupo-disp-filtros')?.addEventListener('click', e => {
  const btn = e.target.closest('.filter-btn')
  if (!btn) return
  document.querySelectorAll('#grupo-disp-filtros .filter-btn').forEach(b => b.classList.remove('active'))
  btn.classList.add('active')
  grupoDispFiltroEstado = btn.dataset.estado
  renderGrupoDispositivos()
})

async function abrirModalGrupo() {
  document.getElementById('grupo-id').value = ''
  document.getElementById('grupo-nombre').value = ''
  document.getElementById('grupo-descripcion').value = ''
  document.getElementById('grupo-activo').checked = true
  document.getElementById('modal-grupo-titulo').textContent = 'Nuevo grupo'
  await initGrupoDispositivos([])
  document.getElementById('modal-grupo').classList.remove('hidden')
}

async function editarGrupo(id) {
  const g = await api(`/grupos/${id}`)
  document.getElementById('grupo-id').value = g.id
  document.getElementById('grupo-nombre').value = g.nombre
  document.getElementById('grupo-descripcion').value = g.descripcion || ''
  document.getElementById('grupo-activo').checked = g.activo
  document.getElementById('modal-grupo-titulo').textContent = 'Editar grupo'
  await initGrupoDispositivos((g.dispositivos || []).map(d => d.id))
  document.getElementById('modal-grupo').classList.remove('hidden')
}

async function guardarGrupo(e) {
  e.preventDefault()
  const id = document.getElementById('grupo-id').value
  const dispositivo_ids = [...grupoDispSeleccionados]
  const body = {
    nombre: document.getElementById('grupo-nombre').value,
    descripcion: document.getElementById('grupo-descripcion').value,
    activo: document.getElementById('grupo-activo').checked,
    dispositivo_ids
  }
  try {
    if (id) await api(`/grupos/${id}`, { method: 'PUT', body: JSON.stringify(body) })
    else await api('/grupos', { method: 'POST', body: JSON.stringify(body) })
    toast(`Grupo guardado con ${dispositivo_ids.length} dispositivo(s)`)
    cerrarModal('modal-grupo')
    cargarGrupos()
  } catch (err) { toast(err.message, 'error') }
}

async function eliminarGrupo(id) {
  if (!confirm('¿Eliminar este grupo?')) return
  try {
    await api(`/grupos/${id}`, { method: 'DELETE' })
    toast('Grupo eliminado')
    cargarGrupos()
  } catch (err) { toast(err.message, 'error') }
}

// ── Asignaciones masivas ────────────────────────────────────

const asigGruposSel = new Set()
const asigDispSel = new Set()
const asigEquiposSel = new Set()

async function cargarAsignaciones() {
  try {
    usuariosCache = await api('/usuarios')
    if (!dispositivosCache.length) dispositivosCache = await api('/dispositivos')
    if (!gruposCache.length) gruposCache = await api('/grupos')
    if (!equiposCache.length) equiposCache = await api('/equipos')
    asigGruposSel.clear()
    asigDispSel.clear()
    asigEquiposSel.clear()
    renderAsigUsuarios()
    renderAsigGrupos()
    renderAsigDispositivos()
    renderAsigEquipos()
    actualizarAsignacionesActuales()
  } catch (err) { toast(err.message, 'error') }
}

function renderAsigUsuarios() {
  const buscar = (document.getElementById('asig-user-buscar')?.value || '').trim().toLowerCase()
  const selected = getSelectedIds('.asig-user-cb')
  const list = document.getElementById('asig-usuarios-list')
  if (!list) return

  const filtrados = usuariosCache.filter(u => {
    if (!buscar) return true
    return `${u.nombre} ${u.telefono}`.toLowerCase().includes(buscar)
  })

  list.innerHTML = filtrados.map(u => {
    const sel = selected.includes(u.id)
    return `
      <label class="${sel ? 'asig-user-selected' : ''}">
        <input type="checkbox" class="asig-user-cb" value="${u.id}" ${sel ? 'checked' : ''}
          onchange="onAsigUsuarioChange()">
        <span>${u.nombre} · ${u.telefono}</span>
        ${!u.activo ? '<span class="badge badge-off" style="margin-left:auto">Inactivo</span>' : ''}
      </label>`
  }).join('')

  document.getElementById('btn-test-estado').disabled = !selected.length
}

function onAsigUsuarioChange() {
  renderAsigUsuarios()
  actualizarAsignacionesActuales()
}

function toggleTodosUsuarios(checked) {
  document.querySelectorAll('.asig-user-cb').forEach(cb => { cb.checked = checked })
  onAsigUsuarioChange()
}

function getSelectedIds(className) {
  return [...document.querySelectorAll(className + ':checked')].map(cb => parseInt(cb.value))
}

function renderAsigGrupos() {
  const buscar = (document.getElementById('asig-grupos-buscar')?.value || '').trim().toLowerCase()
  const el = document.getElementById('asig-grupos-list')
  if (!el) return
  const filtrados = gruposCache.filter(g => {
    if (!g.activo && !asigGruposSel.has(g.id)) return false
    if (!buscar) return true
    return `${g.nombre} ${g.descripcion || ''}`.toLowerCase().includes(buscar)
  })
  el.innerHTML = filtrados.map(g => `
    <label>
      <input type="checkbox" ${asigGruposSel.has(g.id) ? 'checked' : ''}
        onchange="toggleAsigGrupo(${g.id}, this.checked)">
      ${g.nombre}${g.descripcion ? ` <span style="color:var(--muted);font-size:0.8rem">— ${g.descripcion.slice(0,40)}</span>` : ''}
    </label>
  `).join('') || '<p class="hint">Sin grupos</p>'
}

function renderAsigDispositivos() {
  const buscar = (document.getElementById('asig-disp-buscar')?.value || '').trim().toLowerCase()
  const el = document.getElementById('asig-dispositivos-list')
  if (!el) return
  const filtrados = dispositivosCache.filter(d => {
    if (!buscar) return true
    return `${d.imei} ${d.nombre || ''}`.toLowerCase().includes(buscar)
  }).slice(0, 200)
  el.innerHTML = filtrados.map(d => `
    <label>
      <input type="checkbox" ${asigDispSel.has(d.id) ? 'checked' : ''}
        onchange="toggleAsigDisp(${d.id}, this.checked)">
      ${d.imei} · ${d.nombre || 'Sin nombre'} ${badgeEstado(d.estado_conexion)}
    </label>
  `).join('') || '<p class="hint">Sin dispositivos</p>'
}

function renderAsigEquipos() {
  const buscar = (document.getElementById('asig-equipos-buscar')?.value || '').trim().toLowerCase()
  const el = document.getElementById('asig-equipos-list')
  if (!el) return
  const filtrados = equiposCache.filter(e => {
    if (!buscar) return true
    return `${e.id_equipo} ${e.nombre || ''} ${e.imei || ''}`.toLowerCase().includes(buscar)
  })
  el.innerHTML = filtrados.map(e => `
    <label>
      <input type="checkbox" ${asigEquiposSel.has(e.id) ? 'checked' : ''}
        onchange="toggleAsigEquipo(${e.id}, this.checked)">
      ${e.nombre || e.id_equipo} · ${e.imei || '—'}
    </label>
  `).join('') || '<p class="hint">Sin equipos</p>'
}

function toggleAsigGrupo(id, checked) {
  if (checked) asigGruposSel.add(id); else asigGruposSel.delete(id)
}
function toggleAsigDisp(id, checked) {
  if (checked) asigDispSel.add(id); else asigDispSel.delete(id)
}
function toggleAsigEquipo(id, checked) {
  if (checked) asigEquiposSel.add(id); else asigEquiposSel.delete(id)
}

async function actualizarAsignacionesActuales() {
  const ids = getSelectedIds('.asig-user-cb')
  const hint = document.getElementById('asig-actuales-hint')
  const content = document.getElementById('asig-actuales-content')

  if (!ids.length) {
    hint.classList.remove('hidden')
    content.classList.add('hidden')
    content.innerHTML = ''
    return
  }

  hint.classList.add('hidden')
  content.classList.remove('hidden')
  content.innerHTML = '<p class="hint">Cargando asignaciones...</p>'

  try {
    const datos = await Promise.all(ids.map(id => api(`/usuarios/${id}/asignaciones`)))
    content.innerHTML = datos.map((d, i) => renderAsignacionesUsuario(d, ids[i])).join('')
  } catch (err) {
    content.innerHTML = `<p class="hint" style="color:var(--red)">${err.message}</p>`
  }
}

function renderAsignacionesUsuario(data, userId) {
  const u = data.usuario
  const gruposHtml = (u.grupos || []).length
    ? (u.grupos || []).map(g => `<span class="asig-tag grupo">${g.nombre}</span>`).join('')
    : '<span class="hint">Sin grupos</span>'

  const dispDirectos = (u.dispositivos || []).map(d =>
    `<span class="asig-tag disp">${d.nombre || d.imei}</span>`).join('') || ''
  const equiposHtml = (u.equipos || []).map(e =>
    `<span class="asig-tag equipo">${e.nombre || e.id_equipo}</span>`).join('') || ''

  const gruposDet = (data.grupos || []).map(g => {
    const disps = g.dispositivos.map(d =>
      `<span class="asig-tag disp">${d.nombre || d.imei} <span class="badge badge-link">${d.link_origen || 'link1'}</span> ${badgeEstado(d.estado_conexion)}</span>`
    ).join('')
    return `<div class="asig-actuales-block"><h4>📁 ${g.nombre} (${g.dispositivos.length})</h4><div class="asig-tag-list">${disps || '<span class="hint">Vacío</span>'}</div></div>`
  }).join('')

  const indHtml = (data.individuales || []).length
    ? `<div class="asig-actuales-block"><h4>📱 Individual (${data.individuales.length})</h4><div class="asig-tag-list">${data.individuales.map(d =>
        `<span class="asig-tag disp">${d.nombre || d.imei} <span class="badge badge-link">${d.link_origen || 'link1'}</span> ${badgeEstado(d.estado_conexion)}</span>`
      ).join('')}</div></div>`
    : ''

  return `
    <div class="asig-actuales-block" style="border-bottom:1px solid var(--border);padding-bottom:12px;margin-bottom:12px">
      <h4 style="color:var(--text);font-size:1rem">👤 ${u.nombre} · ${u.telefono}</h4>
      <div class="asig-actuales-block"><h4>Grupos asignados</h4><div class="asig-tag-list">${gruposHtml}</div></div>
      ${dispDirectos ? `<div class="asig-actuales-block"><h4>Dispositivos directos</h4><div class="asig-tag-list">${dispDirectos}</div></div>` : ''}
      ${equiposHtml ? `<div class="asig-actuales-block"><h4>Equipos</h4><div class="asig-tag-list">${equiposHtml}</div></div>` : ''}
      ${gruposDet || indHtml ? `<div class="asig-actuales-block"><h4>Dispositivos por grupo</h4>${gruposDet}${indHtml}</div>` : ''}
    </div>`
}

async function aplicarAsignacionMasiva() {
  const usuario_ids = getSelectedIds('.asig-user-cb')
  if (!usuario_ids.length) return toast('Selecciona al menos un usuario', 'error')

  const grupo_ids = [...asigGruposSel]
  const dispositivo_ids = [...asigDispSel]
  const equipo_ids = [...asigEquiposSel]
  const accion = document.getElementById('asig-accion').value

  if (accion !== 'reemplazar' && !grupo_ids.length && !dispositivo_ids.length && !equipo_ids.length) {
    return toast('Selecciona grupos, dispositivos o equipos', 'error')
  }

  if (accion === 'reemplazar' && !confirm('¿Reemplazar TODAS las asignaciones de los usuarios seleccionados?')) return

  try {
    await api('/asignaciones/bulk', {
      method: 'POST',
      body: JSON.stringify({ usuario_ids, grupo_ids, dispositivo_ids, equipo_ids, accion })
    })
    toast(`Asignación aplicada a ${usuario_ids.length} usuario(s)`)
    asigGruposSel.clear()
    asigDispSel.clear()
    asigEquiposSel.clear()
    cargarAsignaciones()
  } catch (err) { toast(err.message, 'error') }
}

let testEstadoUsuarioIds = []
const testEstadoDispSel = new Set()

async function abrirModalTestEstado() {
  const usuario_ids = getSelectedIds('.asig-user-cb')
  if (!usuario_ids.length) return toast('Selecciona al menos un usuario', 'error')

  testEstadoUsuarioIds = usuario_ids
  testEstadoDispSel.clear()
  document.getElementById('test-estado-disp-list').innerHTML = ''
  document.getElementById('test-estado-sin-disp').classList.add('hidden')
  document.getElementById('btn-confirmar-test-estado').disabled = true
  document.getElementById('modal-test-estado').classList.remove('hidden')
  document.getElementById('test-estado-usuarios-info').textContent = 'Cargando dispositivos...'

  try {
    const preview = await api('/asignaciones/test-estado/preview', {
      method: 'POST',
      body: JSON.stringify({ usuario_ids })
    })

    const nombres = (preview.usuarios || []).map(u => u.nombre).join(', ')
    document.getElementById('test-estado-usuarios-info').textContent =
      `Destinatarios: ${nombres || usuario_ids.length + ' usuario(s)'}`

    const disps = preview.dispositivos || []
    if (!disps.length) {
      document.getElementById('test-estado-sin-disp').classList.remove('hidden')
      document.getElementById('test-estado-contador').textContent = '0 dispositivos'
      return
    }

    disps.forEach(d => {
      if (d.tiene_alerta) testEstadoDispSel.add(d.id)
    })

    renderTestEstadoDispositivos(disps)
    document.getElementById('btn-confirmar-test-estado').disabled = false
  } catch (err) {
    toast(err.message, 'error')
    cerrarModal('modal-test-estado')
  }
}

function renderTestEstadoDispositivos(disps) {
  const tbody = document.getElementById('test-estado-disp-list')
  tbody.innerHTML = disps.map(d => {
    const sel = testEstadoDispSel.has(d.id)
    const alertaBadge = d.tiene_alerta
      ? `<span class="badge badge-warn">🚨 ${d.fuera_rango ? 'Fuera rango' : (d.alertas_pendientes || 'Alarma')}</span>`
      : '<span class="badge badge-ok">OK</span>'
    const analisis12h = d.elegible_analisis_12h
      ? '<span class="badge badge-warn" title="Recibirá gráfica 12h">📈 Sí</span>'
      : '<span class="hint">—</span>'
    return `
      <tr class="${sel ? 'test-estado-row-selected' : ''} ${d.tiene_alerta ? 'test-estado-row-alerta' : ''}">
        <td>
          <input type="checkbox" class="test-estado-disp-cb" value="${d.id}" ${sel ? 'checked' : ''}
            onchange="toggleTestEstadoDisp(${d.id}, this.checked)">
        </td>
        <td>
          <div><strong>${d.nombre || d.imei}</strong></div>
          <code style="font-size:0.75rem;color:var(--muted)">${d.imei}</code>
        </td>
        <td>${(d.grupos || []).join(', ') || '—'}</td>
        <td><span class="badge badge-link">${d.link_origen || 'link1'}</span></td>
        <td>${badgeEstado(d.estado_conexion)}</td>
        <td>${alertaBadge}</td>
        <td>${analisis12h}</td>
        <td style="font-size:0.8rem;color:var(--muted)">${(d.usuarios || []).join(', ')}</td>
      </tr>`
  }).join('')

  actualizarContadorTestEstado(disps.length)
  const todos = disps.length > 0 && disps.every(d => testEstadoDispSel.has(d.id))
  document.getElementById('test-estado-sel-todos').checked = todos
}

function toggleTestEstadoDisp(id, checked) {
  if (checked) testEstadoDispSel.add(id)
  else testEstadoDispSel.delete(id)
  const row = document.querySelector(`.test-estado-disp-cb[value="${id}"]`)?.closest('tr')
  if (row) row.classList.toggle('test-estado-row-selected', checked)
  actualizarContadorTestEstado(document.querySelectorAll('.test-estado-disp-cb').length)
  const total = document.querySelectorAll('.test-estado-disp-cb').length
  document.getElementById('test-estado-sel-todos').checked = total > 0 && testEstadoDispSel.size === total
}

function toggleTestEstadoTodos(checked) {
  document.querySelectorAll('.test-estado-disp-cb').forEach(cb => {
    cb.checked = checked
    const id = parseInt(cb.value)
    if (checked) testEstadoDispSel.add(id)
    else testEstadoDispSel.delete(id)
    cb.closest('tr')?.classList.toggle('test-estado-row-selected', checked)
  })
  actualizarContadorTestEstado(document.querySelectorAll('.test-estado-disp-cb').length)
}

function actualizarContadorTestEstado(total) {
  const sel = testEstadoDispSel.size
  document.getElementById('test-estado-contador').textContent =
    `${sel} de ${total} dispositivo(s) seleccionado(s)`
  document.getElementById('btn-confirmar-test-estado').disabled = sel === 0
}

async function confirmarTestEstado() {
  const dispositivo_ids = [...testEstadoDispSel]
  if (!dispositivo_ids.length) return toast('Selecciona al menos un dispositivo', 'error')

  const btn = document.getElementById('btn-confirmar-test-estado')
  btn.disabled = true
  btn.textContent = 'Enviando...'

  try {
    const incluir_analisis_12h = document.getElementById('test-estado-analisis-12h')?.checked !== false
    const res = await api('/asignaciones/test-estado', {
      method: 'POST',
      body: JSON.stringify({ usuario_ids: testEstadoUsuarioIds, dispositivo_ids, incluir_analisis_12h })
    })
    const total = (res.resultados || []).reduce((a, r) => a + (r.enviados || 0), 0)
    const errores = (res.resultados || []).filter(r => r.error || r.advertencia)
    cerrarModal('modal-test-estado')
    if (errores.length) {
      toast(`Enviados ${total} mensaje(s). Avisos: ${errores.map(e => e.error || e.advertencia).join('; ')}`, 'error')
    } else {
      toast(`Estado enviado: ${total} mensaje(s)`)
    }
  } catch (err) {
    toast(err.message, 'error')
  } finally {
    btn.disabled = false
    btn.textContent = 'Enviar estado'
  }
}

// ── Usuarios ────────────────────────────────────────────────

async function cargarUsuarios() {
  try {
    const list = await api('/usuarios')
    usuariosCache = list
    document.getElementById('tbody-usuarios').innerHTML = list.map(u => `
      <tr>
        <td>${u.nombre}</td>
        <td>${u.telefono}</td>
        <td>${(u.grupos || []).map(g => g.nombre).join(', ') || '—'}</td>
        <td>${(u.dispositivos || []).map(d => d.nombre || d.imei).join(', ') || '—'}</td>
        <td>${(u.equipos || []).map(e => e.nombre || e.id_equipo).join(', ') || '—'}</td>
        <td>${u.activo ? '<span class="badge badge-ok">Sí</span>' : '<span class="badge badge-off">No</span>'}</td>
        <td>
          <button class="btn btn-sm btn-secondary" onclick='editarUsuario(${JSON.stringify(u).replace(/'/g, "&#39;")})'>Editar</button>
          <button class="btn btn-sm btn-danger" onclick="eliminarUsuario(${u.id})">Eliminar</button>
        </td>
      </tr>
    `).join('')
  } catch (err) { toast(err.message, 'error') }
}

async function abrirModalUsuario() {
  document.getElementById('usuario-id').value = ''
  document.getElementById('usuario-nombre').value = ''
  document.getElementById('usuario-telefono').value = ''
  document.getElementById('usuario-activo').checked = true
  document.getElementById('modal-usuario-titulo').textContent = 'Nuevo usuario'
  await Promise.all([
    llenarSelectGrupos('usuario-grupos'),
    llenarSelectDispositivos('usuario-dispositivos'),
    llenarSelectEquipos('usuario-equipos')
  ])
  document.getElementById('modal-usuario').classList.remove('hidden')
}

function editarUsuario(u) {
  document.getElementById('usuario-id').value = u.id
  document.getElementById('usuario-nombre').value = u.nombre
  document.getElementById('usuario-telefono').value = u.telefono
  document.getElementById('usuario-activo').checked = u.activo
  document.getElementById('modal-usuario-titulo').textContent = 'Editar usuario'
  llenarSelectGrupos('usuario-grupos', (u.grupos || []).map(g => g.id))
  llenarSelectDispositivos('usuario-dispositivos', (u.dispositivos || []).map(d => d.id))
  llenarSelectEquipos('usuario-equipos', (u.equipos || []).map(e => e.id))
  document.getElementById('modal-usuario').classList.remove('hidden')
}

async function guardarUsuario(e) {
  e.preventDefault()
  const id = document.getElementById('usuario-id').value
  const body = {
    nombre: document.getElementById('usuario-nombre').value,
    telefono: document.getElementById('usuario-telefono').value,
    activo: document.getElementById('usuario-activo').checked,
    grupo_ids: [...document.getElementById('usuario-grupos').selectedOptions].map(o => parseInt(o.value)),
    dispositivo_ids: [...document.getElementById('usuario-dispositivos').selectedOptions].map(o => parseInt(o.value)),
    equipo_ids: [...document.getElementById('usuario-equipos').selectedOptions].map(o => parseInt(o.value))
  }
  try {
    if (id) await api(`/usuarios/${id}`, { method: 'PUT', body: JSON.stringify(body) })
    else await api('/usuarios', { method: 'POST', body: JSON.stringify(body) })
    toast('Usuario guardado')
    cerrarModal('modal-usuario')
    cargarUsuarios()
  } catch (err) { toast(err.message, 'error') }
}

async function eliminarUsuario(id) {
  if (!confirm('¿Eliminar este usuario?')) return
  try {
    await api(`/usuarios/${id}`, { method: 'DELETE' })
    toast('Usuario eliminado')
    cargarUsuarios()
  } catch (err) { toast(err.message, 'error') }
}

// ── Equipos ─────────────────────────────────────────────────

async function cargarEquipos() {
  try {
    equiposCache = await api('/equipos')
    document.getElementById('tbody-equipos').innerHTML = equiposCache.map(e => `
      <tr>
        <td><code>${e.id_equipo}</code></td>
        <td>${e.nombre}</td>
        <td>${e.imei || '—'}</td>
        <td>${e.temperatura != null ? e.temperatura + '°C' : '—'}</td>
        <td>${e.ubicacion || '—'}</td>
        <td>${e.alarmas_activas ? '✅' : '—'}</td>
        <td>
          <button class="btn btn-sm btn-secondary" onclick='editarEquipo(${JSON.stringify(e).replace(/'/g, "&#39;")})'>Editar</button>
          <button class="btn btn-sm btn-danger" onclick="eliminarEquipo(${e.id})">Eliminar</button>
        </td>
      </tr>
    `).join('')
  } catch (err) { toast(err.message, 'error') }
}

async function llenarSelectEquipos(selectId, selected = []) {
  if (!equiposCache.length) equiposCache = await api('/equipos')
  const sel = document.getElementById(selectId)
  sel.innerHTML = equiposCache.map(e =>
    `<option value="${e.id}" ${selected.includes(e.id) ? 'selected' : ''}>${e.nombre} (${e.id_equipo})</option>`
  ).join('')
}

function abrirModalEquipo() {
  document.getElementById('equipo-id').value = ''
  document.getElementById('equipo-id_equipo').value = ''
  document.getElementById('equipo-nombre').value = ''
  document.getElementById('equipo-imei').value = ''
  document.getElementById('equipo-ubicacion').value = ''
  document.getElementById('equipo-temp').value = ''
  document.getElementById('equipo-humedad').value = ''
  document.getElementById('equipo-alarma').checked = true
  document.getElementById('modal-equipo-titulo').textContent = 'Nuevo equipo'
  document.getElementById('modal-equipo').classList.remove('hidden')
}

function editarEquipo(e) {
  document.getElementById('equipo-id').value = e.id
  document.getElementById('equipo-id_equipo').value = e.id_equipo
  document.getElementById('equipo-nombre').value = e.nombre
  document.getElementById('equipo-imei').value = e.imei || ''
  document.getElementById('equipo-ubicacion').value = e.ubicacion || ''
  document.getElementById('equipo-temp').value = e.temperatura ?? ''
  document.getElementById('equipo-humedad').value = e.humedad ?? ''
  document.getElementById('equipo-alarma').checked = e.alarmas_activas
  document.getElementById('modal-equipo-titulo').textContent = 'Editar equipo'
  document.getElementById('modal-equipo').classList.remove('hidden')
}

async function guardarEquipo(e) {
  e.preventDefault()
  const id = document.getElementById('equipo-id').value
  const body = {
    id_equipo: document.getElementById('equipo-id_equipo').value,
    nombre: document.getElementById('equipo-nombre').value,
    imei: document.getElementById('equipo-imei').value || null,
    ubicacion: document.getElementById('equipo-ubicacion').value,
    temperatura: parseFloat(document.getElementById('equipo-temp').value) || null,
    humedad: parseFloat(document.getElementById('equipo-humedad').value) || null,
    alarmas_activas: document.getElementById('equipo-alarma').checked
  }
  try {
    if (id) await api(`/equipos/${id}`, { method: 'PUT', body: JSON.stringify(body) })
    else await api('/equipos', { method: 'POST', body: JSON.stringify(body) })
    toast('Equipo guardado')
    cerrarModal('modal-equipo')
    cargarEquipos()
  } catch (err) { toast(err.message, 'error') }
}

async function eliminarEquipo(id) {
  if (!confirm('¿Eliminar este equipo?')) return
  try {
    await api(`/equipos/${id}`, { method: 'DELETE' })
    toast('Equipo eliminado')
    cargarEquipos()
  } catch (err) { toast(err.message, 'error') }
}

// ── Alertas ─────────────────────────────────────────────────

async function cargarAlertas(soloActivas) {
  try {
    const q = soloActivas ? '?activas=true' : ''
    const list = await api('/alertas' + q)
    const tbody = document.getElementById('tbody-alertas')
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">No hay alertas</td></tr>'
      return
    }
    tbody.innerHTML = list.map(a => `
      <tr>
        <td><code>${a.equipo_id}</code></td>
        <td>${a.tipo}</td>
        <td><span class="badge ${a.nivel === 'critico' ? 'badge-offline' : 'badge-wait'}">${a.nivel}</span></td>
        <td>${fmtFecha(a.fecha)}</td>
        <td>${a.resuelta ? '<span class="badge badge-off">Resuelta</span>' : '<span class="badge badge-offline">Activa</span>'}</td>
        <td>${!a.resuelta ? `<button class="btn btn-sm btn-secondary" onclick="resolverAlerta(${a.id})">Resolver</button>` : ''}</td>
      </tr>
    `).join('')
  } catch (err) { toast(err.message, 'error') }
}

async function resolverAlerta(id) {
  try {
    await api(`/alertas/${id}/resolver`, { method: 'PATCH' })
    toast('Alerta resuelta')
    cargarAlertas(true)
  } catch (err) { toast(err.message, 'error') }
}

// ── Config ──────────────────────────────────────────────────

async function cargarConfig() {
  try {
    const qrHost = `${window.location.protocol}//${window.location.hostname}:9300`
    const qrLink = document.getElementById('config-bot-qr-link')
    if (qrLink) {
      qrLink.href = qrHost
      qrLink.textContent = qrHost.replace(/^https?:\/\//, '')
    }
    await actualizarEstadoBotConfig()

    const [cfg, tipos, links] = await Promise.all([
      api('/config'),
      api('/config-alertas'),
      api('/config/links')
    ])
    document.getElementById('cfg-online').value = cfg.online_hasta_horas
    document.getElementById('cfg-wait').value = cfg.wait_hasta_horas
    document.getElementById('cfg-intervalo').value = cfg.intervalo_minutos || 15
    document.getElementById('cfg-alerta-online').checked = cfg.alerta_online
    document.getElementById('cfg-alerta-wait').checked = cfg.alerta_wait
    document.getElementById('cfg-alerta-offline').checked = cfg.alerta_offline

    document.getElementById('config-links-list').innerHTML = links.map(l => `
      <div class="config-link-card" data-link="${l.link_id}">
        <h4>
          <span class="badge badge-link">${l.link_id}</span>
          ${l.nombre}
          <label class="switch" style="margin-left:auto" title="Activo">
            <input type="checkbox" ${l.activo ? 'checked' : ''} onchange="toggleConfigLinkActivo('${l.link_id}', this.checked)">
            <span class="slider"></span>
          </label>
        </h4>
        <div class="form-group">
          <label>URL reporte dispositivos</label>
          <input id="link-${l.link_id}-reporte" value="${l.url_reporte || ''}">
        </div>
        <div class="form-group">
          <label>URL telemetría live</label>
          <input id="link-${l.link_id}-live" value="${l.url_live || ''}">
        </div>
        ${l.link_id === 'link1' ? `
        <div class="form-group">
          <label>URL histórico 12h (análisis fuera de rango)</label>
          <input id="link-${l.link_id}-historico" value="${l.url_historico || ''}">
        </div>` : ''}
        <button type="button" class="btn btn-sm btn-primary" onclick="guardarConfigLink('${l.link_id}')">Guardar ${l.link_id}</button>
      </div>
    `).join('')

    document.getElementById('config-alertas-list').innerHTML = tipos.map(t => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border)">
        <div>
          <strong>${t.tipo}</strong>
          <div style="color:var(--muted);font-size:0.85rem">${t.descripcion || ''}</div>
        </div>
        <label class="switch">
          <input type="checkbox" ${t.activo ? 'checked' : ''} onchange="toggleConfigAlerta('${t.tipo}', this.checked)">
          <span class="slider"></span>
        </label>
      </div>
    `).join('')
  } catch (err) { toast(err.message, 'error') }
}

async function guardarConfig(e) {
  e.preventDefault()
  const body = {
    online_hasta_horas: parseFloat(document.getElementById('cfg-online').value),
    wait_hasta_horas: parseFloat(document.getElementById('cfg-wait').value),
    intervalo_minutos: parseInt(document.getElementById('cfg-intervalo').value),
    alerta_online: document.getElementById('cfg-alerta-online').checked,
    alerta_wait: document.getElementById('cfg-alerta-wait').checked,
    alerta_offline: document.getElementById('cfg-alerta-offline').checked
  }
  try {
    await api('/config', { method: 'PUT', body: JSON.stringify(body) })
    toast('Parámetros guardados')
  } catch (err) { toast(err.message, 'error') }
}

async function guardarConfigLink(link_id) {
  const body = {
    url_reporte: document.getElementById(`link-${link_id}-reporte`).value,
    url_live: document.getElementById(`link-${link_id}-live`).value
  }
  const hist = document.getElementById(`link-${link_id}-historico`)
  if (hist) body.url_historico = hist.value
  try {
    await api(`/config/links/${link_id}`, { method: 'PUT', body: JSON.stringify(body) })
    toast(`${link_id} guardado`)
  } catch (err) { toast(err.message, 'error') }
}

async function toggleConfigLinkActivo(link_id, activo) {
  try {
    await api(`/config/links/${link_id}`, { method: 'PUT', body: JSON.stringify({ activo }) })
    toast(`${link_id} ${activo ? 'activado' : 'desactivado'}`)
  } catch (err) {
    toast(err.message, 'error')
    cargarConfig()
  }
}

async function toggleConfigAlerta(tipo, activo) {
  try {
    await api(`/config-alertas/${tipo}`, { method: 'PUT', body: JSON.stringify({ activo }) })
    toast(`Alerta ${tipo} ${activo ? 'activada' : 'desactivada'}`)
  } catch (err) { toast(err.message, 'error') }
}

async function actualizarEstadoBotConfig() {
  const el = document.getElementById('config-bot-status')
  const pasosEl = document.getElementById('config-bot-pasos')
  try {
    const bot = await api('/bot/diagnostico')
    if (el) {
      el.innerHTML = bot.conectado_socket
        ? `<span class="status-dot on"></span>Conectado — envío <strong>activo</strong>${bot.usuario ? ` (${bot.usuario})` : ''}`
        : `<span class="status-dot off"></span>Fase: <strong>${bot.fase || '—'}</strong> — ${bot.mensaje || 'Sin conexión'}`
    }
    const modoEl = document.getElementById('config-bot-modo')
    if (modoEl) {
      const m = bot.modo_vinculacion === 'pairing' ? 'Código (8 dígitos)' : 'QR (escaneo)'
      const tel = bot.telefono_vinculacion_display
        ? ` · Número del código: <strong>${bot.telefono_vinculacion_display}</strong>`
        : ''
      const cod = bot.codigo_vinculacion
        ? ` · Código actual: <strong>${String(bot.codigo_vinculacion).replace(/(.{4})/, '$1-')}</strong>`
        : ''
      modoEl.innerHTML = `Modo activo: <strong>${m}</strong>${tel}${cod}`
    }
    if (pasosEl) {
      const pasos = bot.pasos || []
      if (!pasos.length) {
        pasosEl.innerHTML = '<li style="color:var(--muted)">Sin pasos aún. Abre el visor QR (9300) o reinicia la vinculación.</li>'
      } else {
        pasosEl.innerHTML = pasos.map(p => `
          <li style="padding:8px 0;border-bottom:1px solid var(--border)">
            <span class="badge ${p.status === 'error' ? 'badge-off' : p.status === 'ok' ? 'badge-ok' : 'badge-warn'}">${p.status || '…'}</span>
            <strong>${p.titulo}</strong> — ${p.detalle || ''}
            <div style="color:var(--muted);font-size:0.75rem">${p.hora || ''}</div>
          </li>`).join('')
      }
      if (bot.recomendacion) {
        pasosEl.innerHTML += `<li style="padding:10px 0;color:var(--yellow)">💡 ${bot.recomendacion}</li>`
      }
      if (bot.ultimo_error) {
        pasosEl.innerHTML += `<li style="padding:10px 0;color:var(--red)">⚠️ ${bot.ultimo_error}</li>`
      }
    }
  } catch (err) {
    if (el) el.textContent = err.message
  }
}

async function vincularPorQrBot() {
  if (!confirm('¿Iniciar vinculación por QR? Se borra cualquier código pendiente y se muestra QR en :9300.')) return
  try {
    toast('Preparando modo QR…')
    const r = await api('/bot/vincular-qr', { method: 'POST', body: '{}' })
    toast(r.mensaje || 'Abre http://localhost:9300')
    setTimeout(actualizarEstadoBotConfig, 2000)
    setTimeout(actualizarEstadoBotConfig, 8000)
  } catch (err) {
    toast(err.message, 'error')
  }
}

async function vincularPorCodigoBot() {
  const tel = document.getElementById('config-whatsapp-phone')?.value?.trim()
  if (!tel) {
    toast('Escribe el número WhatsApp (519XXXXXXXX) — debe coincidir con la SIM del teléfono', 'error')
    return
  }
  if (!confirm(`¿Generar código para ${tel}? WhatsApp pedirá confirmar ese mismo número.`)) return
  try {
    toast('Generando código de 8 dígitos…')
    const body = tel ? { telefono: tel } : {}
    const r = await api('/bot/vincular-codigo', {
      method: 'POST',
      body: JSON.stringify(body)
    })
    toast(`Código: ${r.codigo} — también en puerto 9300`)
    setTimeout(actualizarEstadoBotConfig, 1500)
  } catch (err) {
    toast(err.message, 'error')
  }
}

async function pedirNuevoQrBot() {
  if (!confirm('¿Generar un nuevo código QR? El anterior dejará de servir.')) return
  try {
    toast('Generando nuevo QR…')
    const r = await api('/bot/nuevo-qr', { method: 'POST', body: '{}' })
    toast(r.mensaje || 'Nuevo QR en puerto 9300')
    setTimeout(actualizarEstadoBotConfig, 2000)
    setTimeout(actualizarEstadoBotConfig, 8000)
  } catch (err) {
    toast(err.message, 'error')
  }
}

async function reiniciarBotWhatsApp(nuevaVinculacion) {
  if (nuevaVinculacion && !confirm(
    '¿Borrar la sesión actual y generar un nuevo código QR? Deberás escanearlo en WhatsApp (puerto 9300).'
  )) return

  try {
    toast(nuevaVinculacion ? 'Preparando nueva vinculación…' : 'Reconectando WhatsApp…')
    const body = nuevaVinculacion
      ? { nueva_vinculacion: true, confirmar: true }
      : { nueva_vinculacion: false }
    const r = await api('/bot/reiniciar', { method: 'POST', body: JSON.stringify(body) })
    toast(r.mensaje || 'Operación iniciada')
    setTimeout(actualizarEstadoBotConfig, 1500)
    setTimeout(actualizarEstadoBotConfig, 4000)
    setTimeout(actualizarEstadoBotConfig, 10000)
  } catch (err) {
    toast(err.message, 'error')
  }
}

// ── Init ────────────────────────────────────────────────────

function initApp() { cargarDashboard() }

if (secret) {
  api('/bot/status').then(() => {
    document.getElementById('login-screen').classList.add('hidden')
    document.getElementById('app').classList.remove('hidden')
    initApp()
  }).catch(() => {})
}

document.getElementById('login-secret')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') login()
})
