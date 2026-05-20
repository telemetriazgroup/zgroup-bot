# ZGroup Bot

Bot de WhatsApp para alertas de equipos reefer (contenedores refrigerados). Recibe notificaciones vía API REST y las reenvía a usuarios registrados; además responde comandos por WhatsApp para consultar estado de equipos y alertas activas.

## Arquitectura

```
┌─────────────────┐     POST /api/alerta      ┌──────────────┐
│  Sistema Reefer │ ────────────────────────► │  ZGroup Bot  │
└─────────────────┘                           │  (Express)   │
                                              └──────┬───────┘
                                                     │
                    ┌────────────────────────────────┼────────────────────┐
                    │                                │                    │
                    ▼                                ▼                    ▼
             ┌─────────────┐                 ┌─────────────┐      ┌─────────────┐
             │  PostgreSQL │                 │  WhatsApp   │      │  QR Viewer  │
             │  (usuarios, │                 │  (Baileys)  │      │  (nginx:9300)│
             │  equipos,   │                 └─────────────┘      └─────────────┘
             │  alertas)   │
             └─────────────┘
```

| Servicio     | Puerto | Descripción                                      |
|--------------|--------|--------------------------------------------------|
| `bot`        | 9301   | API REST + conexión WhatsApp                     |
| `db`         | 5432   | PostgreSQL (solo red interna Docker)               |
| `qr-viewer`  | 9300   | Página web para escanear QR de vinculación       |

## Requisitos

- **Docker** y **Docker Compose** (recomendado para producción)
- O bien: **Node.js 20+** y **PostgreSQL 16** (desarrollo local)

## Inicio rápido con Docker

### 1. Clonar y configurar entorno

```bash
git clone <url-del-repositorio> zgroup-bot
cd zgroup-bot
cp .env.example .env
```

Edita `.env` y cambia al menos:

- `DB_PASSWORD` — contraseña segura para PostgreSQL
- `API_SECRET` — token secreto para proteger la API

### 2. Levantar servicios

```bash
docker compose up -d --build
```

### 3. Vincular WhatsApp

1. Abre en el navegador: `http://localhost:9300` (o la IP del servidor)
2. En WhatsApp: **Dispositivos vinculados → Vincular dispositivo**
3. Escanea el QR que aparece en la página
4. Cuando el bot conecte, la página del QR desaparece automáticamente

> Una vez vinculado, cierra el puerto 9300 en producción: `sudo ufw deny 9300/tcp`

### 4. Verificar que todo funciona

```bash
# Estado de contenedores
docker compose ps

# Logs del bot
docker compose logs -f bot

# Health check
curl http://localhost:9301/health
```

### 5. Panel de administración

Abre **http://localhost:9301/admin** e ingresa el valor de `API_SECRET` de tu `.env`.

Desde el panel puedes:

- **Dashboard** — resumen de dispositivos (online/wait/offline) y estado del bot
- **Dispositivos** — sincronizar desde la API externa, activar/desactivar alarmas por IMEI
- **Usuarios** — crear usuarios WhatsApp y asignarles equipos
- **Equipos** — gestionar equipos reefer manualmente
- **Alertas** — ver historial y marcar como resueltas
- **Configuración** — URL de la API, umbrales online/wait/offline e intervalo de monitor

La API de dispositivos por defecto es:

```
POST http://161.132.53.51:9050/Tunel/dispositivos/reporte/
{
  "mes": 5,
  "anio": 2026,
  "online_hasta_horas": 1,
  "wait_hasta_horas": 24
}
```

El mes y año se envían automáticamente con la fecha actual al sincronizar.


El script `deploy.sh` instala Docker, configura el firewall y levanta los contenedores:

```bash
chmod +x deploy.sh
sudo ./deploy.sh
```

## Desarrollo local (sin Docker)

### 1. Instalar dependencias

```bash
npm install
```

### 2. Base de datos

Crea una base PostgreSQL y ejecuta el schema:

```bash
psql -U postgres -c "CREATE DATABASE zgroup;"
psql -U postgres -d zgroup -f src/db/schema.sql
```

### 3. Variables de entorno

Copia `.env.example` a `.env` y ajusta para local:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=zgroup
DB_USER=tu_usuario
DB_PASSWORD=tu_password
PORT=9301
API_SECRET=token_secreto_para_llamadas_internas
```

### 4. Iniciar

```bash
npm start
# o con recarga automática:
npm run dev
```

El QR se imprime en la terminal y también se guarda en `qr/index.html` si montas esa carpeta.

## Variables de entorno

| Variable          | Descripción                              | Ejemplo                          |
|-------------------|------------------------------------------|----------------------------------|
| `DB_HOST`         | Host de PostgreSQL                       | `db` (Docker) / `localhost`      |
| `DB_PORT`         | Puerto PostgreSQL                        | `5432`                           |
| `DB_NAME`         | Nombre de la base de datos               | `zgroup`                         |
| `DB_USER`         | Usuario PostgreSQL                       | `zgroupuser`                     |
| `DB_PASSWORD`     | Contraseña PostgreSQL                    | *(cambiar)*                      |
| `PORT`            | Puerto de la API                         | `9301`                           |
| `API_SECRET`      | Token para autenticar llamadas a `/api`  | *(cambiar)*                      |
| `BOT_NOMBRE`      | Nombre del bot (referencia)              | `ZGroup Bot`                     |
| `BOT_PREFIJO`     | Prefijo de comandos (referencia)         | `!`                              |
| `ALERTA_TEMP_MAX` | Umbral superior de temperatura (°C)      | `-10`                            |
| `ALERTA_TEMP_MIN` | Umbral inferior de temperatura (°C)      | `-30`                            |

Todas las rutas bajo `/api` requieren el header:

```
X-Api-Secret: <valor de API_SECRET>
```

## API REST

### `POST /api/alerta`

Envía una alerta reefer a los usuarios asignados al equipo.

```bash
curl -X POST http://localhost:9301/api/alerta \
  -H "Content-Type: application/json" \
  -H "X-Api-Secret: tu_api_secret" \
  -d '{
    "equipo_id": "REF-001",
    "tipo_alerta": "Temperatura alta",
    "temperatura": -5.2,
    "humedad": 90,
    "ubicacion": "Puerto del Callao",
    "nivel": "critico"
  }'
```

Respuesta:

```json
{ "ok": true, "enviados": 2, "total_usuarios": 2 }
```

### `GET /api/usuarios`

Lista usuarios registrados.

### `POST /api/usuarios`

Registra un usuario interno y opcionalmente lo asigna a equipos.

```bash
curl -X POST http://localhost:9301/api/usuarios \
  -H "Content-Type: application/json" \
  -H "X-Api-Secret: tu_api_secret" \
  -d '{
    "nombre": "Juan Pérez",
    "telefono": "51999888777",
    "equipo_ids": [1, 2]
  }'
```

> El teléfono debe incluir código de país sin `+` (ej: `51999888777` para Perú).

### `GET /health`

Health check sin autenticación. Usado por Docker.

## Comandos de WhatsApp

Solo responde a números registrados en la tabla `usuarios`.

| Comando   | Atajo | Descripción                |
|-----------|-------|----------------------------|
| `ESTADO`  | `1`   | Ver equipos asignados      |
| `ALERTAS` | `2`   | Ver alertas activas        |
| `AYUDA`   | `0`   | Mostrar menú de comandos   |

## Base de datos

El schema se aplica automáticamente al crear el contenedor PostgreSQL (`src/db/schema.sql`).

| Tabla             | Descripción                                      |
|-------------------|--------------------------------------------------|
| `usuarios`        | Usuarios internos autorizados a usar el bot      |
| `equipos`         | Equipos reefer con telemetría                    |
| `usuario_equipos` | Relación muchos-a-muchos usuario ↔ equipo        |
| `alertas`         | Historial de alertas generadas                   |

Datos de ejemplo incluidos: 2 usuarios y 2 equipos (`REF-001`, `REF-002`). Para que un usuario reciba alertas, debe estar vinculado al equipo en `usuario_equipos`:

```sql
INSERT INTO usuario_equipos (usuario_id, equipo_id)
VALUES (1, 1);
```

## Estructura del proyecto

```
zgroup-bot/
├── index.js              # Punto de entrada: Express + WhatsApp
├── src/
│   ├── bot.js            # Conexión WhatsApp (Baileys)
│   ├── handlers.js       # Comandos de chat
│   ├── alertas.js        # Rutas API REST
│   ├── db.js             # Acceso a PostgreSQL
│   ├── logger.js         # Logs (consola + logs/bot.log)
│   └── db/schema.sql     # Schema e datos iniciales
├── docker-compose.yml
├── Dockerfile
├── deploy.sh
├── .env.example
├── sessions/             # Sesión WhatsApp (volumen Docker)
├── logs/                 # Logs persistentes
└── qr/                   # QR temporal para vinculación
```

## Comandos útiles

```bash
# Levantar en segundo plano
docker compose up -d

# Reconstruir tras cambios en código
docker compose up -d --build

# Ver logs
docker compose logs -f bot
npm run logs

# Reiniciar solo el bot
docker compose restart bot

# Detener todo
docker compose down

# Detener y borrar volúmenes (¡pierde sesión WhatsApp y BD!)
docker compose down -v
```

## Solución de problemas

### El bot no conecta a WhatsApp

- Revisa logs: `docker compose logs -f bot`
- Si la sesión expiró (`loggedOut`), elimina la sesión y reinicia:
  ```bash
  docker compose down
  docker volume rm zgroup-bot_sessions   # o borra ./sessions en local
  docker compose up -d
  ```
- Abre `http://localhost:9300` y escanea el QR de nuevo

### `npm ci` falla en Docker

Asegúrate de tener `package-lock.json` en el repositorio. Generarlo:

```bash
npm install
```

### La API responde 401

Verifica que el header `X-Api-Secret` coincida exactamente con `API_SECRET` en `.env`.

### Alertas no llegan por WhatsApp

1. El bot debe estar conectado (`connection === 'open'` en logs)
2. El usuario debe existir en `usuarios` con el teléfono correcto
3. Debe existir relación en `usuario_equipos` entre usuario y equipo
4. El `equipo_id` en la alerta debe coincidir con `equipos.id_equipo`

### Error de conexión a PostgreSQL

- En Docker, usa `DB_HOST=db` (nombre del servicio)
- En local, usa `DB_HOST=localhost`
- Espera a que el healthcheck de `db` pase antes de que el bot arranque

## Licencia

Uso interno — ZGroup.
