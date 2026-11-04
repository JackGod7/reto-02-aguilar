# ADR-003 — Conocimiento del proceso en el contexto vs RAG vectorial

**Estado:** aceptada e implementada. `src/agent/context.ts` (`buildSystemPrompt`) une `agent/prompt.md` y `src/knowledge/registro-contratos.md` (~5 KB) en el system prompt; `src/server.ts` lo usa al arrancar. Test: `tests/core/context.test.ts`.

## Contexto
El agente necesita conocer el proceso de registro (reglas, campos, criterios de revisión, excepciones). El corpus actual es de ~1 página.

## Decisión
**Inyectar el documento completo en el contexto del agente** (system prompt o mensaje fijo, con cache de prompt si el proveedor lo permite). No usar embeddings ni índice vectorial.
Las reglas que *deben* cumplirse (umbral 0.8, RN1–RN4) siguen en código; el documento da contexto al modelo, no autoridad.

## Alternativas descartadas
| Alternativa | Razón de hoy |
|---|---|
| RAG vectorial (embeddings + índice) | Con ~5 KB cabe entero en el contexto. RAG añade infraestructura, un modelo de embeddings, chunking y riesgo de recuperar el fragmento equivocado. |
| Fine-tuning | Costo y mantenimiento desproporcionados para una página de reglas. |
| Solo en el prompt, sin archivo | Mezcla comportamiento con reglas de negocio; el archivo se versiona y revisa aparte. |

Razones: tamaño (el corpus completo son pocos miles de tokens), determinismo (el agente ve siempre el mismo texto), costo (sin embeddings ni almacén) e infraestructura cero (Render Free).

## Consecuencias
- (+) Simple, reproducible, fácil de auditar con un diff.
- (−) Cada llamada paga esos tokens; mitigable con cache de prompt (hipótesis, sin medir).
- **Disparadores para migrar a RAG** (umbrales a calibrar, no medidos): corpus de más de ~N páginas que ya no quepa cómodo en el contexto (N depende del modelo y del costo aceptado); varios procesos con documentos distintos donde cargar todo diluya la atención; necesidad de consultar contratos históricos o cláusulas. Al migrar, medir antes y después con los casos del fixture.
