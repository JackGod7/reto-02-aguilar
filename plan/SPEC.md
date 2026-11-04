# SPEC operativa (destilada del PRD; verificada contra los fixtures)

Hoy de referencia en demo/tests: `hoy = 2026-09-03` (la fecha real del sistema NO se usa para datos).

## 1. Modelo de datos
`Contrato` (zod): `id_contrato, cliente, nit_cliente (string, conserva ceros: "08019995123456"), pais (CO|EC|PE|PA|HN), objeto (<=200), valor (number), valor_indeterminado (boolean), moneda (COP|USD|PEN|PAB|HNL), fecha_inicio, fecha_fin (YYYY-MM-DD), requiere_poliza, tipo_poliza (string ';'), estado_poliza (vigente|pendiente|vencida|no_aplica), comercial, confianza: Record<campo, 0..1>, advertencias: string[]`.
Maestro CSV (RFC 4180, comillas si hay coma/comilla/salto; prefijo `'` si la celda empieza con `= + - @`) columnas: `id_contrato,cliente,nit_cliente,pais,objeto,valor,moneda,fecha_inicio,fecha_fin,requiere_poliza,tipo_poliza,estado_poliza,comercial,ruta_sharepoint,fecha_registro,fuente`.
Primera ejecución copia `fixtures/reto-02/maestro-contratos.csv` → `out/sharepoint/maestro-contratos.csv` (si no existe).

## 2. Extracción (determinista, regex por cláusula; el LLM NO extrae valores)
- Tipo de documento: 1ª línea empieza `CONTRATO` → contrato; `OTROSÍ` → otrosí; si no (p.ej. `COTIZACIÓN`) o sin adjunto → `tiene_contrato:false` → **rechazado** (motivo).
- Partes: bloque "Entre …": cada parte `NOMBRE, (NIT|RUC) n°`. **Periferia = NIT 900123456** (parte propia); el **cliente es la otra parte**. País del cliente por su identificador/domicilio: Bogotá/Medellín/Barranquilla→CO, Quito→EC, Lima→PE; RUC 13 díg→EC, RUC 11 díg→PE. Nunca por el domicilio de Periferia (Medellín). Si Periferia figura como CONTRATANTE → `requiere_revision:["rol_de_partes"]`.
- NIT: quitar puntos y DV (`890.900.111-4`→`890900111`, `800.222.333-9`→`800222333`, `890.903.456-1`→`890903456`). RUC EC (13) y PE (11) se conservan.
- Valor: del paréntesis tras la cláusula VALOR: `(COP $265.000.000)`, `(USD 120,000.00)`, `(PEN 520,000.00)`. Normalizar: si hay `.` y `,` el último es decimal; si solo `.` o `,` en grupos de 3 → miles. Respaldo en letras si falla. "no tiene un valor determinado" → valor 0, `valor_indeterminado=true`.
- Fechas: usar el número entre paréntesis: "primero (1) de agosto de 2026" → 2026-08-01; meses en español. Plazo en meses sin fechas → fin = inicio + N meses mismo día (2026-08-31 + 12 m = 2027-08-31, así lo espera el PRD).
- Póliza: cláusula GARANTÍAS con "póliza de X" → requiere_poliza true, tipo "x"; ausente → false/`no_aplica`. msg-006 (póliza condicional por orden >COP 100M) → requiere_poliza true, tipo "cumplimiento" (supuesto documentado).
- Confianza: 1.0 explícito · 0.8 inferido acotado (msg-006 inicio = fecha del correo, el mes viene en el texto) · 0.6 calculado (fin por 12 meses) · 0.5 indeterminado (valor 0) · 0 ausente (null). **Umbral: confianza < 0.8 → `requiere_revision`** (0.8 NO entra).
- Otrosí: leer id referenciado ("CONTRATO … No. CT-2026-011"), `fecha_fin` ("se extiende hasta el primero (1) de noviembre de 2027"), `valor`; **campos ausentes se heredan del maestro** (confianza 1.0 de origen "maestro"). Póliza "deberán ampliarse" → `estado_poliza = pendiente`.
- Comercial: remitente de `correo.json` contra `comerciales.json` por email → nombre; no registrado → `comercial=""` + advertencia (NO bloquea).

## 3. Reglas
RN1 duplicado: mismo `id_contrato` y mismos valor, fecha_inicio, fecha_fin → sin escritura. RN2 actualización: mismo id (o mismo NIT + similitud de objeto ≥0.9, ej. Jaccard de tokens) y algún campo distinto, u otrosí → actualiza fila + línea en `out/sharepoint/historial.jsonl` `{ts,id_contrato,accion,cambios,mensaje_id}`. RN3 nuevo. RN4 rechazado (sin contrato / sin partes ni objeto). RN5 `requiere_revision` = campos con confianza <0.8 + conflictos. **No deduplicar solo por NIT**: 001, 002, 006 son clientes existentes con otro objeto → deben ser `nuevo`.

## 4. Resultados esperados (los 6 mensajes; tests = estos)
| msg | clasif. | detalle |
|---|---|---|
| 001 | nuevo CT-2026-015 | Industrias Delta, 890900111, CO, COP 265000000, 2026-08-01→2027-07-31, póliza cumplimiento→`pendiente`, comercial Laura Gómez Restrepo, sin revisión |
| 002 | nuevo CT-2026-016 | Corporación Andina de Servicios S.A., 1790012345001, **EC**, USD 120000, 2026-08-15→2027-08-14, `no_aplica`, Carlos Ruiz Medina |
| 003 | actualizacion CT-2026-011 | fecha_fin 2027-05-01→**2027-11-01**, valor 350000→**520000** PEN, resto heredado, estado_poliza→pendiente, historial |
| 004 | duplicado CT-2026-012 | sin escritura |
| 005 | rechazado | cotización, tiene_contrato:false |
| 006 | nuevo CM-2026-03 | Distribuidora Caribe 800222333, valor 0 (0.5), inicio 2026-08-31 (0.8), fin 2027-08-31 (0.6) → `requiere_revision:["valor","fecha_fin"]`, remitente jperez no registrado→advertencia, **no se registra hasta `confirmado:true`** |
Alertas con hoy=2026-09-03 → `out/alertas.md`: (1) vencen ≤60 d: CT-2026-009 (09-30), CT-2026-004 (10-15); sección aparte "ya vencidos": CT-2025-018, CT-2026-002. (2) póliza requerida y no vigente: CT-2026-004, CT-2026-015, CT-2026-011, CM-2026-03. (3) `fecha_registro >= 2026-05-30`: CT-2026-015, CT-2026-016, CM-2026-03. `fecha_registro` = `hoy` (arg), no la fecha del sistema.

## 5. Tools (nombre al modelo = `contratos_<export>`; src/tools/contratos.ts)
- `leer_buzon {}` → `{mensajes:[{id,de,asunto,fecha,adjuntos,tiene_contrato}]}` (excluye los de `out/procesados.json`).
- `extraer {mensaje_id}` → Contrato con confianza (mensaje_id `^msg-\d{3}$`).
- `validar {mensaje_id, contrato?}` → `{clasificacion, id_contrato_existente?, requiere_revision[], diferencias?, advertencias[]}`; re-deriva del fixture por `mensaje_id`; `contrato` solo son overrides opcionales.
- `registrar {mensaje_id, contrato?, confirmado?, hoy?}` → `{id_contrato, accion, ruta_archivo}`; si `requiere_revision` no vacío y no `confirmado` → `{ok:false, error:"requiere revisión: valor, fecha_fin", revision:[{campo, valor_propuesto, confianza, motivo}]}`. Escribe CSV (atómico: tmp+rename), copia adjunto a `out/sharepoint/Contratos/<año_inicio>/<cliente-slug>/<id>.<ext>` (otrosí: `<id>-otrosi-<n>.<ext>`, nunca pisa el original), historial, `out/procesados.json`.
- `alertas {hoy}` → `{ruta, vencen[], vencidos[], polizas_pendientes[], registrados_desde_corte[]}`.
- Todas escriben `out/log.jsonl` `{ts,herramienta,mensaje_id,ok,resumen}` (sin datos sensibles). Args con `z.object().strict()`.
- cliente-slug: minúsculas, sin tildes, sin sufijo societario (S.A.S., S.A., S.A.C., S. de R.L.), `[a-z0-9-]`. Debe reproducir las 8 rutas del maestro (ej. `industrias-delta`, `agroexport-sula`, `corporacion-andina-de-servicios`).
- Seguridad mínima (tests): `extraer({mensaje_id:"../../.env"})`→ok:false; ruta final siempre dentro de `out/`; CSV con `=HYPERLINK("x","y")` y comas se relee igual; hash de `fixtures/` igual antes/después.

## 6. Agente — decisión vigente ADR-004

Node + LangGraph controla nodos modelo, herramienta, detección de revisión, interrupt, decisión y registro aprobado. LangChain ChatAnthropic devuelve un paso con texto, llamadas y uso conocido/desconocido, sin ejecutar herramientas. La UI presenta revisión y valores del backend; Command solo reanuda tras validar la decisión completa contra el snapshot y las huellas de fuente/maestro. Una regex afirmativa o un ID válido no bastan para autorizar texto ambiguo, exceptivo o con instrucciones adicionales: la gramática consume el mensaje completo.

MAX_STEPS cuenta llamadas al modelo; MAX_TOOL_CALLS limita herramientas; LLM_TIMEOUT_MS y LLM_MAX_OUTPUT_TOKENS acotan tiempo/salida; MAX_SESSION_TOKENS limita sesión. Fallos conservan resultados parciales y diferencian consumo desconocido. LangSmith externo permanece desactivado.

MemorySaver es solo para continuidad en proceso en A. B requiere checkpointer durable, identidad, transacciones/idempotencia, recuperación, restauración y reversión comprobadas. Rapidez y ahorro son hipótesis por medir. La decisión anterior de delegar el bucle al AI SDK y aceptar confirmaciones por regex queda sustituida (ADR-004).

## 7. API (contrato fijo para front y server)
- `POST /api/sessions` → `201 {sessionId}`; el cliente crea la sesión antes del primer envío.
- `POST /api/chat` `{sessionId?, message, requestId?}` (`requestId` UUID, exige `sessionId`; mismo id + mismo mensaje devuelve la respuesta guardada, otro mensaje → 409) → `{sessionId, reply, toolCalls:[{id,name,args,ok,resumen}], needsConfirmation: null | {mensaje_id, campos:[{campo,valor_propuesto,confianza,motivo}], pregunta, reviewId?, operationHash?}, usage:{steps,tokens,known?}}`. Error: `{error:{code,message}}`; en fallo parcial del grafo se incluyen sessionId, reply, toolCalls, needsConfirmation y usage recuperables.
- `GET /api/sessions/:id` → `{sessionId, messages:[{role,text,toolCalls?,ts}], pending: needsConfirmation|null, requests:[{requestId,status}]}` (404 si no existe; sessionId = UUID emitido por el servidor).
- `GET /api/health` → `{ok:true, provider, model, buildSha, persistence:"process", tracing:false}` (sin clave de acceso). Estáticos de `web/`.
- Front: `textContent` siempre (nunca innerHTML con datos), muestra cada tool call (nombre, args, resumen), panel ámbar cuando `needsConfirmation` con botones Aprobar/Rechazar que envían "confirmo …"/"rechazo …" por `/api/chat`.

## 8. Entregables mínimos (orden de prioridad)
1) repo con `node demo.ts` verde sin clave 2) chat funcionando 3) link público (`/api/health`) 4) README + SOLUCION.md (11 secciones del PRD §9.1: gobierno, supuestos, trade-offs) 5) bonus `modulo/` solo si sobra. Supuestos a declarar: la "rúbrica de la sección 10" no existe; `hoy` como argumento; firma msg-006 = fecha del correo; otrosí→póliza pendiente; vencidos en sección aparte; dedupe por NIT+objeto. Uso de IA a declarar: Claude Code (Haiku/Sonnet/Opus), Codex (migración LangGraph) y Gemini (su scaffold se descartó: `maxSteps`, `parameters`, flag `confirmado` del modelo, `z.any()`, historial en ruta equivocada).
