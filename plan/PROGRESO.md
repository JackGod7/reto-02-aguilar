# Progreso (cada sesión marca su fila: ✅/⏳/❌ + hora + evidencia en 1 línea)

| Tarea | Modelo | Estado | Hora | Evidencia |
|---|---|---|---|---|
| Pre-requisitos (red, gh, clave, Render) | tú | ⏳ | | |
| M1 scaffold | Haiku | ✅ | 21:26 | typecheck OK; node --test 0 tests; ai 7.0.162, @ai-sdk/anthropic 4.0.96, zod 4.6.7 |
| M2 core + demo | Sonnet | ✅ | | 12/12 tests core; tsc limpio; demo ×2 idéntico, exit 0 |
| M3 agente + server | Sonnet | ✅ | 21:31 | node --test "tests/agent/*.test.ts" 7/7 (mock, sin red); typecheck OK |
| M4 front | Haiku | ✅ | 21:31 | stub contrato §7: `<img onerror>` → texto (0 img); panel ámbar envía "confirmo …"; 401→clave; error claro; sin innerHTML |
| M5 prompt + docs | Haiku | ✅ | 21:30 | agent/prompt.md, src/knowledge/registro-contratos.md, README.md, SOLUCION.md (11 secciones); placeholders y cobertura resueltos en M7 |
| M6 docker | Haiku | ✅ | | docker build OK (node:24-slim, Node v24.22.2, TS nativo sin flags, usuario node); run: /api/health 200 |
| M7 integración | Sonnet | ✅ | | npm test 20/20, typecheck OK, demo ×2 idéntico; e2e real Haiku: parada en 006 + confirmar → registrado + alertas con 3 secciones; 53.358 tokens/lote; precio USD sin verificar |
| Deploy + link | tú | ✅ | | https://reto-02-aguilar.onrender.com |
| ZIP + respuesta | tú | ⏳ | | |
| Revisión final | Opus | ✅ | | auditoría hecha (entrega/AUDITORIA.md) |
| M9 endurecimiento | varios | ✅ | | gate (override limitado, confirmación ligada), servidor (XFF, reset, tope diario, CSP), front, bonus modulo/; npm test 33/33, typecheck limpio |
