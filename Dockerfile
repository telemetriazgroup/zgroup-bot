FROM node:20-alpine

# Dependencias del sistema para Baileys
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    python3 \
    make \
    g++ \
    git \
    su-exec

WORKDIR /app

# Copiar dependencias primero (mejor cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Copiar código fuente
COPY src/ ./src/
COPY index.js ./

# Carpeta de sesión persistente (se montará como volumen)
RUN mkdir -p /app/sessions && chmod 777 /app/sessions

# Puerto de la API REST
EXPOSE 9301

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Usuario no-root por seguridad (entrypoint ajusta permisos de volúmenes)
RUN addgroup -S botuser && adduser -S botuser -G botuser
RUN chown -R botuser:botuser /app

USER root
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "index.js"]
