# SOLUCION — Registro de Contratos Vigentes

Estrategia de producto, roadmap, backlog y caso de negocio: [`docs/PRODUCTO.md`](docs/PRODUCTO.md). Decisiones de arquitectura: [`docs/adr/`](docs/adr/). Operación: [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

Versión actual: Node + LangGraph + LangChain (la primera entrega con Vercel AI SDK queda en el tag `entrega-2026-11-03`). Verificación: `npx tsc --noEmit` limpio, suite completa de `node --test` en verde y `node scripts/verificar-entrega.ts` en verde. Es una demo sobre fixtures; no está preparada para datos reales (ver §9).

## 1. Problema

El maestro de contratos vigentes está congelado desde el corte de 2026-05-30: los contratos nuevos no se registran y no se sabe qué vence ni qué pólizas faltan. Le duele a la analista administrativa, dueña del maestro, y a gerencia, que no tiene visibilidad de vencimientos ni de garantías pendientes.

## 2. Arquitectura

```
Navegador (web/)
   │  POST /api/sessions · POST /api/chat · GET /api/sessions/:id · POST /api/reset · GET /api/health
   ▼
Servidor node:http (src/server.ts)
   │  rate limit · ACCESS_KEY · tamaños · sesiones y requestId en memoria · topes de tokens
   ▼
Agente (src/agent/)  ── system prompt: agent/prompt.md
   │  LangGraph: modelo → herramienta → revisión → interrupt → Command
   │  LangChain: una llamada al proveedor por paso · topes de pasos/tokens/tiempo
   │  conocimiento inyectado en el system prompt: src/knowledge/registro-contratos.md
   ▼
Herramientas contratos_* (src/tools/contratos.ts)
   │  leer_buzon · extraer · validar · registrar · alertas
   ▼
Dominio e infraestructura (src/domain/, src/infra/)
   ├── lectura: fixtures/reto-02/ (solo lectura)
   └── escritura: out/ (maestro CSV, archivos de contratos, historial, procesados, log, alertas)
```

- **Dónde vive cada cosa**: el comportamiento del agente está en `agent/prompt.md`. Las reglas de negocio están en `src/knowledge/` (el documento completo, ~5 KB, se inyecta en el system prompt al arrancar con `src/agent/context.ts`; ADR-003) y, como código, en `src/domain/`. La ejecución está en `src/tools/`.
- **Proveedor**: interfaz propia en `src/llm/adapter.ts`, con implementación LangChain ChatAnthropic. Cambiar de proveedor conserva las herramientas, pero requiere un adaptador y pruebas de compatibilidad.
- **Herramientas por `mensaje_id`**: el modelo elige *qué* mensaje procesar; los valores los leen las herramientas del fixture. El modelo no puede inventar un valor registrable.

## 3. Ciclo del agente

El motor LangGraph controla nodos separados de modelo, herramienta, detección de revisión, espera humana y registro aprobado. El proveedor LangChain devuelve solicitudes y consumo por una sola llamada: no ejecuta herramientas. Un interrupt pausa la cola antes de la siguiente herramienta; la reanudación usa Command tras verificar la decisión humana contra la propuesta exacta. Una bandera confirmado generada por el modelo no autoriza el registro.

El estado del grafo conserva cola, mensajes modelo/herramientas y revisión por sesión. Los checkpoints MemorySaver bastan para la demo en un proceso; no sobreviven a reinicios. La decisión humana se interpreta en código contra la revisión mostrada (botones `confirmo/rechazo revisión <reviewId>` o el ejemplo textual del PRD para 006); un mensaje con condiciones o excepciones no autoriza el registro y pide aclaración (`tests/agent/hitl-adversarial.test.ts`). Si el proveedor falla, la respuesta 502 incluye las llamadas, la revisión y el uso conocidos; el cliente reintenta con el mismo `requestId` sin repetir efectos (`tests/agent/recovery-*.test.ts`).

MAX_STEPS (llamadas al modelo, 25), MAX_TOOL_CALLS (100), LLM_TIMEOUT_MS (60 s), LLM_MAX_OUTPUT_TOKENS (4096), MAX_SESSION_TOKENS (200.000) y MAX_DAILY_TOKENS (2.000.000) limitan la ejecución; el servidor reserva presupuesto antes de cada turno y trata el uso desconocido como consumido. Las trazas LangSmith están deshabilitadas por invocación. Motivación y alternativas: ADR-004.

## 4. Elección del modelo

El coste por caso de la versión LangGraph no se ha medido todavía; la única cifra disponible es de la primera entrega.

- **Proveedor y modelo**: Anthropic, `claude-haiku-5-5` por defecto, configurable con `LLM_MODEL`. El modelo solo conduce la conversación y elige herramientas (los valores salen de código), así que un modelo pequeño y barato basta; no se ha comparado con otros. `/api/health` muestra el modelo efectivo.
- **Referencia (versión AI SDK, 2026-11-03)**: 53.358 tokens por lote completo (39.041 + 14.317; seis correos y confirmación). Sin desglose entrada/salida/caché no se convierte a USD.
- **Cómo medirlo**: cada turno escribe en `out/turnos.jsonl` SHA, modelo, latencia, pasos y tokens (sin contenido). Coste por correo = gasto del periodo / correos recibidos; coste por operación = gasto / altas y actualizaciones completadas.
- **Dependencias** (exactas): `@langchain/langgraph` (estado y orquestación), `@langchain/core` (mensajes y contratos), `@langchain/anthropic` (proveedor), `langsmith` (control explícito de trazas; envío desactivado), `zod` (validación de argumentos de herramientas), `typescript` y `@types/node` (solo typecheck). Nada más.
- **Prompt caching**: no implementado (sin `cache_control` en `src/`). Se evaluaría sobre el system prompt si el costo medido lo justifica.

## 5. Estrategia de extracción

- **Determinista primero**: expresiones regulares por cláusula (partes, OBJETO, VALOR, PLAZO, GARANTÍAS) y el bloque de "Entre …" para identificar a la parte que no es Periferia.
- **Partes**: Periferia se reconoce por su NIT. El cliente es la otra parte. El país sale del identificador o del domicilio del cliente, nunca del domicilio de Periferia.
- **Valor**: se toma del importe numérico de la cláusula VALOR, con moneda y separadores normalizados. No se implementa una conversión general de cantidades escritas en letras. Valor por demanda se propone como 0 con confianza 0.5; una ausencia real conserva confianza 0 y sale como `null`.
- **Fechas y plazo**: fechas por el número entre paréntesis ("primero (1) de agosto de 2026"). Plazo en meses sin fechas: fin = inicio + N meses.
- **Póliza**: GARANTÍAS define requisito y tipo; un alta con póliza queda pendiente. Un reenvío no degrada una póliza vigente por el valor pendiente derivado del extractor. El otrosí del fixture exige ampliarla y aporta la evidencia para cambiar a pendiente. No hay fechas de vencimiento de pólizas ni verificación automática de firmas.
- **Confianza**: 1.0 explícito · 0.8 inferido acotado · 0.6 calculado · 0.5 indeterminado · 0 ausente (`null`). Un campo con confianza menor que 0.8 entra en `requiere_revision`.
- **Dónde entra el modelo**: explica al usuario lo extraído y conduce la conversación. No decide valores ni confianzas. Los valores registrables salen de las herramientas.

## 6. Regla de gobierno

Propuesta de una página para validar con la organización (roadmap §9, paso 1); los plazos son propuestas, no mediciones. En A no se conectan buzones reales, envían acuses ni ejecuta la campaña:

1. **Canal y responsabilidad**: buzón propuesto `contratos@periferia.example`, dirección ficticia que sustituirá la organización. La analista administrativa administra el buzón y es dueña propuesta del maestro; se designa un suplente con acceso y procedimiento de relevo probado. TI mantiene permisos e integración y gerencia responde por cumplimiento y escalamiento. Los comerciales remiten documentos sin necesitar acceso al chat.
2. **Envío completo**: cada comercial envía contratos con y sin póliza, PDF firmado con texto, otrosíes y actas de terminación dentro de un plazo propuesto de 3 días hábiles desde la firma. Asunto: `[CONTRATO|OTROSÍ|TERMINACIÓN] <cliente> - <id>`; indicar NIT/RUC, responsable y contrato relacionado. Si falta id o texto legible, declararlo para revisión sin inventar datos. Conservar original y sus documentos posteriores.
3. **Acuse y estados**: proponer acuse de recepción en 15 minutos con identificador de recepción, documentos recibidos y faltantes. «Recibido» no significa «registrado». Tras validar y, si corresponde, obtener la decisión exacta de la analista, comunicar registro, actualización, duplicado o revisión pendiente con su id y motivo. Un fallo conserva el estado de pendiente y nunca se acusa como registro exitoso. Destinatarios, contenido y permiso de envío se acuerdan antes de habilitar mensajes externos.
4. **Excepciones y escalamiento**: la analista o su suplente solicita la versión firmada/legible cuando falte; no se simula verificación jurídica ni de firma. Valor por demanda, ausencia de valor/plazo y conflicto de identidad pasan a revisión con campos, fuente y propuesta exactos; una confirmación no inventa un dato ausente. Si no se resuelve con el comercial en un plazo propuesto de 5 días hábiles, escalar al responsable comercial designado y gerencia. Asignar responsable, fecha de seguimiento y evidencia de cierre a cada excepción y alerta de póliza.
5. **Campaña junio–agosto 2026**: proponer dos semanas con una lista de contratos por comercial desde el corte 2026-05-30. Facturación aporta el universo de contratos únicos identificables para la misma cohorte y corte; conciliar contra el maestro y los originales, solicitar faltantes con y sin póliza y conservar otrosíes/actas e historial. Facturas sin vínculo identificable quedan en lista de conciliación con responsable, sin excluirlas silenciosamente. La analista y el suplente verifican el cierre con comercial y gerencia; conservar fecha real de registro y procedencia, sin fingir reconstrucción ya ejecutada.
6. **Indicador mensual**: contratos únicos identificables en facturación con registro válido en el maestro / contratos únicos identificables en facturación, para la misma cohorte y corte. Reportar también los no identificables, las excepciones y el tiempo firma→recepción→registro. Ni clientes ni correos sustituyen al denominador de contratos. No hay línea base ni meta aprobada: fijarla después de conciliar. Gerencia revisa el indicador y el seguimiento de faltantes/pólizas con responsable y suplente.

## 7. Decisiones y trade-offs

| Decisión | Elegido | Alternativa descartada | Por qué |
|---|---|---|---|
| Patrón del agente | Un agente con ciclo acotado y transiciones explícitas LangGraph | Plan-and-Execute | La siguiente acción depende del resultado de `validar`; el grafo puede suspender antes del siguiente efecto para obtener la decisión humana. |
| Qué recibe la herramienta | `mensaje_id`; la herramienta relee el dato del fixture | Pasar el objeto contrato completo desde el modelo | Impide que el modelo invente o redondee un valor. El costo es que el modelo solo opera sobre mensajes existentes. |
| Quién autoriza el registro | Backend: revisión expuesta, operación y valores exactos, huella de fuente/maestro y decisión completa de la persona | Flag `confirmado` decidido por el modelo | El identificador correcto no autoriza texto condicionado o exceptivo; si cambian la fuente o el maestro la aprobación caduca. Probado con el grafo real y proveedor simulado (`tests/agent/hitl-adversarial.test.ts`, `tests/core/gate-adversarial.test.ts`). |
| Código interno en español | Nombres de dominio del PRD (lenguaje ubicuo) | Código en inglés | Coincide con el PRD y los fixtures. Inglés queda como roadmap. |
| Extracción de valores | Regex por cláusula | Extracción completa con LLM | Los valores son el dato crítico. Regex es auditable y reproducible; el LLM queda para explicar y conversar. |
| Framework | LangGraph + LangChain + zod | Mantener el bucle propio sobre AI SDK | La pausa y reanudación requieren estado explícito. Se acepta la dependencia para aprovechar checkpoints e interrupts; la autorización e integridad siguen siendo reglas propias. ADR-004. |
| Almacenamiento A | Maestro CSV y archivos en `out/`; rename atómico de cada CSV | Base de datos en esta entrega | Conserva el contrato del reto. No hay transacción conjunta con archivo/historial/procesados. B acuerda autoridad del maestro y prueba transacciones, recuperación y concurrencia. |

## 8. Supuestos

- El PRD no incluye una rúbrica de evaluación; no se asumió ninguna.
- `hoy` es un argumento de la herramienta de alertas, no la fecha del sistema, para que la demo sea reproducible. Se pasa en la demo como `2026-09-03`.
- El inicio propuesto de 006 se infiere de la fecha del correo, con confianza 0.8; no se afirma que esa sea una firma verificada.
- La póliza condicional del mensaje 006 se trata como de cumplimiento; es un supuesto documentado.
- Un otrosí que amplía la póliza deja `estado_poliza = pendiente`.
- Los vencidos van en una sección aparte del reporte de alertas.
- La deduplicación usa NIT + objeto, no solo NIT.
- RN1 tiene prioridad cuando id, valor y fechas coinciden; metadatos solos no actualizan. Un otrosí sin cambios efectivos se trata como duplicado. NIT+objeto≥0.9 con otro id pide decidir explícitamente el destino; una moneda distinta se muestra para revisión en vez de descartarse. Son interpretaciones conservadoras de la ambigüedad RN1/RN2 (`tests/core/clasificacion*.test.ts`).
- Sin id se propone `AUTO-<año>-<secuencia>` para aprobación explícita. La generación depende del maestro; las colisiones se bloquean para corregir identidad. No es una identidad durable de documentos ni una garantía de idempotencia ante reinicios.
- A usa `contrato.txt`/`otrosi.txt` y copia el adjunto disponible; no lee PDF binario. El PDF con texto y procedencia se incorpora en B; escaneados/ilegibles se derivan a atención manual. OCR queda diferido.

## 9. Cobertura

Los seis fixtures del PRD producen el resultado esperado de `plan/SPEC.md` §4, tanto por el chat (proveedor simulado) como en `node demo.ts`. El bonus `modulo/` reexporta las mismas tools y se genera desde prompt y conocimiento (`npm run build:modulo`); depende de `src/`, no es una carpeta autosuficiente. `contratos_leer_pdf` (P1) no está implementada.

| HU | Historia | Estado | Evidencia | Qué falta para producción |
|---|---|---|---|---|
| HU-1 | Leer el buzón | Cumple (fixtures) | `tests/core/tools.test.ts` | Ingesta real autorizada y originales durables |
| HU-2 | Extraer datos con confianza | Cumple (fixtures) | `tests/core/extraccion-prd.test.ts`, `dominio.test.ts` | PDF con procedencia, corpus representativo, cola manual para ilegibles |
| HU-3 | Validar y clasificar | Cumple (fixtures) | `tests/core/clasificacion*.test.ts` | Identidad contractual, conciliación y evals de falsos limpios |
| HU-4 | Registrar y archivar | Cumple (fixtures) | `tests/core/gate-adversarial.test.ts`, `tests/agent/hitl-adversarial.test.ts`, `confirmacion.test.ts` | Transacción conjunta, identidad de quien aprueba, recuperación |
| HU-5 | Alertar | Cumple (fixtures) | `tests/core/tools.test.ts`, `tests/agent/integracion.test.ts` | Responsable y seguimiento por alerta; fechas de póliza si se requieren |
| HU-6 | Manejo de errores | Cumple (proveedor simulado) | `tests/agent/recovery-*.test.ts`, `server-hardening.test.ts`, `tope.test.ts` | Monitoreo, límites durables y soporte operativo |

### Roadmap: piloto con datos reales (etapa B)

La demo no se usa con datos reales hasta cumplir, en este orden, y con prueba de cada punto:

1. **Acuerdo operativo**: dueña del maestro y suplente, autoridad (Excel o BD), volumen, presupuesto, retención y objetivos de recuperación validados con la organización (§6).
2. **Persistencia e identidad**: checkpointer durable de LangGraph, sesiones y revisiones en BD; login corporativo y permisos por rol (analista aprueba, gerencia lee).
3. **Integridad**: contrato, historial, aprobación y archivo en una transacción con clave de idempotencia; exportación a SharePoint por outbox reconciliable.
4. **Ingesta**: buzón real vía Graph y PDF con texto y procedencia por campo; escaneados a cola manual.
5. **Operación**: límites de gasto persistentes, logs estructurados y alertas; backup restaurado en un ensayo y reversión de despliegue probada.
6. **Evaluación**: modo shadow sobre corpus autorizado comparado con el registro humano (precisión por campo, falsos limpios, minutos humanos y coste por operación) antes de habilitar escrituras asistidas.

## 10. Uso de IA

**Asistentes usados para construir**: Claude Code (modelos Haiku, Sonnet y Opus, según la tarea) para el scaffold, el núcleo de dominio, el agente, la interfaz, la documentación y la revisión final. Gemini se usó para una primera propuesta de arquitectura.

Codex (OpenAI) hizo la migración a LangGraph + LangChain, las reglas de clasificación conservadoras y las pruebas adversariales; Claude Code revisó y sincronizó la documentación. La tabla siguiente corresponde a la primera entrega (AI SDK): las firmas `stopWhen`/`inputSchema` ya no aplican al adaptador LangChain actual, pero las decisiones de fondo se mantienen.

**Lo que se descartó de Gemini y por qué**:

| Propuesta | Evidencia | Decisión |
|---|---|---|
| `generateText` con `maxSteps` | Versión actual del AI SDK usa `stopWhen` | Se usa `stopWhen: stepCountIs(n)` |
| Herramientas con `parameters` | Versión actual usa `inputSchema` | Se usa `inputSchema` |
| Confirmación con flag `confirmado` decidido por el modelo | El agente propone; no autoriza | Gate en código |
| Router como agente que delega | Un router clasifica una vez y se retira | Router por reglas RN1–RN4, sin LLM |
| `contrato: z.any()` | El PRD pide TypeScript sin `any` | Esquema zod `Contrato` |
| Historial en `out/historial.jsonl` | El PRD pide `out/sharepoint/historial.jsonl` | Ruta del PRD |
| Remitente no registrado bloquea | El PRD dice que se reporta pero no bloquea | Advertencia |
| "Periferia es siempre el contratista" | Cierto en los fixtures, frágil como regla | Se identifica por NIT propio |
| Trade-offs en "sección 6" | El PRD los pone en la sección 7 | Numeración del PRD |
| `modulo/` como copia del código | El PRD pide no tener copias divergentes | Generado desde las mismas fuentes con `npm run build:modulo` (bonus hecho) |

**Verificación**: las firmas se contrastan con las versiones exactas instaladas (`package.json`) y con pruebas; cada cambio lo revisa otro agente que intenta romperlo (bypass del gate, valores inventados, regresiones del PRD).

### Referentes

Sin citas textuales ni URLs.

| Referente | Dónde se ve en el repo |
|---|---|
| Curso DevTalles agentic-patterns. Labs usados: tool use, ReAct, chaining/gates, HITL. Descartados: plan-and-execute, CodeAct, orchestrator/parallel | Tool use en `src/tools/contratos.ts`; ReAct acotado en `src/agent/graph.ts`; gate y HITL por código (§3, §7) |
| Anthropic, "Building effective agents" (2024) | Agente simple con herramientas y gate antes que framework multiagente (§7) |
| Yao et al., "ReAct" (2022) | Bucle observar/actuar con tope de 25 pasos (§3) |
| OWASP Top 10 for LLM Applications | Prompt injection tratada como dato, sin herramientas de borrado ni shell, topes de costo (§11) |
| Cockburn, Hexagonal | Adaptador de proveedor en `src/llm/adapter.ts`; herramientas como puertos |
| Nygard, Release It! | Topes y timeouts inspirados en su enfoque de estabilidad: pasos, tokens, rate limit, `/api/health`, degradación de errores (§3, §11) |

## 11. Riesgos en producción

| Riesgo | Mitigación prevista |
|---|---|
| Prompt injection desde correos o contratos | El contenido se trata como dato. Los valores y el gate están en código. No hay herramientas de borrado ni de shell. |
| Fuga de la clave de proveedor | Errores redactados, `.env` fuera de la imagen, `/api/health` sin secretos. |
| Abuso de coste del link | Pasos, herramientas, salida, tiempo, tokens por sesión/día y reservas concurrentes en el proceso; consumo desconocido se señala y reserva conservadoramente. `ACCESS_KEY` y rate limit acotan la demo; comprobar también presupuesto en el proveedor. B exige límites persistentes y concurrencia probados. |
| Despliegue de demo | Render Free: disco efímero (el estado se pierde al reiniciar) y se duerme por inactividad. Es una demo, no producción; ver `docs/RUNBOOK.md`. En producción: base de datos y sesiones fuera de memoria. |
| Escritura concurrente o fallo entre artefactos | Rename atómico del CSV no hace atómicos contrato, archivo, historial y procesados. En B acordar autoridad y probar transacción, idempotencia y recuperación; si Excel sigue como autoridad, exigir escritor único, versiones y reconciliación antes de habilitarlo. |
| Path traversal o CSV injection | Identificadores validados con regex, rutas dentro de `out/`, prefijo `'` en celdas que empiezan con `= + - @`. |
| Colisión o identidad contractual ambigua | Comparación por id y NIT+objeto≥0.9, revisión de cliente/NIT/objeto incompatible, destino explícito y bloqueo de candidatos múltiples. Son reglas de fixtures, no una precisión real acreditada. |
| Escaneados o documentos ilegibles | Cola manual en el piloto inicial; OCR requiere experimento separado autorizado. |
| El modelo redondea un valor o infiere una fecha | El valor registrado sale de la herramienta; el modelo solo propone y la persona confirma. |
| Pregunta abierta: dueño del maestro sin área legal | Queda fijado en la regla de gobierno (§6): la analista administrativa. |
| Datos personales en correos y contratos | Minimizar lo que se guarda en logs; definir retención. |
| Coste del modelo | Topes por turno, sesión y día; medir con `out/turnos.jsonl` antes de estimar coste por operación. |
| Rotación de claves | Clave en variable de entorno del proveedor de hosting; rotación periódica. |
