# REVISIÓN R2 — Documentación (solo lectura)

Revisado: SOLUCION.md, README.md, docs/PRODUCTO.md, docs/RUNBOOK.md, docs/adr/001-003, entrega/RESPUESTA.md, contra docs/PRD.md y el código del árbol de trabajo (sin commitear). Límite: `node --test` en mi sandbox da 23/36 por `listen EPERM` (no puede abrir puerto), así que NO verifiqué los conteos de tests.

**Veredicto:** la documentación es honesta (no declara Lovable/v0, ni RAG, ni USD, ni "producción real"). Hay **1 contradicción de fondo (conocimiento sin cablear)**, **2 inconsistencias numéricas** y varios textos que quedarán obsoletos al commitear. Cobertura de las 11 secciones del PRD §9.1 y de los 6 puntos de §7.5: completa. Sin placeholders (`<COSTO>`, `<URL…>`, "en construcción", TODO): grep limpio.

## P0 — corregir antes de enviar

**1. El conocimiento NO se carga en runtime y SOLUCION lo presenta como cargado.**
Evidencia: `buildSystemPrompt` (`src/agent/context.ts:24`) no tiene ningún llamador; `server.ts:75` usa `cargarPrompt()` (`src/agent/run.ts:14-20`) que solo lee `agent/prompt.md`. Tampoco lo carga `demo.ts`.
- SOLUCION §2 (diagrama línea 18: "conocimiento: src/knowledge/registro-contratos.md" dentro del bloque Agente) y §2 línea 28 ("Las reglas de negocio están en `src/knowledge/`") → falso mientras no se cablee.
- ADR-003 dice "decidida; en implementación… aún no lo carga" (honesto pero no apto para entregar), PRODUCTO.md:18 ídem ("lo señaló la auditoría").
- Propuesta (dos caminos): (a) cablear `cargarPrompt` → `buildSystemPrompt(process.cwd())` en `server.ts:75` + test, y entonces reescribir ADR-003 estado a "aceptada (implementada)" y PRODUCTO.md:18 a "Hecho: el documento (~5 KB) se inyecta completo en el system prompt (`src/agent/context.ts`)"; (b) si no se cablea: SOLUCION línea 18 → "conocimiento: `src/knowledge/registro-contratos.md` (documento de referencia; aún no inyectado en runtime)", y ADR-003 → "Estado: decidida, no implementada".
- Impacto en el cargo: es la respuesta a "RAG/conocimiento"; si el panel abre el repo y no ve el cableado, se pierde credibilidad. Además `modulo/skill/` se genera de este archivo.

**2. Conteo de tests inconsistente en 3 sitios.**
SOLUCION §9 línea 92: "33/33"; PRODUCTO.md:20: "20/20 tests en la auditoría"; entrega/RESPUESTA.md:15: "20 tests en verde"; `node --test` hoy reporta 36 (ver nota de sandbox). → Re-ejecutar fuera del sandbox y poner la misma cifra en los tres, con fecha: "`npm test`: N/N (fecha); `tsc --noEmit` limpio".

**3. RESPUESTA.md contiene la clave de acceso en claro** (`entrega/RESPUESTA.md:7`). Si va en el hilo de correo es la intención (README:9 dice "se entrega por el hilo"), pero asegurar que `entrega/` no entre al zip/repo público ni a GitHub (el zip actual `entrega/reto-02-aguilar.zip` está dentro de `entrega/`: verificar que no se auto-incluya ni lleve este archivo). Además RESPUESTA dice "Verificado: 20 tests" y "msg-006" — alinear con punto 2.

## P1 — afirmaciones inexactas o inflables

| # | Texto actual | Problema / evidencia | Propuesta |
|---|---|---|---|
| 4 | SOLUCION §11 abuso de costo: "`ACCESS_KEY` opcional" + README:9 "Clave de acceso: si el servidor tiene ACCESS_KEY…" | Coherente, pero RUNBOOK:3 y §11 no dicen si la instancia desplegada la tiene activa. Sin ACCESS_KEY el link público queda abierto al gasto y `/api/reset` da 403 (`server.ts:160`) | Una línea: "En el despliegue, `ACCESS_KEY` está activa (sí/no)". Si no está activa, RUNBOOK §1.2 (reset) no funciona y hay que decirlo |
| 5 | SOLUCION §4: "53.358 tokens por lote… (39.041 + 14.317)" | Bien matizado (una corrida, sin USD). ADR-001:25 lo repite como "(+) Medido" sin el matiz; PRODUCTO.md:57 dice "≈ 8.900 por correo, promedio de una corrida" (6 correos+confirmación: 53.358/6) | En ADR-001: "una sola corrida, sin desglose". Quitar "promedio" en PRODUCTO.md:57 → "≈ 8.900 por correo (derivado de una corrida)" |
| 6 | SOLUCION §4 / ADR-003 "Prompt caching: se evaluará" | Correcto (grep `cache_control|cacheControl` en `src/` = 0). ADR-003:11 "con cache de prompt si el proveedor lo permite" suena a diseño | Añadir "(no implementado)" en ADR-003:11 |
| 7 | SOLUCION §3: "tope de tokens… timeout de 60 s por llamada" | Verificado: `src/llm/anthropic.ts:26` `timeout:{totalMs:60_000}`; `run.ts:7-8` MAX_MENSAJE/MAX_PASOS; `server.ts:43,83` TTL 2 h/500 sesiones | OK, sin cambio |
| 8 | SOLUCION §5 "Determinista primero… regex" y §7 "Regex es auditable" | OK (`src/domain/extraccion.ts`). Pero "Fecha de firma 006 = fecha del correo, conf 0.8" no verificado línea a línea | Citar `extraccion.ts` línea de la regla o dejar como supuesto (ya está en §8) |
| 9 | SOLUCION §11 "Datos personales: minimizar logs; definir retención" y "Rotación de claves" | Mitigación declarada, no construida; correcto como "prevista". OK | — |
| 10 | SOLUCION §9 HU-6 "Verificado: …400/404 (tests)" | Plausible; no re-verificado por el EPERM | Confirmar al re-correr tests |
| 11 | PRODUCTO.md:16 "Hecho como demo desplegada" | Bien matizado (Render Free). RUNBOOK lo dice. SOLUCION no menciona Render Free ni disco efímero salvo ADR-002 | Añadir en SOLUCION §11 (fila escritura) o §9: "Despliegue: Render Free, disco efímero, se duerme por inactividad (RUNBOOK §1)" |

## P2 — obsolescencia al commitear / cosmética

12. PRODUCTO.md:21,99,109,130 dice "corregido en el árbol de trabajo… la auditoría se hizo sobre `b1dc41b`". Tras commitear será ruido. → "Corregido (commit `<hash>`); ver `entrega/AUDITORIA.md`". Es el único tipo de "referencia a pendiente" permitido: usar el hash real, no placeholder.
13. PRODUCTO.md:99 "Pendiente decidir qué P1 de la auditoría se cierran antes de la defensa" y :114 "verificar" → resolver o mover a backlog con estado final.
14. PRODUCTO.md:5/14 "lectura prevista 5 min" y 168 líneas: ok para el panel, pero §8 (plan de evaluación) y §4 (fórmula) son largos; si hay que recortar, §8 a 3 viñetas.
15. SOLUCION §6 punto 1: "Dirección a definir por Periferia" — es placeholder funcional aceptable pero PRD §7.5.1 pide "dirección del buzón". Poner un buzón ficticio explícito (`contratos@periferia.example`, marcado ficticio) para cumplir el punto literalmente.
16. SOLUCION §8 primera viñeta ("rúbrica de la sección 10 … no existe en el PRD") menciona fuentes internas (`plan/fuentes` está excluido del repo): el panel no sabe de qué fuente habla. → eliminar o reformular "El PRD no incluye rúbrica de evaluación; no se asumió ninguna".
17. SOLUCION §10: "Gemini se usó para una primera propuesta" — verificar que sea cierto (no hay evidencia en repo; es afirmación sobre proceso). Si fue así, dejar; si no, quitar. Las 10 filas "descartado de Gemini" son específicas y plausibles pero no comprobables: tratarlas como declaración del autor.
18. RUNBOOK:18 "Render Shell no existe en Free" y "Siguiente paso (no hecho)" — correcto y honesto; mantener.
19. README: correcto y mínimo (un comando, variables, demo, link, clave). `npm run dev` usa `--env-file-if-exists` (`package.json:9`) OK. Falta mencionar `docs/` (PRODUCTO, ADRs, RUNBOOK) en "Estructura" — es lo que un panel lee primero. → añadir línea: "`docs/`: PRODUCTO.md (estrategia, roadmap, backlog, caso de negocio, UX), `adr/` (decisiones), RUNBOOK.md (operación)". Añadir también enlace a PRODUCTO.md arriba del README.
20. SOLUCION no enlaza a PRODUCTO/ADRs/RUNBOOK: el panel que abre solo SOLUCION no ve estrategia/roadmap. → una línea tras el título: "Estrategia de producto, roadmap, backlog y caso de negocio: `docs/PRODUCTO.md`. Decisiones: `docs/adr/`. Operación: `docs/RUNBOOK.md`."

## (3) Cobertura del cargo

| Requisito | ¿Visible? | Dónde | Falta / sobra |
|---|---|---|---|
| Estrategia de producto | Sí | PRODUCTO §2-§3 | Honesto: JTBD "sin entrevistas" |
| Roadmap / backlog | Sí | PRODUCTO §5 (ahora/siguiente/después + MoSCoW 12 ítems) | OK |
| Caso de negocio | Sí, como modelo | PRODUCTO §4 | Sin cifras (bien). Panel puede pedir un ejemplo numérico ilustrativo marcado "ilustrativo": opcional |
| UX | Sí | PRODUCTO §6, `web/index.html` | Declara "no validado con usuarias" (bien) |
| Lovable/v0 | Declarado NO usado | PRODUCTO:9,26,136 | Correcto; no inflar |
| Tool calling | Sí | SOLUCION §2-3, ADR-001, `src/tools/contratos.ts` | OK |
| RAG | Justificación | ADR-003 + PRODUCTO:18,120 | Bien, pero depende del P0-1 (cablear conocimiento) |
| Multidisciplinario | Propuesta | PRODUCTO §7 RACI + SOLUCION §6 | Declara "no hubo equipo real" (bien) |
| Evidencia de producción | Parcial, bien matizada | RUNBOOK, PRODUCTO:16,28, entrega/AUDITORIA.md | Falta en SOLUCION una línea de Render Free/efímero (ítem 11). Sobra poco: la auditoría y 3 ADRs bastan |
| Evals / gobierno de modelo | Plan | PRODUCTO §8 | Declarado "no hay evals en CI" (bien) |

Sobra: nada relevante; el riesgo es exceso (≈ 50 KB entre docs). Para 10 min: SOLUCION (15 KB) + PRODUCTO (≈ 12 KB) son el núcleo; ADRs/RUNBOOK son de consulta.

## (4) Referentes (SOLUCION §10)

Todos existen y los autores/títulos son correctos: Anthropic "Building effective agents" (2024); Yao et al. "ReAct" (2022); OWASP Top 10 for LLM Applications; Chip Huyen "AI Engineering" (O'Reilly, 2025); R. C. Martin "Clean Architecture"; Cockburn "Hexagonal architecture"; Fowler "PoEAA"; Richardson "Microservices Patterns"; Nygard "Release It!". Curso DevTalles agentic-patterns: no verificable desde el repo (labs 01/03/04/05/11 citados en ADR-001).
Uso real en el repo: ReAct/tope 25 (`anthropic.ts:25`, `run.ts:7`), adapter (`src/llm/adapter.ts`), capas domain/infra (existen), CSV-injection/OWASP (`csv.ts:2`), timeouts/rate limit (Nygard). **Débil:** Chip Huyen ("medición de tokens y decisión de modelo") y PoEAA/"Repository, Value Objects" (ADR-002 menciona Repository para el maestro: `src/infra/maestro.ts` existe, `Dinero` en `domain/dinero.ts`: OK). "Circuit breaker" (ADR-002:14) es generoso: son topes, no un circuit breaker con estados → cambiar a "topes y timeouts (inspirados en Nygard)". Richardson/Fowler "Saga/Outbox/CQRS" aparecen solo como descartados: bien. Sugerencia: reducir la tabla a los 5-6 referentes realmente usados (Anthropic, ReAct, OWASP, Hexagonal, Nygard, DevTalles) para legibilidad.

## (5) Tono y extensión

Sobrio, en español, sin superlativos ni marketing. SOLUCION §7 (tabla) y §10 son densas pero escaneables. SOLUCION §3 línea 36 es un párrafo de ~150 palabras: partirlo en 3 viñetas (gate, override, rechazos). Legible en 10 min si se prioriza SOLUCION + PRODUCTO §1,§5.

## Lista priorizada de cambios mínimos
1. Cablear `buildSystemPrompt` o corregir SOLUCION línea 18/28 + ADR-003 + PRODUCTO:18 (P0-1).
2. Unificar conteo de tests (SOLUCION:92, PRODUCTO:20, RESPUESTA:15) tras `npm test` fuera de sandbox.
3. Revisar RESPUESTA.md y zip: clave solo en el correo, no en repo/zip.
4. Enlaces cruzados en README y SOLUCION a `docs/` (ítems 19-20).
5. Línea Render Free / disco efímero en SOLUCION (11) y estado de `ACCESS_KEY` desplegado (4).
6. Buzón ficticio explícito en gobierno §6.1 (15); quitar "rúbrica sección 10" (16).
7. "Circuit breaker" → "topes y timeouts"; ADR-003 "(no implementado)" en caché; ADR-001 matiz de una corrida (5, 6).
8. Tras commitear: reemplazar "árbol de trabajo" por hash (12, 13).
