#!/bin/bash
# deploy.sh — Script de instalación y despliegue en servidor Ubuntu
# Uso: chmod +x deploy.sh && sudo ./deploy.sh

set -e  # detener si hay error

echo "============================================"
echo "  ZGroup Bot — Despliegue en Ubuntu"
echo "============================================"

# ── 1. Actualizar sistema ──────────────────────
echo ""
echo "[1/6] Actualizando sistema..."
apt-get update -y && apt-get upgrade -y

# ── 2. Instalar Docker ─────────────────────────
echo ""
echo "[2/6] Instalando Docker..."
if ! command -v docker &> /dev/null; then
  curl -fsSL https://get.docker.com -o get-docker.sh
  sh get-docker.sh
  usermod -aG docker $SUDO_USER
  echo "✅ Docker instalado"
else
  echo "✅ Docker ya está instalado"
fi

# Docker Compose plugin
if ! docker compose version &> /dev/null; then
  apt-get install -y docker-compose-plugin
fi

# ── 3. Configurar firewall ─────────────────────
echo ""
echo "[3/6] Configurando firewall UFW..."
ufw allow ssh
ufw allow 9301/tcp   # API del bot (interna)
ufw allow 9300/tcp   # QR viewer (temporal, cerrar después)
ufw --force enable
echo "✅ Firewall configurado"

# ── 4. Crear archivo .env si no existe ─────────
echo ""
echo "[4/6] Configurando variables de entorno..."
if [ ! -f ".env" ]; then
  cp .env.example .env
  echo ""
  echo "⚠️  IMPORTANTE: Edita el archivo .env antes de continuar:"
  echo "   nano .env"
  echo ""
  read -p "¿Ya editaste el .env? (s/n): " respuesta
  if [ "$respuesta" != "s" ]; then
    echo "Por favor edita .env y ejecuta: docker compose up -d"
    exit 0
  fi
fi

# ── 5. Construir y levantar contenedores ───────
echo ""
echo "[5/6] Construyendo imágenes Docker..."
docker compose build --no-cache

echo ""
echo "[6/6] Levantando servicios..."
docker compose up -d

# ── 6. Mostrar estado ──────────────────────────
echo ""
echo "============================================"
echo "  ✅ Despliegue completado"
echo "============================================"
echo ""
echo "📊 Estado de contenedores:"
docker compose ps

echo ""
echo "📱 Para escanear el QR de WhatsApp:"
echo "   Abre en tu navegador: http://$(hostname -I | awk '{print $1}'):9300"
echo ""
echo "📋 Para ver los logs del bot:"
echo "   docker compose logs -f bot"
echo ""
echo "🔁 Para reiniciar el bot:"
echo "   docker compose restart bot"
echo ""
echo "⚠️  Una vez vinculado WhatsApp, cierra el puerto 9300:"
echo "   sudo ufw deny 9300/tcp"
