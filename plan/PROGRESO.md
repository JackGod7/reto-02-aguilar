# Progreso (cada sesión marca su fila: ✅/⏳/❌ + hora + evidencia en 1 línea)

| Tarea | Modelo | Estado | Hora | Evidencia |
|---|---|---|---|---|
| Pre-requisitos (red, gh, clave, Render) | tú | ⏳ | | |
| M1 scaffold | Haiku | ✅ | 21:26 | typecheck OK; node --test 0 tests; ai 7.0.162, @ai-sdk/anthropic 4.0.96, zod 4.6.7 |
| M2 core + demo | Sonnet | ✅ | | 12/12 tests core; tsc limpio; demo ×2 idéntico, exit 0 |
| M3 agente + server | Sonnet | ✅ | 21:31 | node --test "tests/agent/*.test.ts" 7/7 (mock, sin red); typecheck OK |
| M4 front | Haiku | ✅ | 21:31 | stub contrato §7: `<img onerror>` → texto (0 img); panel ámbar envía "confirmo …"; 401→clave; error claro; sin innerHTML |
| M5 prompt + docs | Haiku | ✅ | 21:30 | agent/prompt.md, src/knowledge/registro-contratos.md, README.md, SOLUCION.md (11 secciones); `<COSTO>`, `<URL_PUBLICA>`, `<ACCESS_KEY>` pendientes para M7; cobertura marcada pendiente de verificar |
| M6 docker | Haiku | ✅ | | Dockerfile, .dockerignore, render.yaml escritos; `docker build` NO verificado (socket de Docker denegado en sandbox; `COPY agent/ web/ demo.ts` fallará hasta que M2/M4/M5 existan) |
| M7 integración | Sonnet | ⏳ | | |
| Deploy + link | tú | ⏳ | | |
| ZIP + respuesta | tú | ⏳ | | |
| Revisión final | Opus | ⏳ | | |
