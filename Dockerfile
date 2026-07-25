FROM node:20-alpine

# Chromium para whatsapp-web.js (mismo canal que WhatsApp Web)
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    udev \
    ttf-opensans \
    python3 \
    make \
    g++ \
    git \
    su-exec

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    CHROME_PATH=/usr/bin/chromium-browser \
    WHATSAPP_CLIENT=wwebjs

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/
COPY public/ ./public/
COPY index.js ./

RUN mkdir -p /app/sessions /app/qr /app/logs && chmod 777 /app/sessions

EXPOSE 9301

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

RUN addgroup -S botuser && adduser -S botuser -G botuser
RUN chown -R botuser:botuser /app

USER root
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "index.js"]
