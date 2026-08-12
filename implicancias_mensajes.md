# Implicancias de mensajería conversacional — ZGroup Bot

Documento de diseño: **cómo debe sonar y fluir la conversación**, **palabras clave de equipos/telemetría**, reglas para **no parecer un bot de difusión**, y **fases de implementación** hacia una capa propia de IA conversacional (grupo o 1:1).

Complementa [`wat_mensajes.md`](wat_mensajes.md) (anti-spam, grupos WhatsApp, rate limit).  
Este archivo se centra en el **flujo humano**, el **vocabulario** y el **roadmap técnico**.

---

## 0. Estado actual del proyecto (base real)

| Área | Hoy | Implicancia |
|------|-----|-------------|
| Cliente WA | `whatsapp-web.js` (Chromium) | Mismo canal que WhatsApp Web; frágil ante volumen |
| Entrada | `handlers.js`: `ESTADO` / `ALERTAS` / `AYUDA` exactos | No hay frases naturales ni contexto |
| Push | Monitor ~15 min → plantilla `ALERTA REEFER` a N usuarios | Señal de masivo; tono poco humano |
| ESTADO rico | Solo admin (`estado.js` + live + gráfica 12h + CA) | El chat no usa la mejor telemetría |
| Grupos BD | `grupos_alertas` = asignación de reefers | No son chats WhatsApp (`@g.us`) |
| Memoria | Ninguna | Cada mensaje es aislado |
| Cola / delays | ~2 s solo en test-estado; alertas sin pausa entre destinatarios | Ráfagas |
| Autor en grupo WA | No resuelto (`author`) | No se puede conversar bien en grupo aún |

La “IA” no empieza con un LLM: empieza con **reglas + contexto + ritmo humano**; el modelo de lenguaje llega cuando esas bases existan.

---

## 1. Principios de conversación humana

1. **Hablar como operador de monitoreo**, no como sistema de alarmas.  
2. **Un hilo = un tema** (un reefer o un grupo de planta), no un boletín.  
3. **Preguntar y esperar**, no inundar.  
4. **Recordar** de qué equipo se habló hace un minuto.  
5. **Espaciar** envíos (segundos entre mensajes; minutos entre avisos del mismo tipo).  
6. **En grupo**, responder a personas concretas; ignorar charla entre humanos.  
7. **Nunca** repetir el mismo bloque a muchos chats en segundos.

Frase guía:

> “Te aviso de algo concreto, te doy 3–5 datos útiles, y te pregunto qué necesitas después.”

---

## 2. Estructura de la conversación

### 2.1 Roles

| Rol | Quién | Qué hace |
|-----|--------|----------|
| **Operador** | Usuario registrado (privado o participante de grupo WA) | Pregunta, acusa recibo, pide detalle |
| **Monitor** | ZGroup Bot | Avisa eventos, responde consultas, ofrece siguientes pasos |
| **Contexto** | Memoria corta por chat | Último reefer, último grupo, última alerta, “esperando respuesta” |

### 2.2 Estados del diálogo (máquina de estados)

```
INACTIVO
   │ (usuario escribe / llega alerta)
   ▼
SALUDO_O_AVISO          ← 1 mensaje corto
   │
   ▼
ESPERANDO_INTENCION     ← el humano responde (o timeout)
   │
   ├─► INFORME_CORTO    ← telemetría 4–8 líneas
   │       │
   │       ▼
   │   ESPERANDO_SEGUIMIENTO  (OK / GRAFICA / OTRO / MAS)
   │       │
   │       ├─► MEDIA (gráfica) → vuelve a ESPERANDO_SEGUIMIENTO
   │       ├─► INFORME_OTRO_EQUIPO
   │       └─► CIERRE (ack) → INACTIVO
   │
   └─► IGNORAR (charla sin keywords en grupo)
```

Timeouts sugeridos:

| Estado | Tiempo sin respuesta | Acción |
|--------|----------------------|--------|
| ESPERANDO_INTENCION tras aviso | 15–20 min | Un solo recordatorio suave **o** silencio |
| ESPERANDO_SEGUIMIENTO | 30–60 min | Cerrar contexto (INACTIVO) |
| Mute `SILENCIO` | 1–8 h | No push; sí pull |

### 2.3 Turnos tipicos (guion)

#### A) El humano inicia (pull)

```
Humano:  estado
Bot:     Hola Carlos — tienes 12 reefers asignados; 2 con alerta.
         Los críticos: TK-Norte 02 (fuera de rango), CIM1086751 (offline).
         ¿Detalle de alguno? Escribe el nombre, IMEI, o TODOS.

Humano:  norte 02
Bot:     TK-Norte 02 — online. Retorno −4.1 °C, set −18 (±5).
         Lleva ~2 h fuera de rango.
         ¿GRAFICA, ALERTAS del grupo Norte, u OK?
```

#### B) El bot inicia (push crítico, 1 mensaje)

```
Bot:     Hola María — aviso del reefer TK-Norte 02 (Callao).
         Retorno −4.1 °C con set −18 °C. Fuera de rango hace ~2 h.
         ¿Lo revisan en planta? Responde OK, GRAFICA o ESTADO.
```

#### C) En grupo WhatsApp

```
Bot → grupo:  Aviso equipo: TK-Norte 02 fuera de rango (−4.1 / set −18).
              ¿OK, GRAFICA o DETALLE?

María: OK
Bot → grupo:  Gracias María — dejo el aviso en seguimiento.
              Si necesitan números, escriban ESTADO o el nombre del equipo.
```

### 2.4 Anatomía de un mensaje “humano”

Orden recomendado (máx. ~8 líneas):

1. **Saludo + nombre** (si privado) o “equipo” (si grupo)  
2. **Qué pasó** (1 frase)  
3. **Datos** (temp, set, rango, horas, conexión)  
4. **Contexto opcional** (proceso CA, IP, hora Lima)  
5. **Pregunta / opciones** (keywords)

No empezar con `*ALERTA CRÍTICA REEFER — ZGroup*` en todos los envíos.

---

## 3. Diccionario de palabras clave (interacción natural)

Las keywords deben aceptar **variantes**, mayúsculas/minúsculas, y errores leves.  
Internamente se normaliza: trim, minúsculas, sin tildes opcionales.

### 3.1 Intenciones globales (cualquier equipo)

| Intención | Keywords / frases | Acción del bot |
|-----------|-------------------|----------------|
| **ayuda** | `ayuda`, `menu`, `menú`, `comandos`, `hola`, `buenas`, `0` | Explicar opciones en tono corto |
| **estado** | `estado`, `como estan`, `cómo están`, `resumen`, `reporte`, `1` | Resumen de equipos del usuario |
| **alertas** | `alertas`, `pendientes`, `que paso`, `qué pasó`, `problemas`, `2` | Solo avisos activos |
| **ok / visto** | `ok`, `okay`, `visto`, `ya`, `listo`, `gracias`, `ya lo vieron`, `atendido` | Cerrar hilo / ack alerta |
| **grafica** | `grafica`, `gráfica`, `grafico`, `curva`, `12h`, `historico` | Imagen 12 h del equipo en contexto |
| **mas / detalle** | `mas`, `más`, `detalle`, `ampliar`, `completo`, `todo` | Ampliar último informe |
| **todos** | `todos`, `todas`, `el grupo`, `los demas`, `los demás` | Listar/resumir grupo en contexto |
| **silencio** | `silencio`, `mute`, `no avises`, `silencio 2h` | Pausar push temporal |
| **activar avisos** | `avisame`, `avísame`, `reactivar`, `quiero alertas` | Quitar mute |
| **ignorar** | charla sin match (`jajaja`, `voy`, `ya voy`) en grupo | No responder |

### 3.2 Keywords de equipo / telemetría

El usuario puede referirse al equipo por **nombre**, **IMEI parcial**, o **alias**.

| Intención | Keywords / patrones | Resolución |
|-----------|---------------------|------------|
| **elegir equipo** | nombre (`norte 02`, `cim1086751`), IMEI (≥6 dígitos), “el de callao” | Match contra `dispositivos.nombre` / `imei` asignados |
| **temperatura** | `temp`, `temperatura`, `retorno`, `supply`, `evaporacion` | Informe sensor pedido o sensor de control |
| **setpoint** | `set`, `setpoint`, `consigna`, `set point` | Mostrar set + delta + si está en rango |
| **rango** | `rango`, `fuera de rango`, `desviado` | min/max y horas fuera |
| **conexion** | `online`, `offline`, `conexion`, `conexión`, `señal`, `ip` | Estado conexión + último dato |
| **proceso ca** | `ca`, `proceso`, `receta`, `hass`, `atmosfera` | Bloque `proceso_ca` si existe |
| **comparar** | `peor`, `el mas critico`, `más crítico`, `cual esta mal` | Ordenar por severidad y hablar del top 1 |

### 3.3 Keywords de evento (cuando el bot avisa)

Mapear tipos internos → lenguaje humano:

| Código sistema | Cómo lo dice el bot | Keywords de seguimiento del usuario |
|----------------|---------------------|-------------------------------------|
| `fuera_de_rango` | “está fuera de rango” / “la temperatura se salió” | `grafica`, `desde cuando`, `detalle` |
| `offline` | “no tiene conexión” / “dejó de reportar” | `ultimo dato`, `ip`, `estado` |
| `wait` | “hace rato no manda datos” (usar poco en push) | `estado` |
| `cambio_setpoint` | “cambiaron el set” | `set`, `quien`, `detalle` |
| `online` | evitar push; si acaso “ya volvió a conectar” | `ok` |

### 3.4 Atajos numéricos (compatibles con menú actual)

| Número | Equivale a |
|--------|------------|
| `0` | ayuda |
| `1` | estado |
| `2` | alertas |
| `3` | grafica (si hay contexto de equipo) |
| `9` | ok / visto |

### 3.5 Menú conversacional sugerido (texto al usuario)

```text
Puedes escribirme como en el día a día, por ejemplo:
• "estado" o "cómo están los reefers"
• nombre o IMEI: "norte 02"
• "gráfica" / "alertas" / "ok"
• "silencio 2h" si no quieres avisos un rato
```

---

## 4. Memoria de conversación (fluidez)

### 4.1 Qué recordar (corto plazo, 30–120 min)

Por cada `chat_id` (privado `…@c.us` o grupo `…@g.us`):

```
conversacion_contexto
  chat_id
  canal: 'privado' | 'grupo'
  ultimo_usuario_id          -- quién habló (en grupo = participante)
  ultimo_imei
  ultimo_nombre_equipo
  ultimo_grupo_alertas_id    -- grupo lógico ZGroup (BD)
  ultima_intencion
  ultima_alerta_codigo
  esperando: null | 'equipo' | 'seguimiento' | 'confirmacion'
  mute_hasta
  actualizado_en
```

### 4.2 Reglas de uso de la memoria

| Situación | Uso del contexto |
|-----------|------------------|
| Usuario dice solo `GRAFICA` | Usar `ultimo_imei` |
| Usuario dice `OK` tras un aviso | Cerrar esa alerta / hilo |
| Usuario dice `y el otro?` | Mismo `ultimo_grupo_alertas_id`, siguiente crítico |
| Nuevo aviso de otro IMEI | Actualizar `ultimo_imei` y anunciar el cambio de tema |
| Timeout | Limpiar `esperando`; mantener `ultimo_imei` un poco más |

### 4.3 Memoria en grupo vs privado

| | Privado | Grupo WhatsApp |
|--|---------|----------------|
| Clave primaria | teléfono usuario | `jid` del grupo |
| Autor | = chat | `msg.author` → usuario BD |
| Ack `OK` | visto individual | “visto por el equipo” (quién) |
| Charla lateral | rara | frecuente → **ignorar** si no hay keyword |

---

## 5. Ritmo: no parecer bot / no difusión

### 5.1 Espaciado de envíos (obligatorio)

| Caso | Espera sugerida |
|------|-----------------|
| Entre 2 mensajes del bot al **mismo** chat | 8–15 s |
| Entre destinatarios distintos (si aún hay 1:1) | 25–45 s |
| Mismo (chat, imei, tipo_alerta) | 45–60 min cooldown |
| Máx. push / chat / hora | 3 |
| Máx. push / chat / día | 20 |
| Tras respuesta del usuario | Contestar en 2–8 s (parece humano atento, no instantáneo 0 ms) |

Implementación: cola `mensaje_outbox` + worker (ver fases).

### 5.2 Señales de “no soy un blast”

- Variar levemente el saludo (“Hola”, “Buenas”, “Aviso rápido”).  
- Usar **nombre de pila** y **nombre de reefer**, no solo IMEI.  
- Una pregunta al final.  
- No enviar 5 textos seguidos: **1 resumen** + detalle bajo demanda.  
- Preferir **grupo WA** (1 destino) frente a N privados idénticos.  

### 5.3 Qué no debe hacer la futura “IA”

- Inventar temperaturas o estados.  
- Enviar a números no asignados.  
- Multiplicar mensajes “por si acaso”.  
- Responder a todo en el grupo.  
- Usar tono de marketing o plantillas Meta no aprobadas en Web no oficial.  

Toda respuesta de IA debe mapear a una **acción cerrada** (consulta BD / live / gráfica / ack / silencio).

---

## 6. Arquitectura objetivo (capas)

```
[ WhatsApp Web ]
       │
       ▼
[ Ingesta ]  privado | grupo + author
       │
       ▼
[ Normalizar texto + resolver usuario ]
       │
       ▼
[ Intenciones ]  reglas → (fase 4) clasificador IA
       │
       ▼
[ Contexto ]  memoria corta por chat
       │
       ▼
[ Acciones ]  estado / alertas / gráfica / ack / mute
       │         (reutilizar estado.js, live, historico, informe-ca)
       ▼
[ Redacción ]  plantillas conversacionales → (fase 4) NLG acotado
       │
       ▼
[ Outbox + rate limit + delays ]
       │
       ▼
[ Envío WhatsApp ]
```

Archivos actuales a evolucionar:

- `src/handlers.js` → orquestador de intenciones  
- `src/bot.js` → author de grupo, outbox hook  
- `src/services/estado.js` → informe usado también por chat  
- `src/services/monitoreo.js` / `alertas.js` → push vía outbox + tono humano  
- Nuevo: `src/services/conversacion.js`, `src/services/outbox.js`, `src/services/intenciones.js`

---

## 7. Fases de implementación

### Fase 0 — Contención (1–2 días) ✅ parcialmente documentada

**Meta:** bajar riesgo de nueva advertencia YA.

- Desactivar push `online` / limitar `wait`.  
- No tests masivos desde admin.  
- Documentación (`wat_mensajes.md`, este archivo).  
- Operación: preferir que el usuario escriba `ESTADO`.

**Criterio de éxito:** menos mensajes push/día; sin ráfagas evidentes.

---

### Fase 1 — Conversación básica + telemetría real (1–2 semanas)

**Meta:** que el chat use la misma calidad que el test-estado admin.

Entregables:

1. `ESTADO` / `ALERTAS` en chat → `dispositivos` + live (`estado.js`), no solo `equipos` legacy.  
2. Keywords capa A: `OK`, `GRAFICA`, `MAS`, `TODOS`, `SILENCIO`.  
3. Match de equipo por nombre/IMEI en el texto.  
4. Respuestas con saludo + CTA (sin plantilla `ALERTA CRÍTICA` en pull).  
5. Delay 8–15 s si el bot envía más de un mensaje al mismo chat.

**Criterio de éxito:** un operador obtiene telemetría live escribiendo como en la sección 2.3.A.

---

### Fase 2 — Memoria + outbox + ritmo humano (2–3 semanas)

**Meta:** fluidez y anti-spam técnico.

Entregables:

1. Tabla `conversacion_contexto` (+ API interna).  
2. Tabla `mensaje_outbox` + worker con topes hora/día y cooldown.  
3. Push crítico reescrito: 1 mensaje conversacional; gráfica solo si piden o umbral fuerte.  
4. Deduplicación por transición de estado (ya hay pendiente; sumar cooldown).  
5. Variantes de saludo / textos (3–4 plantillas por intención).

**Criterio de éxito:** mismo evento no genera N mensajes idénticos en ráfaga; `GRAFICA` sin repetir IMEI funciona por contexto.

---

### Fase 3 — Grupos WhatsApp como canal (2–3 semanas)

**Meta:** un destino grupal por planta/cliente.

Entregables:

1. Tablas `whatsapp_grupos` (+ vínculo a `grupos_alertas`).  
2. Ingesta: detectar `@g.us`, resolver `author` → usuario BD.  
3. Alertas del monitor → jid del grupo (no fan-out 1:1).  
4. Ignorar mensajes sin keywords en el grupo.  
5. Ack grupal con nombre de quien dijo OK.

**Criterio de éxito:** alerta de un reefer sale **una vez** al grupo; María responde `OK` y el bot reconoce a María.

---

### Fase 4 — “IA propia” de conversación (3–6 semanas)

**Meta:** frases naturales sin romper reglas de seguridad/ritmo.

Arquitectura de la IA (recomendada):

| Pieza | Función | Nota |
|-------|---------|------|
| **Clasificador de intención** | Texto → `{ intencion, entidades }` | Puede ser reglas avanzadas primero; luego modelo pequeño/API |
| **Extractor de entidades** | IMEI, nombre reefer, horas de silencio | Regex + fuzzy match a BD |
| **Política** | ¿Se puede ejecutar? ¿Mute? ¿Rate limit? | Siempre código determinista |
| **NLG acotado** | Rellenar plantilla conversacional con datos reales | El modelo **no inventa** números |
| **Memoria** | Contexto corto (+ opcional resumen diario) | Postgres |

Pasos:

1. Dataset interno de frases reales de operadores → intenciones (sección 3).  
2. Clasificador offline (incluso sin GPU: embeddings + reglas).  
3. Shadow mode: loguear intención sugerida sin enviar.  
4. Activar NLG solo para saludos/cierres; datos siempre de `live`/`db`.  
5. Evaluación: % intenciones correctas, % mensajes omitidos por rate limit, quejas de spam.

**Criterio de éxito:** frases como “mándame la curva del norte” y “ya lo vieron en planta” se resuelven sin comando exacto, con telemetría veraz y sin blast.

---

### Fase 5 — Endurecimiento y evolución (continuo)

- Horario laboral / solo crítico de noche.  
- Contacto primario vs observadores.  
- Métricas en admin: mensajes/día, omitidos, ack rate.  
- Valoración de **WhatsApp Cloud API** para producción regulada.  
- Retiro progresivo de plantillas tipo broadcast.

---

## 8. Matriz de flujo natural (resumen visual)

```
                 ┌─────────────┐
                 │  INACTIVO   │
                 └──────┬──────┘
        pull keyword    │     push crítico
        (estado…)       │     (1 mensaje)
                        ▼
              ┌───────────────────┐
              │  AVISO / RESUMEN  │
              │  + pregunta CTA   │
              └─────────┬─────────┘
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
      OK/visto     GRAFICA/DETALLE   nombre/IMEI
        │               │               │
        ▼               ▼               ▼
     CIERRE         MEDIA/DATOS     INFORME EQUIPO
                        │               │
                        └───────┬───────┘
                                ▼
                       ¿más keywords?
                        sí → seguir
                        no / timeout → INACTIVO
```

---

## 9. Implicancias organizativas

| Tema | Implicancia |
|------|-------------|
| Operadores | Entrenar keywords simples; no esperar “newsletter” cada 15 min |
| Admin ZGroup | Configurar grupos WA por planta; asignar usuarios/dispositivos |
| Soporte | Si WhatsApp advierte otra vez: bajar push, subir pull, revisar outbox |
| Legal / ToS | Cliente Web no oficial sigue siendo riesgo; IA no elimina ese riesgo |
| Datos | La IA no sustituye la telemetría: solo la **explica** y **enruta** |

---

## 10. Criterios de aceptación globales (definición de “listo”)

1. Un humano puede obtener telemetría live sin usar solo menú rígido.  
2. El bot recuerda el último equipo en el hilo (privado y grupo).  
3. Los envíos respetan delays y topes; no hay ráfagas a muchos números.  
4. Push = evento crítico conversacional; no plantilla masiva.  
5. En grupo, solo usuarios registrados activan al bot.  
6. Cualquier capa “IA” solo elige entre acciones permitidas y datos reales.

---

## 11. Relación con otros documentos

| Documento | Contenido |
|-----------|-----------|
| [`wat_mensajes.md`](wat_mensajes.md) | Por qué WhatsApp advierte; rate limit; grupos; lectura de `author` |
| **`implicancias_mensajes.md`** (este) | Guion conversacional; keywords; memoria; fases hacia IA |
| Código | `handlers.js`, `estado.js`, `monitoreo.js`, `bot.js`, `db` |

Orden de trabajo sugerido: **Fase 0 → 1 → 2 → 3 → 4**.  
No saltar a un LLM (Fase 4) sin outbox, contexto y keywords (Fases 1–2).

---

*Documento vivo — alinear implementación y métricas en cada fase.*
