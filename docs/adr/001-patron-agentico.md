# ADR-001 — Patrón agéntico: ReAct acotado + gate HITL en código

**Estado:** el patrón (ReAct acotado + gate HITL en código) sigue vigente. El motor y la confirmación se sustituyen en [ADR-004](004-langgraph-orquestacion.md): LangGraph con interrupt/Command, y la decisión humana se valida con gramática completa contra el snapshot de la revisión en vez de detectar «confirmo» en el texto. El texto siguiente describe la primera entrega (AI SDK).

## Contexto
Hay que registrar contratos desde correos. La siguiente acción depende de lo observado (¿hay campos con confianza < 0.8? ¿remitente no registrado? ¿duplicado?), y un valor mal registrado en el maestro es costoso. Restricción: ventana de 2 h, sin shell para el modelo.

## Decisión
Un solo agente **ReAct acotado** (Vercel AI SDK, `stopWhen: stepCountIs(25)`) con 5 tools `contratos_*` (zod) y estas reglas:
- Las tools se direccionan por `mensaje_id`: el modelo elige *qué* mensaje, no *qué valor*; la extracción es determinista, con confianza por campo.
- **Gate HITL en código**: `contratos_registrar` se detiene si hay campos bajo el umbral 0.8 y devuelve `revision[]`; solo pasa con `confirmado: true` si esa revisión (mismo `mensaje_id`) la persona la vio en un turno previo y confirma en su último mensaje; con varias pendientes, el texto nombra el `mensaje_id`. El override `contrato` se limita a campos en revisión. El modelo no puede auto-aprobarse. Tests: `tests/core/gate-adversarial.test.ts`.
- **Gates deterministas** (RN1–RN4, umbral): `contratos_validar` actúa como juez programático.

Labs DevTalles usados: 01 (tool use, tope de pasos), 03 (juez programático), 04 (ReAct), 05 (gate de código: "garantiza, no mejora"), 11 (HITL: importa *cuándo* pausar).

## Alternativas descartadas
| Alternativa | Razón |
|---|---|
| 06 Plan-and-Execute | `registrar` depende del resultado de `validar`; un plan fijo es ciego a lo observado. |
| 07 CodeAct | Ejecutar código generado sin aislamiento es riesgo de RCE; fuera de alcance. |
| 08 Router con LLM | El enrutado (RN1–RN4) son reglas de negocio: se hacen con código, sin costo ni varianza. |
| 09 Orchestrator / 10 Parallel | Más tokens y complejidad sin un especialista que lo justifique. Las tool calls paralelas dentro de un paso sí caben. |
| Confirmación solo en el prompt | Un prompt no garantiza nada; el gate debe ser código. |

## Consecuencias
- (+) Comportamiento auditable; el peor caso lo acotan los topes (25 pasos, tokens por sesión).
- (+) Medido en una sola corrida real, sin desglose entrada/salida: 53.358 tokens por lote de 6 correos (Haiku 5.5, 2026-11-03).
- (−) La confirmación se detecta por texto ("confirmo", "sí"): es una heurística, no un evento explícito.
- (−) Un agente único: si crecen los tipos de documento, habrá que revisar este ADR.
- **Resuelto en ADR-004:** la pausa es un interrupt de LangGraph y la aprobación es un evento explícito (`confirmo revisión <reviewId>`).
