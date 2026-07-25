#!/bin/sh
set -e

mkdir -p /app/qr /app/logs /app/sessions

if [ -d /app/public/qr-viewer ]; then
  for f in /app/public/qr-viewer/*.html; do
    [ -f "$f" ] && cp -f "$f" /app/qr/
  done
fi

# status.json compartido con nginx (puerto 9300) — evita 404 antes de que Node escriba
node <<'NODE'
const fs = require('fs')
const dir = '/app/qr'
const file = dir + '/status.json'
const base = {
  actualizado: new Date().toISOString(),
  conectado: false,
  fase: 'iniciando',
  mensaje: 'Arrancando contenedor — esperando bot Node.js…',
  pasos: [{
    id: 'entrypoint',
    titulo: 'Contenedor iniciado',
    detalle: 'Copiando plantilla QR y status.json',
    status: 'pending',
    hora: new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' })
  }],
  ultimo_error: null,
  codigo_desconexion: null,
  qr_disponible: false,
  qr_imagen: null,
  recomendacion: 'Si el estado no avanza, revisa: docker compose logs -f bot',
  tiene_sesion: false,
  sesion_registrada: false
}
try {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(base, null, 2), { mode: 0o664 })
} catch (e) {
  console.error('entrypoint: no se pudo crear status.json', e.message)
  process.exit(1)
}
NODE

chown -R botuser:botuser /app/logs /app/sessions /app/qr 2>/dev/null || true
chmod 775 /app/sessions 2>/dev/null || true

exec su-exec botuser "$@"
