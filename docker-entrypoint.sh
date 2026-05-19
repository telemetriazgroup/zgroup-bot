#!/bin/sh
set -e
chown -R botuser:botuser /app/logs /app/sessions /app/qr 2>/dev/null || true
exec su-exec botuser "$@"
