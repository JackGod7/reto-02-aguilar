# CONTINUAR — estado real 2026-11-04

Reto 02 Periferia IT: agente de chat "Registro de Contratos Vigentes". Entregado (tag `entrega-2026-11-03`, versión Vercel AI SDK). Hoy `main` = **1d38be7** (migración a LangGraph + LangChain), igual en GitHub y en Render.

## Estado verificado
- Render: https://reto-02-aguilar.onrender.com · `/api/health` → `buildSha` 1d38be7, modelo `claude-sonnet-5-5`, `tracing:false`.
- Servicio `srv-dbla0hqjnfac73fblb6g` (repo JackGod7/reto-02-aguilar, rama main, autoDeploy por commit; no hagas trigger_deploy tras push).
- Demo del PRD probada en real: pausa en msg-006, una confirmación, alertas generadas. Reset hecho (`{"ok":true}`).
- Puertas OK: tsc limpio · 176/176 tests · `verificar-entrega.ts` exit 0 · knip 0 hallazgos · escaneo de secretos limpio.

## Checkouts
- **Trabajo:** `/Users/jackaguilar/reto-periferia-ia-integracion` (rama `codex/langgraph-reto`, = main). Usar este.
- **Viejo:** `/Users/jackaguilar/reto-periferia-ia` — en `main`, 19 commits atrás y con ~20 archivos modificados sin commit y `entrega/` sin trackear (ahí vive `entrega/DEFENSA-RELEASE.md`). Ignorarlo, o actualizarlo con `git stash push -u -m viejo` → `git pull` → `git stash pop`. No pierdas `entrega/`.

## Arquitectura (ADR en `docs/adr/`, 004 = LangGraph)
- `src/domain/` reglas puras: extracción, clasificación, fechas, dinero, alertas, CSV.
- `src/infra/` archivos, buzón, maestro, registros, rutas (solo escribe bajo `out/`).
- `src/tools/` tools `{description, args zod, execute → JSON ok/error}`; nunca lanzan.
- `src/agent/graph.ts` grafo LangGraph: controla el flujo y el HITL (confirmación); además `session.ts`, `registry.ts`, `context.ts`.
- `src/llm/` adapter y ChatAnthropic de un paso; el proveedor nunca ejecuta tools; trazas externas apagadas.
- `src/server.ts` HTTP (`/api/health`, sesiones, chat, reset con ACCESS_KEY).
- `web/index.html` UI de chat.

## Puertas antes de cada push
```
npx tsc --noEmit
node --test 'tests/**/*.test.ts'
node scripts/verificar-entrega.ts
npx -y knip@latest   # entradas prod: src/server.ts, demo.ts, scripts/*.ts · 0 hallazgos
git diff | grep -iE 'sk-ant|ANTHROPIC_API_KEY=|ACCESS_KEY=|/Users/'   # secretos y rutas
```

## Método (ver AGENTS.md)
Coordinador que solo orquesta (verificar/escanear/editar en sesiones aparte); LangGraph: compilado una vez, thread_id=sessionId, nodos con nombre; pruebas Gherkin por criterio PRD; evals con modelo real sin maquillar; red team por patrón. Además: sesiones o agentes por unidad en archivos disjuntos; revisión adversarial antes de integrar; borrar antes de escribir; sin sobreingeniería. Commits atómicos `tipo(alcance): verbo`, sin atribución. Nunca escribas ANTHROPIC_API_KEY.

## Pendientes (prioridad)
1. HECHO (3ed602f): `src/infra/log.ts` log JSON a stdout. Prueba real prod 1d38be7 OK (pausa 006, 1 confirmación, alertas). H6/H7 documentados como abiertos. Trazabilidad en SOLUCION.md hecha. Falta: evals reales post-arreglos (Haiku) y revisar logs JSON en Render.
2. Revisar logs de Render 10 min tras el próximo deploy (MCP render `list_logs`).
3. Sección "Trazabilidad código → PRD" en `SOLUCION.md`, desde `entrega/DEFENSA-RELEASE.md` (checkout viejo) y la tabla del backend.
4. Preparar la defensa con `entrega/DEFENSA-RELEASE.md`.
5. Etapa B solo como roadmap (`SOLUCION.md` §9); no implementar.
6. Rotar ANTHROPIC_API_KEY y ACCESS_KEY cuando termine el proceso (Render → Environment).

## Retomar (una línea)
> Lee `CLAUDE.md` y `plan/CONTINUAR.md` en `/Users/jackaguilar/reto-periferia-ia-integracion`, verifica `git log -1` y `/api/health`, y ejecuta el pendiente 1 como coordinador, con las puertas antes de cada push.
