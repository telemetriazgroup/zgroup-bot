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

ALTER TABLE alertas ADD COLUMN IF NOT EXISTS codigo VARCHAR(50);
ALTER TABLE alertas ALTER COLUMN tipo TYPE TEXT;

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
ALTER TABLE config_links ADD COLUMN IF NOT EXISTS url_historico VARCHAR(500);

ALTER TABLE equipos ADD COLUMN IF NOT EXISTS imei VARCHAR(20);
ALTER TABLE equipos ADD COLUMN IF NOT EXISTS alarmas_activas BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_dispositivos_estado ON dispositivos(estado_conexion);
CREATE INDEX IF NOT EXISTS idx_alertas_resuelta ON alertas(resuelta);

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

-- Links de API (Tunel, TermoKing, etc.)
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

