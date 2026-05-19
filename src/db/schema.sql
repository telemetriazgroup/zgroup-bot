-- Schema ZGroup Bot
-- Se ejecuta automáticamente la primera vez que arranca el contenedor PostgreSQL

CREATE TABLE IF NOT EXISTS usuarios (
  id         SERIAL PRIMARY KEY,
  nombre     VARCHAR(100) NOT NULL,
  telefono   VARCHAR(20)  NOT NULL UNIQUE,  -- ej: 51987654321
  activo     BOOLEAN      NOT NULL DEFAULT true,
  creado_en  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS equipos (
  id                   SERIAL PRIMARY KEY,
  id_equipo            VARCHAR(50)  NOT NULL UNIQUE,  -- ej: REF-001
  nombre               VARCHAR(100) NOT NULL,
  temperatura          NUMERIC(5,2),
  humedad              NUMERIC(5,2),
  ubicacion            VARCHAR(200),
  ultima_actualizacion TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usuario_equipos (
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  equipo_id  INTEGER NOT NULL REFERENCES equipos(id)  ON DELETE CASCADE,
  PRIMARY KEY (usuario_id, equipo_id)
);

CREATE TABLE IF NOT EXISTS alertas (
  id         SERIAL PRIMARY KEY,
  equipo_id  VARCHAR(50)  NOT NULL,
  tipo       VARCHAR(100) NOT NULL,
  temperatura NUMERIC(5,2),
  humedad    NUMERIC(5,2),
  ubicacion  VARCHAR(200),
  nivel      VARCHAR(20)  NOT NULL DEFAULT 'normal',  -- normal | critico
  resuelta   BOOLEAN      NOT NULL DEFAULT false,
  fecha      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Datos de ejemplo para pruebas
INSERT INTO usuarios (nombre, telefono) VALUES
  ('Carlos Ramirez', '51987654321'),
  ('Maria Lopez',    '51912345678')
ON CONFLICT DO NOTHING;

INSERT INTO equipos (id_equipo, nombre, temperatura, humedad, ubicacion) VALUES
  ('REF-001', 'Reefer Callao 01', -18.5, 85.0, 'Puerto del Callao - Zona A'),
  ('REF-002', 'Reefer Callao 02', -20.1, 82.3, 'Puerto del Callao - Zona B')
ON CONFLICT DO NOTHING;

-- Vincular usuarios de ejemplo con equipos
INSERT INTO usuario_equipos (usuario_id, equipo_id)
SELECT u.id, e.id
FROM usuarios u, equipos e
WHERE u.telefono = '51987654321' AND e.id_equipo IN ('REF-001', 'REF-002')
ON CONFLICT DO NOTHING;

INSERT INTO usuario_equipos (usuario_id, equipo_id)
SELECT u.id, e.id
FROM usuarios u, equipos e
WHERE u.telefono = '51912345678' AND e.id_equipo = 'REF-002'
ON CONFLICT DO NOTHING;
