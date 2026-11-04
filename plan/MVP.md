# Archivo histórico: plan MVP de la primera entrega

Este documento conserva el plan original AI SDK. **No ejecutar sus prompts ni instalaciones.** Stack y dependencias vigentes: Node + LangGraph + LangChain, ADR-004. Fuente de tareas: [plan vigente](/Users/jackaguilar/reto-periferia-ia-integracion/plan/PLAN-ATOMICO.md). La autorización actual requiere revisión independiente y cierre del P0 de aprobación antes de integrar/publicar.

## Texto histórico conservado

# Plan MVP — 40 min (Haiku/Sonnet). Opus solo al final para revisar.

## Antes de lanzar sesiones (tú, 3 min, bloquea todo)
1. **Red del sandbox**: las sesiones necesitan `registry.npmjs.org` (npm) y luego `api.anthropic.com`, `github.com`, `api.github.com`. Si un comando falla con 403 "allowed_domains", reintentar con ese host permitido.
2. `gh auth login -h github.com` (el token actual está inválido) y crear repo vacío `reto-02-aguilar` (o el apellido que uses).
3. Clave Anthropic nueva con límite de gasto → `.env` (`ANTHROPIC_API_KEY=…`), nunca en chat.
4. Cuenta Render conectada a GitHub. (Bun no está instalado: se usa Node 26 con TS nativo; el PRD lo permite.)

## DAG y tiempos (cwd de todas las sesiones: `/Users/jackaguilar/reto-periferia-ia`)
```
t=0-5   M1 scaffold (Haiku)  ───────────────┐
t=5-22  M2 core+demo (Sonnet) ∥ M3 agente+server (Sonnet) ∥ M4 web (Haiku) ∥ M5 prompt+docs (Haiku) ∥ M6 docker (Haiku)
t=22-30 M7 integración + e2e real + costo (Sonnet)
t=30-37 DEPLOY (tú: push + Render) + verificar link
t=37-40 ZIP + respuesta al hilo
```
Propiedad de archivos (nadie toca lo ajeno): M1 raíz/config · M2 `src/domain/** src/infra/** src/tools/contratos.ts demo.ts tests/core/**` · M3 `src/llm/** src/agent/** src/server.ts tests/agent/**` · M4 `web/**` · M5 `agent/prompt.md src/knowledge/** README.md SOLUCION.md` · M6 `Dockerfile .dockerignore render.yaml`.
**Recorte si vas tarde**: sin ADRs, sin `modulo/`, sin `toolApproval`, SOLUCION §7/§11 en 3 bullets cada una. Nunca recortar: demo verde, chat, link público.

## Tareas y prompts (copiar tal cual en cada sesión)
Prefijo común de todos: *"Lee CLAUDE.md y plan/SPEC.md (no el TRASPASO). Trabaja directo, sin explorar de más. Solo tus archivos. Al cerrar: commit de tus rutas, marca plan/PROGRESO.md y reporta en 3 líneas con evidencia."*

**M1 · Scaffold (Haiku, 5 min)** — `git init` (rama main); `package.json` (`"type":"module"`, scripts `test:"node --test"`, `demo`, `dev:"node src/server.ts"`, `typecheck`); instalar con versiones exactas `zod ai @ai-sdk/anthropic` + dev `typescript @types/node` (`npm install --save-exact`, `.npmrc: ignore-scripts=true`); `tsconfig.json` estricto (`allowImportingTsExtensions`, `noEmit`, `module/moduleResolution: nodenext`, `erasableSyntaxOnly`, `verbatimModuleSyntax`); `.gitignore` (node_modules, out, .env, plan/fuentes/*.zip); `.env.example` (ANTHROPIC_API_KEY, LLM_PROVIDER=anthropic, LLM_MODEL, MAX_SESSION_TOKENS, ACCESS_KEY, PORT, HOY opcional); copiar `plan/fuentes/reto-02/fixtures/reto-02` → `fixtures/reto-02` y `plan/fuentes/reto-02/PRD.md` → `docs/PRD.md`; stubs que compilan: `src/tools/contratos.ts` exportando las 5 tools del SPEC §5 devolviendo `{ok:false,error:"no implementado"}`. Hecho: `npm run typecheck` y `npm test` (0 tests) ok; commit `chore(scaffold): inicializa repo`. Reporta versiones instaladas y la ruta de docs del AI SDK en `node_modules/ai`.

**M2 · Core + demo (Sonnet, 17 min) — la tarea crítica.** Implementa SPEC §1–§5 completo: `src/domain/{contrato,extraccion,reglas,dinero,fechas,slug,csv}.ts`, `src/infra/*` (buzón, maestro CSV atómico, archivo seguro, historial, procesados, log), `src/tools/contratos.ts` real, `demo.ts`. **Tests primero** (`tests/core/*.test.ts`) con la tabla de SPEC §4 como casos exactos + las 4 pruebas de seguridad del SPEC §5; luego código hasta verde. `demo.ts`: limpia `out/`, hoy=2026-09-03, procesa 001→006 llamando `execute` directo, 006 queda sin registrar en 1ª pasada, 2ª llamada con `confirmado:true`, luego alertas; imprime tabla por mensaje; 2 corridas = misma salida (salvo ts), exit 0, sin clave. Commits por bloque (`feat(domain): …`, `feat(tools): …`, `feat(demo): …`). Reporta salida de `node --test` y `node demo.ts`.

**M3 · Agente + servidor (Sonnet, 17 min)** — SPEC §6–§7. `src/llm/adapter.ts` (interfaz propia) + `anthropic.ts`; `src/agent/{registry,session,run}.ts` (tools `contratos_*` desde `src/tools/contratos.ts` con `z.object(args).strict()` y `inputSchema`; gate de `confirmado` y `needsConfirmation` por el servidor; topes); `src/server.ts` con `node:http` (4 rutas + estáticos de `web/` + rate limit + ACCESS_KEY + errores claros, nunca filtrar la clave). Antes de codificar, abre `node_modules/ai` (README/docs/types) y confirma `generateText`, `tool`, `stepCountIs`, `inputSchema`, usage. Tests con modelo guionado (mock del adapter): el lote se detiene en 006 con `needsConfirmation`; `confirmado:true` sin revisión pendiente es rechazado; mensaje >2000 → 400; sessionId inventado → 404. Hasta que M2 aterrice, trabaja contra los stubs de M1 (misma firma). Reporta `node --test tests/agent`.

**M4 · Front (Haiku, 10 min)** — `web/index.html` (+ css/js inline o 2 archivos): historial, input, "pensando…", tool calls colapsables (nombre, args, ok, resumen), panel ámbar con campos propuestos y botones Aprobar/Rechazar → `POST /api/chat` con "confirmo …"/"rechazo …"; `ACCESS_KEY` pedida solo si el servidor responde 401; `sessionId` en `localStorage`; **solo `textContent`**. Verifica con un servidor stub local contra el contrato de SPEC §7 (sin tocar `src/`). Prueba: `<img onerror>` en una respuesta se ve como texto.

**M5 · Prompt + docs (Haiku, 12 min)** — `agent/prompt.md` (borrador en TRASPASO §4b, ajustado a SPEC §6: el modelo SÍ llama `registrar`; la pregunta la arma el servidor), `src/knowledge/registro-contratos.md` (RN1–RN5, umbrales, glosario, gobierno), `README.md` (arranque `npm install && npm run dev`, variables, `node demo.ts`, API, link público y `ACCESS_KEY`), `SOLUCION.md` con las 11 secciones (contenido base en TRASPASO §14; no inventes costos: deja `<COSTO>` para M7).

**M6 · Docker (Haiku, 5 min)** — `Dockerfile` (`node:24-slim`, `npm ci --omit=dev`, usuario `node`, `out/` escribible, `CMD ["node","src/server.ts"]`, `PORT`), `.dockerignore` (.env, node_modules, out, plan/fuentes, .git), `render.yaml` (web, docker, healthCheckPath `/api/health`, env sin valores). Prueba `docker build` si hay red.

**M7 · Integración (Sonnet, 8 min, tras M2+M3+M4)** — `npm test`, `npm run typecheck`, `node demo.ts` ×2; arrancar server con clave real y recorrer el prompt del PRD §11 por curl: tabla por mensaje, parada en 006, confirmar → registrado, `out/alertas.md` con las 3 secciones; medir tokens reales y rellenar `<COSTO>` en SOLUCION (precio vigente del proveedor, indica la fecha); grep de la clave en `out/` y respuestas = 0; hash de `fixtures/` sin cambios; arreglar lo que falle. Reporta evidencia.

**Deploy (tú):** `git remote add origin …; git push -u origin main`; Render → New Web Service → repo → Docker → variables (`ANTHROPIC_API_KEY`, `LLM_MODEL`, `ACCESS_KEY` opcional) → comprobar `/api/health` y una conversación. **Cierre:** `zip -r reto-02-aguilar.zip . -x 'node_modules/*' 'out/*' '.env' '.git/*' 'plan/fuentes/*'`; respuesta al hilo (borrador en TRASPASO §15).

## Revisión final (Opus, después)
Pedirle: contrastar repo vs `docs/PRD.md` (HU-1…6, CA1–5, RN1–7, entregables §9), tabla SPEC §4 vs salida real, riesgos ★ (V1,V2,V3,V5,V8,V9,V11,V13), que SOLUCION no afirme nada no hecho, y proponer el escalado robusto (`toolApproval`, ADRs, bonus `modulo/`).
