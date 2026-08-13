-- Migraciones idempotentes (se ejecutan en cada arranque)

CREATE TABLE IF NOT EXISTS config_api (
  id                 SERIAL PRIMARY KEY,
  url                VARCHAR(500) NOT NULL DEFAULT 'http://161.132.53.51:9050/Tunel/dispositivos/reporte/',
  online_hasta_horas NUMERIC(5,2) NOT NULL DEFAULT 1,
  wait_hasta_horas   NUMERIC(5,2) NOT NULL DEFAULT 24,
  alerta_online      BOOLEAN NOT NULL DEFAULT false,
  alerta_wait        BOOLEAN NOT NULL DEFAULT true,
  alerta_offline     BOOLEAN NOT NULL DEFAULT true,
  intervalo_minutos  INTEGER NOT NULL DEFAULT 15,
  url_live           VARCHAR(500) DEFAULT 'http://161.132.53.51:9050/Tunel/decodificado/live/',
  actualizado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO config_api (id, url) VALUES (1, 'http://161.132.53.51:9050/Tunel/dispositivos/reporte/')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS dispositivos (
  id                SERIAL PRIMARY KEY,
  imei              VARCHAR(20)  NOT NULL UNIQUE,
  tipo              VARCHAR(50),
  estado_conexion   VARCHAR(20)  NOT NULL DEFAULT 'offline',
  ultimo_dato       TIMESTAMPTZ,
  last_ip           VARCHAR(50),
  fecha_registro    TIMESTAMPTZ,
  alarmas_activas   BOOLEAN      NOT NULL DEFAULT false,
  nombre            VARCHAR(100),
  sincronizado_en   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  set_control       NUMERIC(5,2),
  delta             NUMERIC(5,2),
  sensor_control    VARCHAR(30)  DEFAULT 'return_air',
  alerta_setpoint   BOOLEAN      DEFAULT true,
  ultimo_set_point  NUMERIC(5,2),
  en_rango          BOOLEAN      DEFAULT true,
  temp_supply_1     NUMERIC(5,2),
  return_air        NUMERIC(5,2),
  evaporation_coil  NUMERIC(5,2),
  set_point_live    NUMERIC(5,2),
  compress_coil_1   NUMERIC(5,2),
  telemetria_actualizada TIMESTAMPTZ,
  link_origen       VARCHAR(20)  DEFAULT 'link1'
);

CREATE TABLE IF NOT EXISTS config_alertas (
  id          SERIAL PRIMARY KEY,
  tipo        VARCHAR(50)  NOT NULL UNIQUE,
  activo      BOOLEAN      NOT NULL DEFAULT true,
  descripcion VARCHAR(200),
  nivel       VARCHAR(20)  NOT NULL DEFAULT 'normal'
);

INSERT INTO config_alertas (tipo, descripcion, nivel) VALUES
  ('online',  'Dispositivo recuperó conexión', 'normal'),
  ('wait',    'Dispositivo sin datos recientes', 'normal'),
  ('offline', 'Dispositivo sin conexión prolongada', 'critico'),
  ('fuera_de_rango', 'Temperatura fuera del rango permitido', 'critico'),
  ('cambio_setpoint', 'Cambio de setpoint detectado', 'normal')
ON CONFLICT (tipo) DO NOTHING;

ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS set_control NUMERIC(5,2);
ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS delta NUMERIC(5,2);
ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS sensor_control VARCHAR(30) DEFAULT 'return_air';
ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS alerta_setpoint BOOLEAN DEFAULT true;
ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS ultimo_set_point NUMERIC(5,2);
ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS en_rango BOOLEAN DEFAULT true;
ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS temp_supply_1 NUMERIC(5,2);
ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS return_air NUMERIC(5,2);
ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS evaporation_coil NUMERIC(5,2);
ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS set_point_live NUMERIC(5,2);
ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS compress_coil_1 NUMERIC(5,2);
ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS telemetria_actualizada TIMESTAMPTZ;
ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS link_origen VARCHAR(20) DEFAULT 'link1';
ALTER TABLE config_api ADD COLUMN IF NOT EXISTS url_live VARCHAR(500) DEFAULT 'http://161.132.53.51:9050/Tunel/decodificado/live/';
ALTER TABLE config_api ADD COLUMN IF NOT EXISTS link_id VARCHAR(20) DEFAULT 'link1';

-- equipos/alertas pueden no existir en DBs muy antiguas
DO $$ BEGIN
  ALTER TABLE equipos ADD COLUMN IF NOT EXISTS imei VARCHAR(20);
  ALTER TABLE equipos ADD COLUMN IF NOT EXISTS alarmas_activas BOOLEAN NOT NULL DEFAULT true;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE alertas ADD COLUMN IF NOT EXISTS codigo VARCHAR(50);
  ALTER TABLE alertas ALTER COLUMN tipo TYPE TEXT;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_dispositivos_estado ON dispositivos(estado_conexion);

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_alertas_resuelta ON alertas(resuelta);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- Grupos de alertas
CREATE TABLE IF NOT EXISTS grupos_alertas (
  id          SERIAL PRIMARY KEY,
  nombre      VARCHAR(100) NOT NULL UNIQUE,
  descripcion VARCHAR(300),
  activo      BOOLEAN NOT NULL DEFAULT true,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS grupo_dispositivos (
  grupo_id       INTEGER NOT NULL REFERENCES grupos_alertas(id) ON DELETE CASCADE,
  dispositivo_id INTEGER NOT NULL REFERENCES dispositivos(id) ON DELETE CASCADE,
  PRIMARY KEY (grupo_id, dispositivo_id)
);

CREATE TABLE IF NOT EXISTS usuario_grupos (
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  grupo_id   INTEGER NOT NULL REFERENCES grupos_alertas(id) ON DELETE CASCADE,
  PRIMARY KEY (usuario_id, grupo_id)
);

CREATE TABLE IF NOT EXISTS usuario_dispositivos (
  usuario_id     INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  dispositivo_id INTEGER NOT NULL REFERENCES dispositivos(id) ON DELETE CASCADE,
  PRIMARY KEY (usuario_id, dispositivo_id)
);

-- Links de API (crear ANTES de cualquier ALTER sobre esta tabla)
CREATE TABLE IF NOT EXISTS config_links (
  id            SERIAL PRIMARY KEY,
  link_id       VARCHAR(20)  NOT NULL UNIQUE,
  nombre        VARCHAR(100) NOT NULL,
  url_reporte   VARCHAR(500) NOT NULL,
  url_live      VARCHAR(500) NOT NULL,
  url_historico VARCHAR(500),
  tipo_default  VARCHAR(50)  DEFAULT 'Tunel',
  activo        BOOLEAN      NOT NULL DEFAULT true,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE config_links ADD COLUMN IF NOT EXISTS url_historico VARCHAR(500);

INSERT INTO config_links (link_id, nombre, url_reporte, url_live, url_historico, tipo_default) VALUES
  ('link1', 'Tunel',
   'http://161.132.53.51:9050/Tunel/dispositivos/reporte/',
   'http://161.132.53.51:9050/Tunel/decodificado/live/',
   'http://161.132.53.51:9050/Tunel/decodificado/imei/',
   'Tunel'),
  ('link2', 'TermoKing',
   'http://161.132.53.51:9050/TermoKing/dispositivos/reporte/',
   'http://161.132.53.51:9050/TermoKing/decodificado/live/',
   NULL,
   'TermoKing')
ON CONFLICT (link_id) DO NOTHING;

UPDATE config_links SET url_historico = 'http://161.132.53.51:9050/Tunel/decodificado/imei/'
WHERE link_id = 'link1' AND (url_historico IS NULL OR url_historico = '');

-- Proceso CA por dispositivo (informe / seguimiento)
CREATE TABLE IF NOT EXISTS proceso_ca (
  dispositivo_id  INTEGER PRIMARY KEY REFERENCES dispositivos(id) ON DELETE CASCADE,
  receta          VARCHAR(200),
  tipo_fruta      VARCHAR(100),
  variacion       VARCHAR(100),
  procedencia     VARCHAR(200),
  fecha_inicio    TIMESTAMPTZ,
  fecha_fin       TIMESTAMPTZ,
  maquina_serie   VARCHAR(50),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Activación conversacional: 3 respuestas antes de recibir alertas push
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS alertas_habilitadas BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS prueba_respuestas INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS prueba_iniciada_en TIMESTAMPTZ;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS prueba_completada_en TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS conversacion_eventos (
  id          SERIAL PRIMARY KEY,
  usuario_id  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  tipo        VARCHAR(50)  NOT NULL,
  detalle     TEXT,
  meta        JSONB,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversacion_eventos_usuario
  ON conversacion_eventos (usuario_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_conversacion_eventos_tipo
  ON conversacion_eventos (tipo, creado_en DESC);

-- Historial completo de mensajes WhatsApp (contexto + auditoría)
CREATE TABLE IF NOT EXISTS whatsapp_mensajes (
  id           BIGSERIAL PRIMARY KEY,
  usuario_id   INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  telefono     VARCHAR(30),
  jid          VARCHAR(80),
  direccion    VARCHAR(10) NOT NULL, -- 'in' | 'out'
  tipo         VARCHAR(20) NOT NULL DEFAULT 'text', -- text | image | system
  cuerpo       TEXT,
  caption      TEXT,
  intencion    VARCHAR(40),
  imei_contexto VARCHAR(40),
  meta         JSONB,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_msg_usuario_fecha
  ON whatsapp_mensajes (usuario_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_wa_msg_telefono_fecha
  ON whatsapp_mensajes (telefono, creado_en DESC);

-- Seguimiento de alertas (reavisos por umbral de horas)
CREATE TABLE IF NOT EXISTS alerta_seguimiento (
  id                     SERIAL PRIMARY KEY,
  usuario_id             INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  imei                   VARCHAR(40) NOT NULL,
  codigo                 VARCHAR(50) NOT NULL,
  iniciado_en            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ultima_notificacion_en TIMESTAMPTZ,
  ultimo_umbral_horas    NUMERIC(6,2) DEFAULT 0,
  ack_en                 TIMESTAMPTZ,
  estado                 VARCHAR(20) NOT NULL DEFAULT 'activo',
  dia_lima               DATE,
  meta                   JSONB
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alerta_seg_activo
  ON alerta_seguimiento (usuario_id, imei, codigo)
  WHERE estado = 'activo';

ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS fuera_desde TIMESTAMPTZ;

-- Config umbrales fuera de rango / reavisos / recuperación
ALTER TABLE config_api ADD COLUMN IF NOT EXISTS fuera_rango_minutos_min INTEGER NOT NULL DEFAULT 120;
ALTER TABLE config_api ADD COLUMN IF NOT EXISTS reaviso_paso_horas NUMERIC(4,2) NOT NULL DEFAULT 1;
ALTER TABLE config_api ADD COLUMN IF NOT EXISTS reaviso_max_horas_dia NUMERIC(5,2) NOT NULL DEFAULT 20;
ALTER TABLE config_api ADD COLUMN IF NOT EXISTS alerta_en_rango BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE config_api ADD COLUMN IF NOT EXISTS historico_fecha_ya_lima BOOLEAN NOT NULL DEFAULT true;

-- TermoKing / link2 puede enviar IMEI o serie > 20 chars (hasta ~40+)
ALTER TABLE dispositivos ALTER COLUMN imei TYPE VARCHAR(64);
DO $$ BEGIN
  ALTER TABLE equipos ALTER COLUMN imei TYPE VARCHAR(64);
  ALTER TABLE equipos ALTER COLUMN id_equipo TYPE VARCHAR(64);
EXCEPTION WHEN undefined_column THEN NULL;
WHEN undefined_table THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE alertas ALTER COLUMN equipo_id TYPE VARCHAR(64);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- Monitor externo ztrack (correo) → disparador WhatsApp
ALTER TABLE config_api ADD COLUMN IF NOT EXISTS monitor_externo_url VARCHAR(500)
  DEFAULT 'https://ztrack.app/reefer/api/correo/external/monitor';
ALTER TABLE config_api ADD COLUMN IF NOT EXISTS monitor_externo_minutos INTEGER NOT NULL DEFAULT 5;
ALTER TABLE config_api ADD COLUMN IF NOT EXISTS monitor_externo_activo BOOLEAN NOT NULL DEFAULT true;

-- Wait sin datos: incidente interno vs aviso al usuario
ALTER TABLE config_api ADD COLUMN IF NOT EXISTS wait_interno_horas NUMERIC(5,2) NOT NULL DEFAULT 2;
ALTER TABLE config_api ADD COLUMN IF NOT EXISTS wait_usuario_horas NUMERIC(5,2) NOT NULL DEFAULT 4;

CREATE TABLE IF NOT EXISTS monitor_envios_procesados (
  envio_id     VARCHAR(80) PRIMARY KEY,
  imei         VARCHAR(64),
  alert_kind   VARCHAR(40),
  umbral_horas NUMERIC(6,2),
  procesado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  meta         JSONB
);
CREATE INDEX IF NOT EXISTS idx_monitor_envios_imei ON monitor_envios_procesados (imei, procesado_en DESC);

ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS prioridad_monitor BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS monitor_row_key VARCHAR(80);
ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS monitor_grupo VARCHAR(120);

-- Control: un umbral (ej. apagado 2h) se notifica WA una sola vez por día Lima
CREATE TABLE IF NOT EXISTS monitor_umbrales_notificados (
  imei          VARCHAR(64) NOT NULL,
  alert_kind    VARCHAR(40) NOT NULL,
  umbral_key    NUMERIC(8,2) NOT NULL,
  dia_lima      DATE NOT NULL,
  envio_id      VARCHAR(80),
  notificado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (imei, alert_kind, umbral_key, dia_lima)
);
CREATE INDEX IF NOT EXISTS idx_monitor_umbrales_imei
  ON monitor_umbrales_notificados (imei, dia_lima DESC);

-- Histórico de cada poll al API monitor correo (éxito / error)
CREATE TABLE IF NOT EXISTS monitor_api_consultas (
  id               BIGSERIAL PRIMARY KEY,
  consultado_en    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  url              VARCHAR(500) NOT NULL,
  ok               BOOLEAN NOT NULL DEFAULT false,
  http_status      INTEGER,
  error_mensaje    TEXT,
  duracion_ms      INTEGER,
  generated_at     TIMESTAMPTZ,
  ciclo_id         VARCHAR(80),
  resumen          JSONB,
  equipos_resumen  JSONB,
  alertas_resumen  JSONB,
  payload          JSONB,
  wa_encolados     INTEGER NOT NULL DEFAULT 0,
  prioridad_count  INTEGER,
  en_api_local     INTEGER,
  procesado_wa     BOOLEAN NOT NULL DEFAULT false,
  meta             JSONB
);
CREATE INDEX IF NOT EXISTS idx_monitor_api_consultas_en
  ON monitor_api_consultas (consultado_en DESC);
CREATE INDEX IF NOT EXISTS idx_monitor_api_consultas_ok
  ON monitor_api_consultas (ok, consultado_en DESC);

-- Contexto ztrack por dispositivo (rangos API + último estado)
ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS ztrack_rango JSONB;
ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS ztrack_umbrales JSONB;
ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS ztrack_en_rango BOOLEAN;
ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS ztrack_estado VARCHAR(80);
ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS ztrack_criterio TEXT;
ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS ztrack_telemetria JSONB;
ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS ztrack_episodio JSONB;
ALTER TABLE dispositivos ADD COLUMN IF NOT EXISTS ztrack_actualizado_en TIMESTAMPTZ;

-- Histórico de muestras del monitor (contexto si la API falla un rato)
CREATE TABLE IF NOT EXISTS dispositivo_ztrack_historial (
  id            BIGSERIAL PRIMARY KEY,
  imei          VARCHAR(64) NOT NULL,
  consultado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  en_rango      BOOLEAN,
  estado        VARCHAR(80),
  criterio      TEXT,
  rango         JSONB,
  umbrales      JSONB,
  telemetria    JSONB,
  episodio      JSONB,
  consulta_id   BIGINT
);
CREATE INDEX IF NOT EXISTS idx_ztrack_hist_imei
  ON dispositivo_ztrack_historial (imei, consultado_en DESC);

