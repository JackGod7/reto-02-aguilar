# PROGRESO — tablero vigente 2026-11-04

Fuente: [PLAN-ATOMICO.md](/Users/jackaguilar/reto-periferia-ia-integracion/plan/PLAN-ATOMICO.md). Checkout de integración: `/Users/jackaguilar/reto-periferia-ia-integracion`, rama `codex/langgraph-reto`, HEAD e735094. Esta sincronización modifica solo documentación.

| Unidad | Estado | Evidencia y pendiente |
|---|---|---|
| A1 extracción | CUMPLE | e735094; tsc, 55/55, demo ×2 determinista, fixtures intactos; commit local |
| A2 clasificación | PENDIENTE | Se conserva la tarea RN1/RN2 y conflictos de identidad; no sustituida por la migración |
| A3 proveedor LangChain | PARCIAL | Implementado como borrador; 10 pruebas focales reportadas, SDK real con HTTP simulado; integración y revisión finales pendientes |
| A4 grafo/aprobación | PARCIAL — P0 abierto | Interrupt/Command y snapshot implementados; confirmación ambigua con ID válido reproducida; falta regresión y revisión completa |
| A5–A8 auditoría/recuperación/UI/límites | PARCIAL | Cambios integrados en borrador; sesión previa al primer efecto/requestId y reservas concurrentes siguen pendientes de aceptación |
| Migración conjunta | PARCIAL | Última comprobación disponible: TypeScript limpio, 86/86. No prueba que el P0 esté resuelto; sin commit/despliegue |
| Sincronización documental | CUMPLE | Plan/CONTINUAR/PROGRESO y referencias alineados con ADR-004; históricos conservados |
| Etapa B | PENDIENTE | Checkpointer durable, identidad, integridad transaccional, recuperación, restauración y reversión probadas |

**Siguiente acción exacta:** cerrar A4-P0 antes de integrar/publicar la migración. Las métricas de rapidez y consumo se medirán; no son mejoras acreditadas.

## Registro histórico anterior — no constituye estado vigente

# Progreso (cada sesión marca su fila: ✅/⏳/❌ + hora + evidencia en 1 línea)

| Tarea | Modelo | Estado | Hora | Evidencia |
|---|---|---|---|---|
| Pre-requisitos (red, gh, clave, Render) | tú | ✅ | | Render con ACCESS_KEY y clave del proveedor; link en funcionamiento |
| M1 scaffold | Haiku | ✅ | 21:26 | typecheck OK; node --test 0 tests; ai 7.0.162, @ai-sdk/anthropic 4.0.96, zod 4.6.7 |
| M2 core + demo | Sonnet | ✅ | | 12/12 tests core; tsc limpio; demo ×2 idéntico, exit 0 |
| M3 agente + server | Sonnet | ✅ | 21:31 | node --test "tests/agent/*.test.ts" 7/7 (mock, sin red); typecheck OK |
| M4 front | Haiku | ✅ | 21:31 | stub contrato §7: `<img onerror>` → texto (0 img); panel ámbar envía "confirmo …"; 401→clave; error claro; sin innerHTML |
| M5 prompt + docs | Haiku | ✅ | 21:30 | agent/prompt.md, src/knowledge/registro-contratos.md, README.md, SOLUCION.md (11 secciones); placeholders y cobertura resueltos en M7 |
| M6 docker | Haiku | ✅ | | docker build OK (node:24-slim, Node v24.22.2, TS nativo sin flags, usuario node); run: /api/health 200 |
| M7 integración | Sonnet | ✅ | | npm test 20/20 en ese momento (hoy 38/38), typecheck OK, demo ×2 idéntico; e2e real Haiku: parada en 006 + confirmar → registrado + alertas con 3 secciones; 53.358 tokens/lote; precio USD sin verificar |
| Deploy + link | tú | ✅ | | https://reto-02-aguilar.onrender.com |
| ZIP + respuesta | tú | ⏳ | | |
| Revisión final | Opus | ✅ | | revisión independiente hecha; hallazgos corregidos (gate, XFF, front) |
| M9 endurecimiento | varios | ✅ | | gate (override limitado, confirmación ligada), servidor (XFF, reset, tope diario, CSP), front, bonus modulo/; npm test 38/38 (2026-11-03), typecheck limpio; conocimiento inyectado en runtime (`src/agent/context.ts`) |

| A1 extracción PRD | coordinador + revisión Luna | ✅ | | e735094 en codex/cierre-reto; tsc,55/55,demo×2 exit0 determinista,fixtures intactos; sin push |
