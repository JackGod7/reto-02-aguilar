# AGENTS.md

Las instrucciones del proyecto están en `CLAUDE.md` (válidas para cualquier agente). El estado y los pendientes viven en notas locales no versionadas, si existen.

## Cómo trabajar (método usado hasta ahora)

1. **Planear antes de tocar código**: tomar un pendiente, citar el punto del PRD que cubre y definir "hecho" (test que lo prueba).
2. **Dividir y paralelizar**: separar el trabajo en tareas independientes que no toquen los mismos archivos; cada una en su propio agente/sesión/worktree con un brief corto (archivos, criterio de hecho). Lo que depende de otra tarea va después.
3. **Revisión adversarial**: cada cambio lo revisa otro agente (idealmente un modelo más fuerte) cuyo objetivo es romperlo: bypass del gate HITL, `execute` que lanza, valores inventados, regresiones del PRD. Solo sobrevive lo que el revisor no logra refutar.
4. **Verificación por puntos del PRD**: al cerrar un bloque, un agente por sección del PRD responde CUMPLE / PARCIAL / NO CUMPLE con evidencia `archivo:línea`; se corrigen los NO CUMPLE primero.
5. **Puertas antes de cada commit**: `npx tsc --noEmit` limpio, `node --test 'tests/**/*.test.ts'` en verde, `node demo.ts` dos veces idéntico (borrando `out/`), fixtures sin cambios, sin claves en el diff.
6. **Commits atómicos y TBD**: un commit por cambio lógico, mensaje convencional, sin atribución a asistentes; push a `main` (Render despliega) y comprobar `/api/health`.
7. **Sin sobreingeniería**: si un pendiente no mejora lo que el evaluador ve o un criterio del PRD, se documenta como roadmap en vez de construirse.
8. **Coordinador que solo orquesta**: verificaciones, escaneos y ediciones van a sesiones o agentes aparte, en archivos disjuntos.
9. **"El mejor código es el que no se escribe"**: borrar antes de escribir; cada archivo y dependencia responde a un requisito del PRD.
10. **Patrones de LangGraph**: grafo compilado una sola vez, `thread_id` = sessionId, nodos y routers con nombre.
11. **Pruebas atómicas por criterio del PRD** (épica → HU → criterio), escritas como escenarios Gherkin en español, sin Cucumber.
12. **Evals con el modelo real** y graders deterministas; los fallos se reportan, no se maquillan.
13. **Red team**: al menos un caso adversarial por patrón de seguridad.

## Puertas antes de push

`npx tsc --noEmit` · `node --test 'tests/**/*.test.ts'` · `node scripts/verificar-entrega.ts` · knip con entradas de producción (`src/server.ts`, `demo.ts`, `scripts/*.ts`) y 0 hallazgos (`npx -y knip@latest`) · escaneo de secretos y de rutas `/Users/` en el diff. Commits sin atribución.

## Evals

TODO: documentar `npm run evals`, `--only HU-x`, `--model`, `evals/MATRIZ.md` y `evals/redteam-jailbreak.md` cuando se integren las ramas `evals-reales` y `redteam` (aún no integradas).

## Continuidad entre clientes

Estado y decisiones viven en archivos y Git; los nombres de agentes anteriores no son handles portables entre herramientas.
