> Actualización: este documento contiene la referencia operativa de la etapa AI SDK. La migración Node + LangGraph se define en ADR-004; los recuentos y mediciones históricos deben revalidarse. MemorySaver no proporciona recuperación ante reinicios ni acredita operación productiva.

# PRODUCTO — Registro de Contratos Vigentes (agente)

Lectura prevista: 5 minutos. Cargo: AI Product Engineer Senior. Cada afirmación lleva uno de tres estados:

- **Hecho**: existe en el repo y se verificó (test, demo o corrida real).
- **Siguiente**: decidido y acotado, no construido.
- **Hipótesis**: creencia a validar con usuarias o datos; no es un resultado.

Lo medido hasta hoy: 53.358 tokens por lote de 6 correos (una sola corrida real con `claude-haiku-5-5`, 2026-11-03, sin desglose entrada/salida). El costo en USD no está calculado porque no verifiqué el precio por token. No usé Lovable ni v0 en este proyecto.

## 1. Matriz requisito del cargo → evidencia → estado

| Requisito del aviso | Evidencia en el repo | Estado |
|---|---|---|
| 3-5 años en el rol | No es verificable con un repo. Este proyecto es una prueba de 2 h, no historial | Fuera de alcance de esta matriz |
| Liderar funcionalidades de IA agéntica **en producción** | Agente ReAct acotado (`src/agent/run.ts`, 25 pasos, topes de tokens), desplegado en `https://reto-02-aguilar.onrender.com` (Render Free, Docker no root, `Dockerfile`, `render.yaml`). Es un despliegue de demo, no producción con usuarios reales | Hecho como demo desplegada. Producción real: **Siguiente** (§5) |
| IA generativa | `src/llm/anthropic.ts` (Haiku), `agent/prompt.md`; el modelo conduce la conversación y explica, no decide valores | Hecho |
| RAG | **Hecho**: conocimiento en contexto, sin RAG vectorial. `src/knowledge/registro-contratos.md` (~5 KB) se inyecta completo en el system prompt (`src/agent/context.ts`, ADR-003; test `tests/core/context.test.ts`) | **Hipótesis**: RAG vectorial solo se justifica cuando el corpus (cláusulas, políticas de varias aseguradoras) no quepa en contexto |
| Function calling / tool calling | 5 tools `contratos_*` con esquemas zod (`src/tools/contratos.ts`); el modelo elige *qué* mensaje procesar, los valores salen de las tools | Hecho |
| Extracción confiable | Extracción determinista con confianza por campo (`src/domain/extraccion.ts`); `demo.ts` reproduce la tabla esperada sin modelo | Hecho (`npm test` 38/38 el 2026-11-03; demo determinista) |
| Control humano (HITL) | Gate en código, umbral 0,8 (`src/domain/contrato.ts` `UMBRAL`; `src/agent/run.ts`); solo se confirma una revisión que la persona vio en un turno previo; con varias pendientes, el texto debe nombrar el `mensaje_id`; el override se limita a campos en revisión (`src/agent/run.ts`) | Hecho, con tests adversariales (`tests/core/gate-adversarial.test.ts`). Una revisión independiente encontró un bypass (override sin gate) y dos huecos de confirmación; los tres están cerrados y cubiertos por test |
| Estrategia de producto | Problema, usuaria, JTBD, KPIs, caso de negocio: §2-§4 de este documento. PRD del reto en `docs/PRD.md` | Hecho (documento). Validar con usuarias: **Siguiente** |
| Roadmap y backlog | §5 | Hecho (documento) |
| Caso de negocio | §4, con fórmula y supuestos. Sin cifras de negocio reales | Hecho como modelo; los datos de entrada son **Hipótesis** |
| Diseñar UX | `web/index.html`: tool calls visibles, panel ámbar de confirmación, errores claros, recuperación de sesión (§6) | Hecho |
| Prototipar con Lovable, v0 o similares | **No usado.** El front es HTML plano escrito con asistencia de Claude Code | **Siguiente**: propuesto como herramienta para iterar UX (§6) |
| Equipos multidisciplinarios (IA, tecnología, negocio) | Regla de gobierno como acuerdo entre áreas (`SOLUCION.md` §6) y RACI (§7). No hubo equipo real en este reto | Hecho como propuesta; **Hipótesis** de que las áreas la aceptan |
| "Implementación real, no solo prototipos" | Despliegue vivo con `ACCESS_KEY` activa, tests, demo determinista, topes de costo, revisión independiente con hallazgos corregidos. Faltan: persistencia real, conectores, observabilidad, evals continuos | Parcial: ver backlog §5 |

## 2. Problema, usuaria y valor

**Problema.** El maestro de contratos está congelado desde 2026-05-30. Solo llegan a administración los contratos con póliza, no hay buzón único ni responsable, y el proceso murió cuando se fue una persona. Consecuencias: nadie sabe qué contratos están vigentes, cuáles vencen ni qué pólizas faltan.

**Usuaria principal.** La analista administrativa, dueña del maestro. Usuarias secundarias: gerencia (consume alertas) y comerciales (envían, no usan el agente).

**Jobs-to-be-done** (formulados desde el PRD, sin entrevistas):

1. Cuando llega un contrato, quiero tenerlo registrado y archivado sin leer 20 páginas, para mantener el maestro al día.
2. Cuando un dato es dudoso, quiero verlo con su contexto y decidir yo, para no registrar algo equivocado.
3. Cuando se acerca un vencimiento o falta una póliza, quiero enterarme antes, para actuar a tiempo.
4. Cuando alguien rota, quiero que el proceso siga, para no depender de una persona.

**Hipótesis de valor** (a validar, ninguna probada):

- H1. Un agente que extrae y deja a la analista solo confirmar los campos dudosos reduce el tiempo por contrato frente al registro manual.
- H2. Un buzón único con acuse automático aumenta la cobertura: llegan también los contratos sin póliza.
- H3. La analista confía en el agente si ve de dónde sale cada valor y puede corregirlo antes del registro.

## 3. KPIs

| Tipo | KPI | Definición | Meta / estado |
|---|---|---|---|
| Norte | Cobertura del maestro | % de contratos facturados que están en el maestro | Meta ≥ 95 %. Línea base: no medida (requiere cruce con facturación) |
| Norte | Tiempo firma → registro | Días hábiles entre la firma y la fila en el maestro | Meta a fijar con la línea base. La regla de gobierno propone un máximo de 3 días hábiles de envío por el comercial |
| Calidad | Tasa de revisión humana | Contratos con al menos un campo bajo 0,8 / contratos procesados | Sin meta fija: muy baja sugiere umbral laxo, muy alta sugiere extracción pobre. En los 6 fixtures: 1 de 6 pasó por revisión (006), una sola muestra |
| Calidad | Precisión por campo | Campos correctos / campos evaluados, sobre un golden set | Hoy: los 6 fixtures coinciden con la tabla esperada. Golden set ampliado: **Siguiente** |
| Costo | Costo por caso | Tokens (y USD) por contrato procesado | Medido: 53.358 tokens por lote de 6 (≈ 8.900 por correo, derivado de una corrida). USD no calculado |
| Guardia | Registros sin gate | Filas escritas con campos < 0,8 sin confirmación válida | **Debe ser 0**. Cualquier valor mayor es incidente |
| Guardia | Errores de herramienta y del proveedor | Tasa por día | Sin umbral aún; hoy solo `out/log.jsonl` por tool |
| Guardia | Gasto diario | Tokens por día frente a `MAX_DAILY_TOKENS` | Tope configurado en código; el límite de gasto en el proveedor es un control aparte y no está verificado |

## 4. Caso de negocio (modelo, no resultado)

No tengo cifras reales de Periferia. Lo siguiente es una fórmula con supuestos a llenar; no hay un beneficio calculado.

**Variables**

- `N` = contratos nuevos u otrosíes por mes que llegan al buzón.
- `t_man` = minutos de analista por contrato hoy (leer, tipear, archivar, verificar).
- `t_asis` = minutos de analista por contrato con el agente (revisar el resumen y confirmar). Con `r` = tasa de revisión, `t_asis = t_conf + r × t_rev`.
- `c_h` = costo por hora de la analista.
- `c_ia` = costo del modelo por contrato = tokens por contrato × precio por token (precio no verificado, por eso `c_ia` queda sin valor).
- `c_fijo` = hosting, mantenimiento y evals por mes.

**Ahorro mensual de tiempo**

`Ahorro = N × (t_man − t_asis) / 60 × c_h − N × c_ia − c_fijo`

**Riesgo evitado (pólizas no constituidas o vencidas)**

`Riesgo evitado = P_antes × E × (1 − P_después)` sumado sobre contratos con póliza exigida, donde `E` es la exposición por contrato (penalidad o pérdida si la póliza falta), `P_antes` la probabilidad de que falte hoy y `P_después` con alertas. Es el término más valioso y el menos conocido: **Hipótesis**, depende de datos que no tengo (historial de incumplimientos y penalidades).

**Supuestos explícitos**

1. `t_asis < t_man` (H1, sin medir). Si la revisión fuera tan lenta como el registro manual, no hay ahorro.
2. `N` es estable. Sale del volumen real del buzón, que no conozco.
3. El agente solo ahorra tiempo si la analista no relee todo el contrato. Eso depende de confianza (H3).
4. El costo del modelo es pequeño frente al de la analista. Sin precio verificado, no lo afirmo.
5. Alertas efectivas implican que alguien actúa sobre ellas. Es un tema de proceso, no del agente.

**Cómo obtener los datos**: cronometrar 10 registros manuales (línea base `t_man`), medir `t_asis` en shadow mode y contar `N` del buzón durante un mes.

## 5. Roadmap y backlog

### Roadmap

| Horizonte | Contenido | Criterio de salida |
|---|---|---|
| **Ahora** (hecho) | Agente acotado, gate en código (confirmación ligada y override acotado), conocimiento inyectado en el prompt, demo determinista, chat web con recuperación de sesión, despliegue en Render Free | Demo y 38 tests verdes |
| **Siguiente** | **Shadow mode**: el agente procesa el buzón real, la analista sigue registrando a mano y se comparan resultados. Después **asistido**: el agente propone, la analista confirma todo. Conectores Graph (correo) y SharePoint. Golden set y evals en CI. `toolApproval` nativo del AI SDK. Persistencia real y reset por sesión | Precisión por campo y cobertura medidas sobre ≥ 1 mes de shadow |
| **Después** | **Autónomo solo para casos limpios** (todos los campos ≥ 0,8, sin conflictos, remitente conocido), con muestreo humano. OCR para escaneados. RAG vectorial solo si el corpus crece. Dashboards para gerencia | Registros sin gate = 0 sostenido y precisión en el umbral acordado |

El paso a "autónomo" es una decisión de gobierno, no técnica: se toma con datos del modo asistido y con acuerdo de gerencia.

### Backlog priorizado (MoSCoW)

| # | Ítem | Valor | Esfuerzo | Riesgo si no se hace | MoSCoW |
|---|---|---|---|---|---|
| 1 | Gate sin bypass: override acotado y test adversarial | Alto: es la tesis central | S | Alto: rompe "el gate es código" | Must (hecho) |
| 2 | Confirmación como evento explícito (`toolApproval` o token de un solo uso). Hoy está ligada a `mensaje_id` y a un turno previo, pero se detecta por texto | Alto | M | Medio: un "ok" ambiguo podría autorizar | Must (parcial) |
| 3 | Shadow mode con comparación contra registro manual | Alto: valida H1 | M | Alto: lanzar sin evidencia | Must |
| 4 | Golden set y evals en CI (§8) | Alto | M | Alto: regresiones silenciosas | Must |
| 5 | Estado por sesión: hoy `procesados.json` es global y el reset exige `ACCESS_KEY` | Medio | S | Medio: demo no reproducible | Should |
| 6 | Fijar el límite de gasto en el proveedor (rate limit detrás de proxy y tope diario global ya están en código) | Medio | S | Medio: abuso de costo | Should |
| 7 | Conectores Graph (correo) y SharePoint | Alto | L | Medio: sin ellos el flujo sigue simulado | Should |
| 8 | Persistencia real (BD) y bloqueo de concurrencia; el CSV pierde actualizaciones entre procesos | Alto | L | Alto en producción | Should |
| 9 | Observabilidad: logs estructurados, uso, errores del proveedor, versión en `/api/health` | Medio | M | Medio | Should |
| 10 | Resumen oficial renderizado desde JSON de tools, no generado por el modelo | Medio | S | Medio: el modelo puede narrar mal un valor correcto | Could |
| 11 | OCR para escaneados | Medio | L | Bajo hoy: los fixtures traen texto | Could |
| 12 | RAG vectorial sobre cláusulas y políticas | Bajo hoy | L | Bajo: el corpus cabe en contexto | Won't (ahora) |

## 6. UX

**Decisiones del chat (hechas, en `web/index.html`)**

- **Tool calls visibles**: la analista ve qué hizo el agente y con qué resultado, para poder auditarlo.
- **Confianza por campo**: se muestran los campos en revisión con su confianza, no un "baja confianza" genérico.
- **Panel ámbar de confirmación**: estado distinto del resto del chat; la pregunta la arma el servidor a partir del resultado de la tool, no el modelo.
- **Errores claros**: mensajes en lenguaje llano con la sesión viva.
- **Recuperación de sesión**: si el servidor se durmió o se reinició, el front reconoce `session_not_found` y vuelve a empezar sin dejar a la usuaria atascada. Lo encontró la revisión independiente y está corregido.

**No validado**: ninguna usuaria real ha usado el chat; no hay pruebas de usabilidad.

**Cómo validaría la siguiente versión**

1. Prototipos rápidos de la vista de revisión (campo, valor propuesto, fuente en el texto del contrato, confirmar/corregir) con **Lovable o v0 como herramienta propuesta, no usada hasta hoy**. Sirven para probar flujos con usuarias antes de tocar el código del agente.
2. Pruebas con **3-5 usuarias** (analista, relevo de la analista, alguien de gerencia): tareas con los fixtures, "procesa el buzón" y "confirma el contrato 006", pensando en voz alta.
3. Medir: tiempo hasta confirmar, errores de confirmación, y si piden ver el contrato original. Si piden ver el PDF en la mayoría, el valor está en mostrar la cita de origen.
4. Con 3-5 usuarias se detectan problemas de usabilidad, no se mide precisión ni valor de negocio.

## 7. Equipo multidisciplinario

**RACI** (R: ejecuta, A: responde, C: consultado, I: informado)

| Actividad | Analista | Comercial | Gerencia | TI / seguridad | Aseguradora |
|---|---|---|---|---|---|
| Enviar contrato firmado al buzón | I | R/A | I | - | - |
| Procesar, confirmar campos dudosos | R/A | C | I | - | - |
| Definir umbral y casos autónomos | C | I | A | C | - |
| Gestionar buzón, permisos y claves | C | - | I | R/A | - |
| Evals, prompt y modelo | C | - | I | R/A (con producto) | - |
| Alertas y acción sobre pólizas | R | I | A | - | Fuera del sistema |

**La regla de gobierno como acuerdo entre áreas** (`SOLUCION.md` §6). Resumen: canal único administrado por la analista; el comercial envía en un máximo de 3 días hábiles con asunto normalizado; acuse automático; escalamiento a gerencia si no hay envío; indicador de cobertura. El agente no puede reemplazarla: sin ese compromiso del comercial, el maestro seguirá incompleto. Es una propuesta; ninguna área la ha firmado.

## 8. Plan de evaluación y gobierno del modelo

**Hoy (hecho)**: 38 tests (dominio, tools, servidor, gate adversarial); demo determinista; una corrida real medida (53.358 tokens). **No hay evals del modelo en CI** ni golden set más allá de los 6 fixtures.

**Plan (siguiente)**

1. **Golden set y regresión**: ampliar con contratos reales anonimizados y casos difíciles (formatos de dinero, otrosíes, NIT ambiguos). Métricas: precisión por campo, tasa de revisión y falsos "limpios" (campo incorrecto con confianza ≥ 0,8, la más peligrosa). No se cambia `LLM_MODEL` ni `agent/prompt.md` sin correrlo antes.
2. **Adversarial**: correos con instrucciones incrustadas, overrides fuera de la revisión y confirmaciones ambiguas. Criterio: registros sin gate = 0.
3. **Deriva y costo**: tasa de revisión, distribución de confianza y tokens por lote semana a semana; línea base, los 53.358 tokens medidos.
4. **Gobierno**: prompt versionado, modelo fijado por variable y registrado en el log, cambios por PR con evals adjuntos, responsable nombrado (TI con producto), plan de reversa, retención de datos personales definida (riesgo en `SOLUCION.md` §11).
