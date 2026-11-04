# Traspaso para continuar (otra sesión / otra cuenta)

Estado al 2026-11-03, commit `0a5eaa6` en `main`.

## Dónde está todo
- Repo: https://github.com/JackGod7/reto-02-aguilar (público). Local: `/Users/jackaguilar/reto-periferia-ia`
- App: https://reto-02-aguilar.onrender.com (Render Free, Docker, auto-deploy al hacer push a `main`; duerme tras ~15 min)
- Reto: `docs/PRD.md` (Reto 02, Periferia IT). Entregable: `SOLUCION.md` (11 secciones), `README.md`, `demo.ts`, `modulo/`
- Producto/rol: `docs/PRODUCTO.md`, ADRs en `docs/adr/`, operación en `docs/RUNBOOK.md`
- Entrega (sin versionar, solo local): `entrega/RESPUESTA.md` (correo para Tito Chuque), `entrega/reto-02-aguilar.zip`, auditorías `entrega/AUDITORIA.md`, `entrega/REVISION-R*.md`

## Verificado
- `npx tsc --noEmit` limpio · `node --test 'tests/**/*.test.ts'` 47/47 (sin sandbox: los tests abren puerto)
- `node demo.ts` determinista (borrar `out/` antes) · `/api/health` en vivo ok
- Sin claves reales en repo, historial ni zip. `ANTHROPIC_API_KEY` solo en `.env` local y en Render.

## Reglas del dueño (respetar)
- Commits SIN `Co-Authored-By: Claude` ni mención a Claude Code.
- Nunca escribir ni imprimir `ANTHROPIC_API_KEY`. `ACCESS_KEY` sí está en el README (aprobado).
- Calidad senior / lead (rol AI Product Engineer Senior): cumplir el PRD punto por punto, nada de código junior.
- Dependencias exactas: `ai` 7.0.162, `@ai-sdk/anthropic` 4.0.96, `zod` 4.6.7; modelo `claude-haiku-5-5`; Node 26 con TS nativo.

## Pendientes (parciales de la verificación PRD, por prioridad)
1. CA3: cortar el turno cuando aparece una revisión pendiente y garantizar que el reply incluya la pregunta (`src/agent/run.ts`).
2. CA4: loguear en `out/log.jsonl` las llamadas vetadas por el gate o con args inválidos; mostrar la sonda de registrar en el historial; si el LLM falla a mitad de turno, guardar las toolCalls ya ejecutadas.
3. CA5: el front debe priorizar `err.message` para `llm_error`, `daily_token_limit` y `too_many_sessions` (`web/index.html`).
4. §8: `MAX_STEPS` y `LLM_TIMEOUT_MS` configurables por env (+ `.env.example`).
5. HU-2c: campos con confianza 0 → `null` en la salida de extraer. HU-6a: texto vacío / fecha inválida / moneda desconocida → `{ok:false}`.
6. RN1/RN2 (`src/domain/reglas.ts`): duplicado solo por id + valor + fechas; actualización exige diferencias no vacías.
7. 7.2 `objeto`: quitar prefijo "EL CONTRATISTA se obliga a…".
8. SOLUCION §4: costo USD estimado por caso (≈8.900 tokens/caso × tarifa vigente); §9: estados exactos Hecho/Parcial/No hecho.
9. Observaciones: el tope del ejecutor cuenta llamadas y no pasos; "confirmo msg-0060" casa con msg-006 (usar límite de palabra).

10. Escalamiento de modelo (cascada): Haiku por defecto y Sonnet (`claude-sonnet-5-5`) cuando hay una revisión pendiente, un error de herramienta, se llega al tope de pasos o el turno es explicativo. Implementar en el adapter (`src/llm/`) con `LLM_MODEL` y `LLM_MODEL_ESCALADO`, loguear qué modelo respondió y documentarlo como ADR-004. Para la defensa basta poner `LLM_MODEL=claude-sonnet-5-5` en Render (sin código).
11. Ingeniería de contexto: (a) compactar historial con ventana deslizante o resumen de turnos viejos antes del tope de sesión (`src/agent/run.ts`); (b) prompt caching del system prompt + conocimiento (`cache_control` en el adapter) y medir ahorro; (c) si el conocimiento crece, pasar de inyección completa (ADR-003) a carga bajo demanda por herramienta o RAG; (d) set de evals por escenario (buzón completo, msg-006, rechazo, injection en correo) que mida calidad de respuesta del modelo y sirva para decidir Haiku vs Sonnet (pendiente 10).
12. Observabilidad en prod: conectar el MCP de Render (ver sección siguiente) para leer logs y métricas. Hoy el servidor casi no escribe a stdout (solo "Servidor en :puerto") y `out/log.jsonl` vive en disco efímero de Render: añadir log estructurado JSON a stdout por turno (sessionId, herramientas, ok/error, pasos, tokens, modelo, latencia; nunca claves ni texto completo de contratos).

## MCP de Render
El dueño crea una API key en Render (Account Settings → API Keys) y la registra él mismo, sin pegarla en el chat:
`claude mcp add --transport http render https://mcp.render.com/mcp --header "Authorization: Bearer <RENDER_API_KEY>"`
Luego, en la sesión: seleccionar el workspace y pedir los logs del servicio `reto-02-aguilar`.

Detalle completo de cada hallazgo: volver a correr una verificación del PRD por secciones o leer `entrega/AUDITORIA.md`.

## Flujo de trabajo (TBD)
- Trunk-based: `main` siempre desplegable (Render despliega cada push). Ramas cortas `feat/…` o `fix/…` de horas, merge a `main` con tests en verde.
- Versión entregada congelada: tag `entrega-2026-11-03` y rama `release/entrega-2026-11-03` (commit `0a5eaa6`). No se toca; la defensa puede mostrarse desde ahí.

## Antes de la defensa
- Despertar: abrir `/api/health`. Reset: `curl -X POST https://reto-02-aguilar.onrender.com/api/reset -H "x-access-key: <ACCESS_KEY del README>"`
- Prompt demo: ver README, sección "Prompt de demo (PRD §11)".
- Después del proceso: rotar `ANTHROPIC_API_KEY` y `ACCESS_KEY`.

## Cómo retomar en otra cuenta
Abrir Claude Code en `/Users/jackaguilar/reto-periferia-ia` y pedir: "Lee CLAUDE.md y plan/CONTINUAR.md y sigue con los pendientes". Tras cada cambio: typecheck, tests, demo, commit sin atribución, push, revisar `/api/health`, y regenerar el zip:
`zip -qr entrega/reto-02-aguilar.zip . -x 'node_modules/*' 'out/*' '.env' '.env.*' 'entrega/*' 'plan/fuentes/*' '*.DS_Store'`


## Ejecución A habilitada — actualización vigente

- Coordinador: desarrollo iniciado por instrucción posterior al diagnóstico; etapa B sin implementación.
- Integración aislada: `/Users/jackaguilar/reto-periferia-ia-integracion`, rama `codex/cierre-reto`, HEAD `e735094`. El árbol original y sus borradores se conservaron; no confundir sus tests con los del checkout integrado.
- A1 CUMPLE: HU-2c/HU-6/objeto, revisión adversarial `revision_a1` (Luna); corregidos NIT/RUC, validación monetaria en VALOR, campos ausentes y prefijo del objeto.
- Verificado en la versión de A1: tsc exit0, 55/55 pruebas, demo x2 exit0, stdout/artefactos idénticos salvo ts; fixtures intactos; diff acotado y escaneo de patrones de secretos. Commit local, sin push ni despliegue.
- Dependencias locales: node_modules es enlace al checkout original (sin publicar). plan/PLAN-ATOMICO.md local no forma parte del commit A1.
- Decisión de arquitectura: PRD permite framework libre y TypeScript con Node/Bun; conservar Vercel AI SDK para A. Antes de implementar persistencia/recuperación B, B1 debe comparar LangGraph con el flujo propio mediante spike de pausa/reanudación/crash/replay/coste. LangSmith puede integrarse con Vercel AI SDK; no exige migración a LangChain.
- Siguiente acción exacta: A2 resolver y probar RN1/RN2 (otrosí repetido, diferencias reales, coincidencia NIT+objeto e identidad), sin copiar ciegamente el borrador de reglas. Después A3 contrato de pasos/eventos y A4 HITL. No declarar el reto terminado por A1.
