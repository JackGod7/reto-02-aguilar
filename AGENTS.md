# AGENTS.md

Las instrucciones del proyecto están en `CLAUDE.md` (válidas para cualquier agente). Si existe `plan/CONTINUAR.md` (local, no versionado), léelo para el estado y los pendientes.

## Cómo trabajar (método usado hasta ahora)

1. **Planear antes de tocar código**: tomar un pendiente de `plan/CONTINUAR.md`, citar el punto del PRD que cubre y definir "hecho" (test que lo prueba).
2. **Dividir y paralelizar**: separar el trabajo en tareas independientes que no toquen los mismos archivos; cada una en su propio agente/sesión/worktree con un brief corto (archivos, criterio de hecho). Lo que depende de otra tarea va después.
3. **Revisión adversarial**: cada cambio lo revisa otro agente (idealmente un modelo más fuerte) cuyo objetivo es romperlo: bypass del gate HITL, `execute` que lanza, valores inventados, regresiones del PRD. Solo sobrevive lo que el revisor no logra refutar.
4. **Verificación por puntos del PRD**: al cerrar un bloque, un agente por sección del PRD responde CUMPLE / PARCIAL / NO CUMPLE con evidencia `archivo:línea`; se corrigen los NO CUMPLE primero.
5. **Puertas antes de cada commit**: `npx tsc --noEmit` limpio, `node --test 'tests/**/*.test.ts'` en verde, `node demo.ts` dos veces idéntico (borrando `out/`), fixtures sin cambios, sin claves en el diff.
6. **Commits atómicos y TBD**: un commit por cambio lógico, mensaje convencional, sin atribución a asistentes; push a `main` (Render despliega) y comprobar `/api/health`.
7. **Sin sobreingeniería**: si un pendiente no mejora lo que el evaluador ve o un criterio del PRD, se documenta como roadmap en vez de construirse.
