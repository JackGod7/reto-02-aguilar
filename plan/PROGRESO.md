# Progreso (cada sesión marca su fila: ✅/⏳/❌ + hora + evidencia en 1 línea)

| Tarea | Modelo | Estado | Hora | Evidencia |
|---|---|---|---|---|
| Pre-requisitos (red, gh, clave, Render) | tú | ⏳ | | |
| M1 scaffold | Haiku | ✅ | 21:26 | typecheck OK; node --test 0 tests; ai 7.0.162, @ai-sdk/anthropic 4.0.96, zod 4.6.7 |
| M2 core + demo | Sonnet | ⏳ | | |
| M3 agente + server | Sonnet | ⏳ | | |
| M4 front | Haiku | ⏳ | | |
| M5 prompt + docs | Haiku | ✅ | 21:30 | agent/prompt.md, src/knowledge/registro-contratos.md, README.md, SOLUCION.md (11 secciones); `<COSTO>`, `<URL_PUBLICA>`, `<ACCESS_KEY>` pendientes para M7; cobertura marcada pendiente de verificar |
| M6 docker | Haiku | ✅ | | Dockerfile, .dockerignore, render.yaml escritos; `docker build` NO verificado (socket de Docker denegado en sandbox; `COPY agent/ web/ demo.ts` fallará hasta que M2/M4/M5 existan) |
| M7 integración | Sonnet | ⏳ | | |
| Deploy + link | tú | ⏳ | | |
| ZIP + respuesta | tú | ⏳ | | |
| Revisión final | Opus | ⏳ | | |
