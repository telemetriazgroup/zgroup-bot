# Estrategia de mensajería WhatsApp — informes de telemetría (ZGroup)

Documento de referencia tras la **advertencia de WhatsApp por envío masivo**.  
Objetivo: que el bot se comporte como una **conversación útil de monitoreo**, no como un canal de difusión (broadcast / spam).

---

## 1. Por qué WhatsApp advierte

WhatsApp marca cuentas no oficiales (WhatsApp Web / `whatsapp-web.js`) cuando detecta patrones de **mensajería masiva no solicitada**:

| Señal de riesgo | Cómo se ve hoy en ZGroup |
|-----------------|--------------------------|
| Muchos chats distintos en poco tiempo | Un ciclo de monitor envía a N usuarios × M dispositivos |
| Mensajes casi idénticos (“plantilla”) | Texto fijo `ALERTA REEFER — ZGroup` / `ALERTA CRÍTICA` |
| Iniciativa del bot sin respuesta del usuario | Push cada 15 min sin que el usuario haya pedido nada |
| Ráfagas sin pausa | Varios `sendMessage` seguidos al mismo o a varios números |
| Contenido solo de alerta, sin diálogo | No hay saludo, contexto ni cierre conversacional |

La API oficial (Cloud API) permite plantillas y alto volumen con reglas claras.  
Con **WhatsApp Web no oficial**, el margen es mucho menor: hay que **parecer un operador humano** que avisa de un reefer concreto.

---

## 2. Principio rector

> **Un mensaje = un evento relevante para una persona**, en tono de conversación, con telemetría breve y una pregunta o CTA que invite a responder.

Evitar:

- “Newsletter” de todos los equipos a la vez cada X minutos  
- Copiar/pegar el mismo bloque a 20 números  
- Enviar gráficos + textos largos a todos los usuarios del sistema en el mismo ciclo  

Preferir:

- Solo **quien tiene asignado** ese IMEI/grupo  
- Solo cuando hay **cambio real** (offline, fuera de rango, setpoint) o cuando el usuario **pide** `ESTADO` / `ALERTAS`  
- Mensajes cortos, personalizados, con pausas  

---

## 3. Estrategias recomendadas

### 3.1 Modelo “pull primero, push solo crítico”

| Tipo | Cuándo enviar | Ejemplo |
|------|----------------|---------|
| **Pull (seguro)** | Usuario escribe `ESTADO`, `ALERTAS`, `AYUDA` | Informe bajo demanda |
| **Push crítico** | Fuera de rango ≥ X horas, offline prolongado, setpoint cambiado | 1 aviso por evento |
| **Push informativo** | Evitar o limitar mucho (online/wait “recuperó conexión”) | Agrupar o desactivar |

**Acción:** dejar `alerta_online` / `alerta_wait` en `false` por defecto; mantener críticas (`fuera_de_rango`, `offline` largo, `cambio_setpoint` si importa).

---

### 3.2 Un evento → un mensaje (no N mensajes por dispositivo)

Hoy un grupo con 5 reefers puede generar 5+ textos (+ gráficas).  
Estrategia:

1. **Resumen conversacional** (1 mensaje):  
   *“Hola Juan, detecté 2 reefers fuera de rango en el grupo Frío Callao. ¿Te mando el detalle del más crítico o de todos?”*  
2. Si responde **“detalle” / “todos” / IMEI** → enviar telemetría.  
3. Si no responde en 10–15 min → opcional: **un solo** mensaje con el peor caso (no los 5).

Así el tráfico se parece a un chat de operaciones, no a un blast.

---

### 3.3 Tono natural + telemetría corta

**Evitar (plantilla fría):**

```text
🚨 *ALERTA CRÍTICA REEFER — ZGroup*

📦 Equipo: *8684...*
⚠️ Tipo: ...
```

**Preferir (conversación + datos):**

```text
Hola Carlos — aviso del reefer *CIM1086751* (grupo Callao).

El retorno va en *-6.3 °C* y el set está en *-25 °C* (±8).
Lleva más de *3 h* fuera de rango (revisión últimas 12 h).

¿Quieres que te mande la gráfica o el estado de los demás del grupo?
(Responde: GRAFICA / ESTADO / OK)
```

Reglas de redacción:

- Saludar con **nombre** del usuario (`usuarios.nombre`)  
- Nombrar **reefer / grupo**, no solo IMEI  
- 4–8 líneas de telemetría máximo; el resto bajo demanda  
- Cerrar con **pregunta o comando** (`ESTADO`, `OK`, `GRAFICA`)  
- Evitar emojis excesivos y mayúsculas tipo “ALERTA CRÍTICA” en todos los envíos  

---

### 3.4 Anti-ráfaga (rate limiting humano)

Implementar cola de salida:

| Parámetro sugerido | Valor inicial | Motivo |
|--------------------|---------------|--------|
| Pausa entre mensajes al **mismo** número | 8–15 s | Evita ráfaga |
| Pausa entre **números distintos** | 20–45 s | Reduce fingerprint masivo |
| Máx. mensajes push / usuario / hora | 3–5 | Tope duro |
| Máx. mensajes push / número / día | 15–25 | Tope diario |
| Cooldown por (usuario, imei, tipo_alerta) | 30–60 min | No repetir el mismo aviso |

Si se supera el tope: guardar en BD como `alerta_pendiente` y:

- incluirla la próxima vez que el usuario pida `ESTADO`, o  
- un único digest: *“Tienes 4 avisos pendientes; escribe ALERTAS”*.

---

### 3.5 Deduplicación y “solo en transición”

No reenviar si el estado no cambió:

- `fuera_de_rango` → notificar al **entrar**; silencio mientras sigue fuera (salvo digest cada 2–4 h si sigue crítico)  
- `online` → no notificar si ya estaba online  
- Test de alarma / test estado → solo al número que lo dispara desde admin, nunca a todos  

---

### 3.6 Ventana horaria y destinatarios

- Respetar horario laboral si el cliente lo pide (ej. 06:00–22:00 Lima); fuera de horario solo **crítico**  
- Un contacto “principal” por grupo + opcionales “en copia” con menos frecuencia  
- No enviar a usuarios inactivos (`activo = false`)  

---

### 3.7 Sesión conversacional (ventana 24 h “humana”)

Mantener el hilo vivo reduce la sensación de spam:

1. Tras un push, el bot **espera respuesta** 5–15 min.  
2. Comandos cortos: `OK`, `ESTADO`, `GRAFICA`, `MAS`, `1`/`2`.  
3. Si el usuario responde, los siguientes mensajes del mismo tema son **continuación**, no nuevos “ALERTA ZGroup”.  
4. Si no hay respuesta, no insistir con el mismo texto; como máximo un recordatorio suave una vez.

---

### 3.8 Gráficas e imágenes

Las imágenes pesan y cuentan como actividad intensa:

- Enviar gráfica **solo** si:  
  - el usuario pide `GRAFICA`, o  
  - fuera de rango ≥ 2 h **y** no se envió gráfica de ese IMEI en las últimas 2–4 h  
- Caption corto; detalle en texto aparte solo si lo piden  

---

### 3.9 Separar “pruebas” de “producción”

- Tests desde admin → un usuario, mensaje marcado *prueba*, delay largo  
- Nunca disparar test masivo a toda la base  
- Preferir horarios de baja carga para pruebas  

---

## 4. Flujos objetivo (resumen)

### A) Usuario inicia

```
Usuario: ESTADO
Bot:     [1 mensaje resumen] + “¿Detalle de alguno? Escribe el nombre o IMEI”
Usuario: CIM1086751
Bot:     [telemetría + CA si aplica + opción GRAFICA]
```

### B) Alerta crítica (push)

```
Sistema: fuera_de_rango (nuevo / transición)
Bot → usuario asignado (1):
  “Hola {nombre}, el reefer {nombre} está fuera de rango…
   Temp X / Set Y. ¿GRAFICA o ESTADO del grupo?”
```

### C) Digest (si hay cola)

```
Bot: “Tienes 3 avisos pendientes de esta mañana. Escribe ALERTAS para verlos.”
```

---

## 5. Cambios técnicos sugeridos en el bot (prioridad)

1. **Cola de envío** (`mensaje_outbox`): `telefono`, `payload`, `prioridad`, `enviar_despues`, `estado`.  
2. **Worker** que respeta delays y topes diarios/horarios.  
3. **Tabla / campos** `ultimo_aviso_en` por `(usuario_id, dispositivo_id, tipo)`.  
4. **Plantillas conversacionales** (funciones) con nombre + CTA.  
5. **Agrupar** alertas del mismo ciclo en un resumen por usuario.  
6. **Desactivar** push de `online` / `wait` salvo configuración explícita.  
7. **Comandos** nuevos: `OK`, `GRAFICA`, `MAS`, `SILENCIO 2H` (mute temporal).  
8. **Logs** de rate-limit: cuántos mensajes se omitieron por tope (auditoría).

---

## 6. Checklist operativo (inmediato, sin código)

- [ ] Revisar usuarios con muchos dispositivos: ¿todos necesitan push?  
- [ ] Bajar intervalo de monitor o no enviar en cada ciclo si no hay cambio  
- [ ] Pausar envíos masivos de test desde admin  
- [ ] Pedir a operadores que usen `ESTADO` / `ALERTAS` en lugar de esperar blast  
- [ ] Si la advertencia es grave: **no vincular números personales críticos**; usar número dedicado y reducir volumen  
- [ ] Evaluar a medio plazo **WhatsApp Cloud API** (oficial) para alertas de negocio  

---

## 7. Relación con el riesgo de ban

| Enfoque | Riesgo |
|---------|--------|
| Seguir con blast cada 15 min a muchos chats | Alto (advertencia → restricción → ban) |
| Pull + push crítico + rate limit + tono natural | Medio-bajo (uso tipo “operador”) |
| Cloud API oficial + plantillas aprobadas | Bajo (cumplimiento Meta) |

Este documento define la **dirección de producto/mensajería**. La implementación en código (`alertas.js`, `monitoreo.js`, `estado.js`, `handlers.js`) debe alinearse a estas reglas antes de volver a subir el volumen de envíos.

---

## 8. Ejemplo de mensaje “bueno” vs “malo”

**Malo (masivo / plantilla):**  
mismo bloque a 12 números, 5 reefers seguidos, sin pausa, sin nombre, sin pregunta.

**Bueno (conversación + telemetría):**

```text
Hola María,

Aviso del *TK- Norte 02*: retorno -4.1 °C con set -18 °C (±5).
Lleva ~2 h fuera de rango.

Puedo enviarte la gráfica de 12 h o el resumen del grupo Norte.
Responde GRAFICA, ESTADO o OK si ya lo vieron en planta.
```

---

## 9. Grupo WhatsApp como canal de alertas (consideración)

En lugar de enviar el **mismo aviso a N chats privados** (patrón de difusión), se puede crear **un grupo** con:

- el número del **bot** (cuenta vinculada a ZGroup), y  
- los números de quienes deben recibir telemetría / alertas (operadores, supervisores).

Así WhatsApp ve **un solo destino** (`grupo@g.us`) por evento, no N conversaciones casi idénticas. Eso reduce la señal de “mensajería masivo” y concentra la conversación en un hilo operativo.

### 9.1 Cómo se vería en la práctica

```
Grupo: "ZGroup — Callao Reefers"
Participantes: Bot ZGroup + María + Carlos + Supervisor

[Bot]  Hola equipo — reefer TK-Norte 02 fuera de rango (−4.1 °C / set −18).
       ¿GRAFICA, ESTADO del grupo o OK?

[María] OK, ya lo vieron en planta
[Bot]   Perfecto María, dejo el aviso en seguimiento. Escriban ESTADO si necesitan el resumen.
```

Ventajas:

| Ventaja | Detalle |
|---------|---------|
| Menos chats salientes | 1 mensaje al grupo ≠ 1 mensaje × cada persona |
| Contexto compartido | Todos ven la misma alerta y quién respondió |
| Conversación natural | El bot responde a menciones / comandos en el grupo |
| Menos plantillas clonadas | Un solo texto, no N copias |

Riesgos / cuidados:

- No meter a gente que no deba ver IMEIs/temperaturas (privacidad).  
- Evitar que el bot responda a **cada** mensaje del grupo (ruido).  
- Un grupo por **cliente / planta / zona**, no un mega-grupo de toda la empresa.  
- El bot debe estar en el grupo (admin o miembro que pueda escribir).  

### 9.2 Cómo el programa “lee” mensajes del grupo

Con **whatsapp-web.js** (cliente actual), cada mensaje entrante trae metadatos. En un **chat privado** el remitente y el chat son el mismo número; en un **grupo** hay que separar ambos.

| Campo (concepto) | Chat privado | Grupo |
|------------------|--------------|--------|
| Destino / chat | `519...@c.us` | `120363...@g.us` |
| Quién escribió | ese mismo número | **participante** (`msg.author` / `msg.id.participant`) |
| Texto | `msg.body` | `msg.body` |
| ¿Es grupo? | no | `msg.from` termina en `@g.us` o `msg.isGroupMsg` |

Flujo propuesto al recibir un mensaje:

```
1. ¿msg.fromMe? → ignorar (eco del bot)
2. ¿Es grupo (@g.us)?
     SÍ → chatId = grupo
           autorTelefono = participante (quien escribió)
     NO → chatId = privado
           autorTelefono = msg.from
3. Normalizar autorTelefono (solo dígitos, sin @c.us)
4. Buscar en BD: usuario activo con ese teléfono
5. Si no está registrado → ignorar (o solo log)
6. Parsear intención del texto (sección 10)
7. Responder en el mismo chatId (grupo o privado)
```

**Estado actual del código:** `handlers.js` trata `remoteJid` como si fuera el teléfono del usuario. En un grupo eso sería el id del grupo (`…@g.us`), **no** el operador. Para grupos hay que leer el **participante** y seguir enviando respuestas a `grupo@g.us`.

Ejemplo conceptual (whatsapp-web.js):

```js
client.on('message', async (msg) => {
  if (msg.fromMe) return

  const esGrupo = msg.from.endsWith('@g.us')
  const chatId = msg.from
  // En grupo: author = quien escribió; en privado: from
  const autorJid = esGrupo ? (msg.author || msg.id?.participant) : msg.from
  const telefono = String(autorJid || '').replace(/\D/g, '') // 519...

  const usuario = await db.buscarUsuarioPorTelefono(telefono)
  if (!usuario) return

  const texto = (msg.body || '').trim()
  // ... interpretar y responder a chatId (el grupo)
  await client.sendMessage(chatId, respuesta)
})
```

### 9.3 Quién puede hablarle al bot en el grupo

Reglas recomendadas:

1. **Solo números registrados** en `usuarios` (y activos).  
2. Opcional: tabla `whatsapp_grupos` con `jid_grupo`, `nombre`, `activo`, y vínculo a `grupos_alertas` / cliente.  
3. El bot **ignora** mensajes de personas ajenas al grupo operativo (aunque estén en el WhatsApp group).  
4. Alertas push del monitor → enviar **solo al jid del grupo** asignado a esos dispositivos (no a cada privado).  
5. Privados siguen válidos para quien prefiera 1:1 (`ESTADO` por DM).

Modelo de datos sugerido:

```
whatsapp_grupos
  id, jid (@g.us), nombre, activo

whatsapp_grupo_usuarios   (opcional, si no basta “estar en usuarios”)
  grupo_id, usuario_id

whatsapp_grupo_dispositivos / enlace a grupos_alertas
  qué reefers notifican a este WhatsApp group
```

### 9.4 Cuándo el bot escribe en el grupo (sin ser spam)

- Entrada a estado crítico (fuera de rango, offline largo).  
- Respuesta a un comando de un usuario autorizado.  
- Digest corto si hay cola (*“3 avisos pendientes; digan ALERTAS”*).  
- **No** saludar ni responder a charla humana entre operadores (“ya voy”, “ok gracias”) salvo palabras clave o mención al bot.

Filtro anti-ruido:

- Responder solo si el texto parece **comando / intención** (sección 10), o si mencionan al bot (`@Bot`, `ZGroup`, `bot`).  
- Cooldown: no más de N mensajes bot / grupo / 10 min.  

---

## 10. Cómo el programa lee lo que dice el cliente (conversación)

La idea no es “IA libre” al inicio, sino un **intérprete de intenciones** sobre el texto del usuario (privado o grupo), que mantiene un **contexto de conversación** por chat.

### 10.1 Pipeline de lectura

```
Texto crudo del usuario
    → normalizar (trim, minúsculas, quitar acentos opcionales)
    → detectar intención (comandos + frases naturales)
    → cargar contexto (último reefer / grupo / alerta hablada)
    → ejecutar acción (consulta BD / live / gráfica)
    → responder en tono conversacional
    → guardar contexto para el siguiente mensaje
```

### 10.2 Capas de interpretación (de más simple a más flexible)

**Capa A — Comandos exactos (ya existen / ampliar)**  

| Usuario escribe | Intención |
|-----------------|-----------|
| `ESTADO`, `1` | Resumen de equipos asignados |
| `ALERTAS`, `2` | Alertas activas |
| `AYUDA`, `0` | Menú |
| `OK`, `VISTO` | Cerrar / acusar recibo del último aviso |
| `GRAFICA`, `GRÁFICA` | Gráfica 12 h del reefer en contexto |
| `MAS`, `MÁS`, `DETALLE` | Ampliar último resumen |
| `SILENCIO 2H` | Mute temporal de push |

**Capa B — Frases naturales (reglas / palabras clave)**  

Ejemplos → misma intención que un comando:

| Frase del usuario | Intención detectada |
|-------------------|---------------------|
| “cómo está el norte 02” | ESTADO de ese reefer |
| “mándame la gráfica” | GRAFICA |
| “ya lo revisamos” / “ok gracias” | OK (ack) |
| “y los demás?” | MAS / resumen del grupo |
| “temperatura del CIM…” | ESTADO + match por nombre/IMEI |
| “quién tiene alerta” | ALERTAS |

Implementación inicial: normalizar texto + `includes` / regex, sin LLM.

**Capa C — Contexto (memoria corta)**  

Guardar por `chatId` (privado o grupo), p. ej. 30–60 min:

```
contexto_chat = {
  chat_id,
  ultimo_usuario_id,      // quién habló
  ultimo_imei,            // reefer del que se habló
  ultimo_grupo_alertas,   // grupo lógico ZGroup
  ultima_alerta_tipo,     // fuera_de_rango, offline...
  esperando: null | 'eleccion_reefer' | 'confirmacion'
}
```

Así:

1. Bot avisa del TK-Norte 02.  
2. Usuario: `GRAFICA` → el programa usa `ultimo_imei` del contexto.  
3. Usuario: `y el otro?` → listar reefers del mismo grupo lógico.

**Capa D — (Opcional, más adelante) LLM**  

Solo si hace falta entender frases ambiguas; siempre con **lista cerrada de acciones** (no inventar envíos). El LLM clasifica intención; el bot ejecuta la acción segura.

### 10.3 Pseudocódigo de conversación

```js
async function interpretar(texto, contexto, usuario) {
  const t = normalizar(texto)

  if (esAck(t)) return { intencion: 'ok' }
  if (esAyuda(t)) return { intencion: 'ayuda' }
  if (esAlertas(t)) return { intencion: 'alertas' }
  if (esGrafica(t)) return { intencion: 'grafica', imei: contexto.ultimo_imei }
  if (esEstado(t)) {
    const imei = extraerImeiONombre(t) || contexto.ultimo_imei
    return { intencion: 'estado', imei }
  }
  if (contexto.esperando === 'eleccion_reefer') {
    return { intencion: 'estado', imei: resolverNombre(t, usuario) }
  }
  // Charla sin comando en grupo → no responder
  return { intencion: 'ignorar' }
}
```

### 10.4 Respuestas que mantienen la conversación

Después de cada informe, el bot deja **opciones claras**:

```text
Responde:
• OK — si ya lo atendieron
• GRAFICA — curva 12 h
• ESTADO — resumen de tus reefers
• ALERTAS — solo pendientes
```

En grupo, puede etiquetar quién preguntó:

```text
@María — gráfica del TK-Norte 02 (últimas 12 h):
[imagen]
```

(Si la mención nativa no es fiable, usar el nombre en texto: `María: …`.)

### 10.5 Diferencia privado vs grupo al conversar

| | Privado | Grupo |
|--|---------|--------|
| Quién autoriza | teléfono del chat | teléfono del **participante** |
| Dónde responde el bot | al número | al **jid del grupo** |
| Contexto | por número | por grupo (+ quién habló) |
| Ack `OK` | cierra alerta para ese usuario | puede marcar “visto por el equipo” |

---

## 11. Recomendación de adopción

1. **Corto plazo:** reducir push 1:1; comandos pull; rate limit (secciones 3–5).  
2. **Medio plazo:** un grupo WhatsApp por planta/cliente; alertas críticas → grupo; leer `author` + comandos/contexto (secciones 9–10).  
3. **No** crear un solo grupo gigante con todos los números de la empresa.  
4. Mantener privados solo para quien lo pida o para pruebas admin.

---

*Última actualización: grupos WhatsApp + lectura de conversación (participante / intenciones / contexto).*
