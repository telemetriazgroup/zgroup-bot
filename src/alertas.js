const express = require('express')
const { db } = require('./db')
const { logger } = require('./logger')
const { enviarAlertaWhatsApp, syncYAlertar, enviarTestAlarma } = require('./services/alertas')
const { monitorearDispositivosActivos, obtenerLiveDispositivo, evaluarDispositivo } = require('./services/monitoreo')
const {
  sincronizarMonitorExterno,
  listarConsultasMonitor,
  obtenerConsultaMonitor,
  obtenerEstadoMonitorUi,
  listarHistorialZtrack
} = require('./services/monitor-externo')
const { exportarDatos, importarDatos, DEFAULT_OPTS } = require('./services/datos-transfer')
const { enviarTestEstadoUsuario, enviarTestEstadoMultiples } = require('./services/estado')
const { sincronizarDispositivos } = require('./services/dispositivos')

const router = express.Router()

// POST /api/alerta — alerta manual o desde sistema externo
router.post('/alerta', async (req, res) => {
  const { equipo_id, tipo_alerta, temperatura, humedad, ubicacion, nivel } = req.body
  if (!equipo_id || !tipo_alerta) {
    return res.status(400).json({ error: 'equipo_id y tipo_alerta son requeridos' })
  }
  try {
    await db.registrarAlerta({ equipo_id, tipo_alerta, temperatura, humedad, ubicacion, nivel })
    const resultado = await enviarAlertaWhatsApp({ equipo_id, tipo_alerta, ubicacion, nivel })
    if (resultado.error) return res.status(503).json({ error: resultado.error })
    res.json({ ok: true, ...resultado })
  } catch (err) {
    logger.error('Error procesando alerta:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// ── Usuarios ────────────────────────────────────────────────

router.get('/usuarios', async (req, res) => {
  try { res.json(await db.listarUsuarios()) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/conversacion/eventos', async (req, res) => {
  try {
    const usuario_id = req.query.usuario_id ? parseInt(req.query.usuario_id, 10) : null
    const limite = req.query.limite ? parseInt(req.query.limite, 10) : 50
    res.json(await db.listarEventosConversacion({ usuario_id, limite }))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/conversacion/mensajes', async (req, res) => {
  try {
    const { listarMensajes } = require('./services/chat-historial')
    const usuario_id = req.query.usuario_id ? parseInt(req.query.usuario_id, 10) : null
    const telefono = req.query.telefono || null
    const limite = req.query.limite ? parseInt(req.query.limite, 10) : 80
    res.json(await listarMensajes({
      usuarioId: Number.isFinite(usuario_id) ? usuario_id : null,
      telefono,
      limite
    }))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/conversacion/hilos', async (req, res) => {
  try {
    const { listarHilos } = require('./services/chat-historial')
    const limite = req.query.limite ? parseInt(req.query.limite, 10) : 50
    res.json(await listarHilos({ limite }))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/usuarios', async (req, res) => {
  const { nombre, telefono, equipo_ids } = req.body
  if (!nombre || !telefono) return res.status(400).json({ error: 'nombre y telefono requeridos' })
  try {
    const usuario = await db.crearUsuario({ nombre, telefono, equipo_ids: equipo_ids || [] })
    res.status(201).json(usuario)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.put('/usuarios/:id', async (req, res) => {
  try {
    const usuario = await db.actualizarUsuario(parseInt(req.params.id), req.body)
    res.json(usuario)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/usuarios/:id/aprobar-prueba', async (req, res) => {
  try {
    const { aprobarPruebaManual } = require('./services/prueba-activacion')
    const motivo = req.body?.motivo || 'aprobacion_admin'
    const result = await aprobarPruebaManual(parseInt(req.params.id, 10), { motivo })
    res.json({
      ok: true,
      ya_activado: result.ya_activado,
      usuario: result.usuario,
      nota: result.ya_activado
        ? 'El usuario ya tenía alertas habilitadas.'
        : 'Prueba marcada como aprobada. Ya puede recibir alertas push.'
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/usuarios/:id/revocar-prueba', async (req, res) => {
  try {
    const { revocarPruebaManual } = require('./services/prueba-activacion')
    const motivo = req.body?.motivo || 'revocacion_admin'
    const result = await revocarPruebaManual(parseInt(req.params.id, 10), { motivo })
    res.json({
      ok: true,
      usuario: result.usuario,
      nota: 'Activación revocada. Dejará de recibir alertas hasta nueva prueba o aprobación.'
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.delete('/usuarios/:id', async (req, res) => {
  try {
    await db.eliminarUsuario(parseInt(req.params.id))
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Equipos ─────────────────────────────────────────────────

router.get('/equipos', async (req, res) => {
  try { res.json(await db.listarEquipos()) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/equipos', async (req, res) => {
  const { id_equipo, nombre } = req.body
  if (!id_equipo || !nombre) return res.status(400).json({ error: 'id_equipo y nombre requeridos' })
  try {
    const equipo = await db.crearEquipo(req.body)
    res.status(201).json(equipo)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.put('/equipos/:id', async (req, res) => {
  try {
    const equipo = await db.actualizarEquipo(parseInt(req.params.id), req.body)
    res.json(equipo)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.delete('/equipos/:id', async (req, res) => {
  try {
    await db.eliminarEquipo(parseInt(req.params.id))
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Alertas ─────────────────────────────────────────────────

router.get('/alertas', async (req, res) => {
  try {
    const solo_activas = req.query.activas === 'true'
    res.json(await db.listarAlertas({ solo_activas }))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.patch('/alertas/:id/resolver', async (req, res) => {
  try {
    const alerta = await db.resolverAlerta(parseInt(req.params.id))
    res.json(alerta)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/config-alertas', async (req, res) => {
  try { res.json(await db.listarConfigAlertas()) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

router.put('/config-alertas/:tipo', async (req, res) => {
  try {
    const cfg = await db.actualizarConfigAlerta(req.params.tipo, req.body)
    res.json(cfg)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Config API ──────────────────────────────────────────────

router.get('/config', async (req, res) => {
  try { res.json(await db.obtenerConfigApi()) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

router.put('/config', async (req, res) => {
  try {
    const config = await db.actualizarConfigApi(req.body)
    res.json(config)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/monitor-externo/sync', async (req, res) => {
  try {
    const r = await sincronizarMonitorExterno()
    res.json(r)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/monitor-externo/estado', async (req, res) => {
  try {
    res.json(await obtenerEstadoMonitorUi())
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/monitor-externo/consultas', async (req, res) => {
  try {
    res.json(await listarConsultasMonitor({
      limit: req.query.limit,
      offset: req.query.offset,
      soloErrores: req.query.errores === '1' || req.query.errores === 'true'
    }))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/monitor-externo/consultas/:id', async (req, res) => {
  try {
    const row = await obtenerConsultaMonitor(req.params.id)
    if (!row) return res.status(404).json({ error: 'Consulta no encontrada' })
    res.json(row)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Exportar / Importar datos ───────────────────────────────

router.get('/datos/export-defaults', (req, res) => {
  res.json({ defaults: DEFAULT_OPTS })
})

router.post('/datos/export', async (req, res) => {
  try {
    const data = await exportarDatos(req.body || {})
    const download = req.query.download === '1' || req.body?.download === true
    if (download) {
      const fname = `zgroup-export-${new Date().toISOString().slice(0, 10)}.json`
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`)
      return res.send(JSON.stringify(data, null, 2))
    }
    res.json(data)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/datos/import', async (req, res) => {
  try {
    const body = req.body || {}
    const options = body.options || body.opts || {}
    const dump = (body.payload && typeof body.payload === 'object')
      ? body.payload
      : body
    if (!dump?.sections && dump?.version == null) {
      return res.status(400).json({ error: 'JSON de exportación inválido (falta sections / version)' })
    }
    const result = await importarDatos(dump, options)
    res.json({ ok: true, ...result })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/config/links', async (req, res) => {
  try { res.json(await db.listarConfigLinks()) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

router.put('/config/links/:link_id', async (req, res) => {
  try {
    const link = await db.actualizarConfigLink(req.params.link_id, req.body)
    if (!link) return res.status(404).json({ error: 'Link no encontrado' })
    res.json(link)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Dispositivos ────────────────────────────────────────────

router.get('/dispositivos', async (req, res) => {
  try {
    res.json(await db.listarDispositivos({ estado: req.query.estado }))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/dispositivos/stats', async (req, res) => {
  try { res.json(await db.contarDispositivos()) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/dispositivos/sync', async (req, res) => {
  try {
    const conAlertas = req.query.alertas === 'true'
    const result = conAlertas ? await syncYAlertar() : await sincronizarDispositivos()
    res.json({ ok: true, ...result })
  } catch (err) {
    logger.error('Error sincronizando:', err)
    res.status(500).json({ error: err.message })
  }
})

router.patch('/dispositivos/:id/alarma', async (req, res) => {
  try {
    const disp = await db.toggleAlarmaDispositivo(parseInt(req.params.id), !!req.body.activa)
    res.json(disp)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.patch('/dispositivos/:id/nombre', async (req, res) => {
  try {
    const disp = await db.actualizarNombreDispositivo(parseInt(req.params.id), req.body.nombre)
    res.json(disp)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/dispositivos/:id/usuarios', async (req, res) => {
  try {
    const disp = await db.obtenerDispositivoPorId(parseInt(req.params.id))
    if (!disp) return res.status(404).json({ error: 'Dispositivo no encontrado' })
    const usuarios = await db.obtenerUsuariosDeEquipo(disp.imei)
    res.json({ dispositivo: disp, usuarios })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/dispositivos/:id/test-alarma', async (req, res) => {
  try {
    const resultado = await enviarTestAlarma(parseInt(req.params.id))
    if (resultado.error) return res.status(503).json(resultado)
    res.json({ ok: true, ...resultado })
  } catch (err) {
    logger.error('Error en test alarma:', err)
    res.status(500).json({ error: err.message })
  }
})

router.get('/dispositivos/:id/live', async (req, res) => {
  try {
    const data = await obtenerLiveDispositivo(parseInt(req.params.id))
    res.json(data)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.put('/dispositivos/:id/monitoreo', async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const disp = await db.actualizarMonitoreoConfig(id, req.body)
    const notificar = req.body.notificar === true
      ? true
      : (disp.prioridad_monitor ? false : req.body.evaluar !== false)
    const evaluacion = req.body.evaluar !== false
      ? await evaluarDispositivo(id, { notificar })
      : null
    res.json({ dispositivo: disp, evaluacion })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/dispositivos/:id/proceso-ca', async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const disp = await db.obtenerDispositivoPorId(id)
    if (!disp) return res.status(404).json({ error: 'Dispositivo no encontrado' })
    const proceso = await db.obtenerProcesoCa(id)
    res.json({ dispositivo_id: id, proceso })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.put('/dispositivos/:id/proceso-ca', async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const disp = await db.obtenerDispositivoPorId(id)
    if (!disp) return res.status(404).json({ error: 'Dispositivo no encontrado' })
    const { prepararProcesoParaGuardar } = require('./services/informe-ca')
    if (req.body.limpiar) {
      await db.eliminarProcesoCa(id)
      return res.json({ ok: true, proceso: null })
    }
    const data = prepararProcesoParaGuardar(req.body)
    const proceso = await db.guardarProcesoCa(id, data)
    res.json({ ok: true, proceso })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/dispositivos/:id/evaluar', async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const disp = await db.obtenerDispositivoPorId(id)
    if (!disp) return res.status(404).json({ error: 'Dispositivo no encontrado' })
    // Con prioridad ztrack no se notifica por evaluación local (salvo forzar_wa)
    const notificar = req.body?.forzar_wa === true || !disp.prioridad_monitor
    const resultado = await evaluarDispositivo(id, { notificar })
    res.json({ ok: true, ...resultado })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/dispositivos/:id/ztrack-historial', async (req, res) => {
  try {
    const disp = await db.obtenerDispositivoPorId(parseInt(req.params.id))
    if (!disp) return res.status(404).json({ error: 'Dispositivo no encontrado' })
    const historial = await listarHistorialZtrack(disp.imei, { limit: req.query.limit })
    res.json({
      imei: disp.imei,
      prioridad_monitor: !!disp.prioridad_monitor,
      ztrack_actual: {
        rango: disp.ztrack_rango,
        umbrales: disp.ztrack_umbrales,
        en_rango: disp.ztrack_en_rango,
        estado: disp.ztrack_estado,
        criterio: disp.ztrack_criterio,
        telemetria: disp.ztrack_telemetria,
        episodio: disp.ztrack_episodio,
        actualizado_en: disp.ztrack_actualizado_en,
        grupo: disp.monitor_grupo
      },
      historial
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Grupos de alertas ───────────────────────────────────────

router.get('/grupos', async (req, res) => {
  try { res.json(await db.listarGrupos()) }
  catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/grupos/:id', async (req, res) => {
  try {
    const grupo = await db.obtenerGrupo(parseInt(req.params.id))
    if (!grupo) return res.status(404).json({ error: 'Grupo no encontrado' })
    res.json(grupo)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/grupos', async (req, res) => {
  const { nombre, descripcion, dispositivo_ids } = req.body
  if (!nombre) return res.status(400).json({ error: 'nombre requerido' })
  try {
    const grupo = await db.crearGrupo({ nombre, descripcion, dispositivo_ids: dispositivo_ids || [] })
    res.status(201).json(grupo)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.put('/grupos/:id', async (req, res) => {
  try {
    const grupo = await db.actualizarGrupo(parseInt(req.params.id), req.body)
    res.json(grupo)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.delete('/grupos/:id', async (req, res) => {
  try {
    await db.eliminarGrupo(parseInt(req.params.id))
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.put('/grupos/:id/usuarios', async (req, res) => {
  const { usuario_ids, accion } = req.body
  if (!usuario_ids?.length) return res.status(400).json({ error: 'usuario_ids requerido' })
  try {
    await db.asignarUsuariosAGrupo(parseInt(req.params.id), usuario_ids, accion || 'agregar')
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Asignaciones masivas ────────────────────────────────────

router.post('/asignaciones/bulk', async (req, res) => {
  const { usuario_ids, grupo_ids, dispositivo_ids, equipo_ids, accion } = req.body
  if (!usuario_ids?.length) return res.status(400).json({ error: 'Selecciona al menos un usuario' })
  try {
    const result = await db.asignacionMasiva({
      usuario_ids, grupo_ids, dispositivo_ids, equipo_ids, accion: accion || 'agregar'
    })
    res.json(result)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/usuarios/:id/asignaciones', async (req, res) => {
  try {
    const usuario = await db.obtenerUsuarioPorId(parseInt(req.params.id))
    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' })
    const list = await db.listarUsuarios()
    const u = list.find(x => x.id === usuario.id) || usuario
    const organizado = await db.obtenerDispositivosOrganizadosUsuario(usuario.id)
    res.json({ usuario: u, ...organizado })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/usuarios/:id/test-estado', async (req, res) => {
  try {
    const { dispositivo_ids, incluir_analisis_12h } = req.body || {}
    const result = await enviarTestEstadoUsuario(parseInt(req.params.id), dispositivo_ids, {
      incluirAnalisis12h: incluir_analisis_12h !== false
    })
    if (result.error) return res.status(503).json(result)
    res.json({ ok: true, ...result })
  } catch (err) {
    logger.error('Error test estado:', err)
    res.status(500).json({ error: err.message })
  }
})

router.post('/asignaciones/test-estado/preview', async (req, res) => {
  const { usuario_ids } = req.body
  if (!usuario_ids?.length) return res.status(400).json({ error: 'Selecciona al menos un usuario' })
  try {
    const preview = await db.obtenerPreviewTestEstado(usuario_ids)
    res.json(preview)
  } catch (err) {
    logger.error('Error preview test estado:', err)
    res.status(500).json({ error: err.message })
  }
})

router.post('/asignaciones/test-estado', async (req, res) => {
  const { usuario_ids, dispositivo_ids, incluir_analisis_12h } = req.body
  if (!usuario_ids?.length) return res.status(400).json({ error: 'Selecciona al menos un usuario' })
  if (!dispositivo_ids?.length) return res.status(400).json({ error: 'Selecciona al menos un dispositivo' })
  try {
    const resultados = await enviarTestEstadoMultiples(usuario_ids, dispositivo_ids, {
      incluirAnalisis12h: incluir_analisis_12h !== false
    })
    res.json({ ok: true, resultados })
  } catch (err) {
    logger.error('Error test estado múltiple:', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Estado bot ──────────────────────────────────────────────

router.get('/bot/status', async (req, res) => {
  const { obtenerEstadoBot } = require('./bot')
  res.json(obtenerEstadoBot())
})

router.get('/bot/diagnostico', async (req, res) => {
  const { obtenerDiagnosticoCompleto } = require('./bot')
  res.json(obtenerDiagnosticoCompleto())
})

router.post('/bot/vincular-qr', async (req, res) => {
  const { iniciarVinculacionPorQr } = require('./bot')
  try {
    await iniciarVinculacionPorQr()
    res.json({
      ok: true,
      mensaje: 'Modo QR activo. Abre http://localhost:9300 y escanea.',
      ...require('./bot').obtenerEstadoBot()
    })
  } catch (err) {
    logger.error('Error vinculación QR:', err)
    res.status(400).json({ error: err.message })
  }
})

router.post('/bot/vincular-codigo', async (req, res) => {
  const { iniciarVinculacionPorCodigo } = require('./bot')
  try {
    const telefono = req.body?.telefono
    const codigo = await iniciarVinculacionPorCodigo(telefono)
    res.json({
      ok: true,
      codigo,
      mensaje: 'Introduce el código en WhatsApp → Dispositivos vinculados → Vincular con número de teléfono',
      ...require('./bot').obtenerEstadoBot()
    })
  } catch (err) {
    logger.error('Error vinculación por código:', err)
    res.status(400).json({ error: err.message })
  }
})

router.post('/bot/nuevo-qr', async (req, res) => {
  const { pedirNuevoQrManual } = require('./bot')
  try {
    await pedirNuevoQrManual()
    res.json({
      ok: true,
      mensaje: 'Generando nuevo QR. Espera ~2 min por código o pide otro manualmente.',
      ...require('./bot').obtenerEstadoBot()
    })
  } catch (err) {
    logger.error('Error pidiendo nuevo QR:', err)
    res.status(400).json({ error: err.message })
  }
})

router.post('/bot/reiniciar', async (req, res) => {
  const { reiniciarWhatsApp } = require('./bot')
  const nuevaVinculacion = req.body?.nueva_vinculacion === true
  try {
    if (nuevaVinculacion && req.body?.confirmar !== true) {
      return res.status(400).json({
        error: 'Confirma nueva_vinculacion y confirmar:true para borrar la sesión actual'
      })
    }
    await reiniciarWhatsApp({ nuevaVinculacion })
    res.json({
      ok: true,
      mensaje: nuevaVinculacion
        ? 'Sesión reiniciada. Escanea el QR en el puerto 9300.'
        : 'Reconexión iniciada. Espera unos segundos.',
      ...require('./bot').obtenerEstadoBot()
    })
  } catch (err) {
    logger.error('Error reiniciando bot:', err)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
