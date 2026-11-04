# SOLUCION — Registro de Contratos Vigentes

Estrategia de producto, roadmap, backlog y caso de negocio: [`docs/PRODUCTO.md`](docs/PRODUCTO.md). Decisiones de arquitectura: [`docs/adr/`](docs/adr/). Operación: [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

Estado al 2026-11-04: migración Node + LangGraph en integración, sin commit ni despliegue. A1 está integrada en e735094. A3 y la corrección A4-P0 tienen revisión independiente focal 36/36; A2 está implementada en revisión y las puertas conjuntas A5–A12 siguen pendientes. Las cifras y decisiones históricas se identifican como tales; este documento no acredita operación con datos reales.

## 1. Problema

El maestro de contratos vigentes está congelado desde el corte de 2026-05-30: los contratos nuevos no se registran y no se sabe qué vence ni qué pólizas faltan. Le duele a la analista administrativa, dueña del maestro, y a gerencia, que no tiene visibilidad de vencimientos ni de garantías pendientes.

## 2. Arquitectura

```
Navegador (web/)
   │  POST /api/chat · POST /api/reset · GET /api/sessions/:id · GET /api/health
   ▼
Servidor node:http (src/server.ts)
   │  rate limit · ACCESS_KEY · tamaños · sesiones en memoria
   ▼
Agente (src/agent/)  ── system prompt: agent/prompt.md
   │  LangGraph: modelo → herramienta → revisión → interrupt → Command
   │  LangChain: una llamada al proveedor por paso · topes de pasos/tokens/tiempo
   │  conocimiento inyectado en el system prompt: src/knowledge/registro-contratos.md
   ▼
Herramientas contratos_* (src/tools/contratos.ts)
   │  leer_buzon · extraer · validar · registrar · alertas
   ▼
Dominio e infraestructura (src/domain/, src/infra/)
   ├── lectura: fixtures/reto-02/ (solo lectura)
   └── escritura: out/ (maestro CSV, archivos de contratos, historial, procesados, log, alertas)
```

- **Dónde vive cada cosa**: el comportamiento del agente está en `agent/prompt.md`. Las reglas de negocio están en `src/knowledge/` (el documento completo, ~5 KB, se inyecta en el system prompt al arrancar con `src/agent/context.ts`; ADR-003) y, como código, en `src/domain/`. La ejecución está en `src/tools/`.
- **Proveedor**: interfaz propia en `src/llm/adapter.ts`, con implementación LangChain ChatAnthropic. Cambiar de proveedor conserva las herramientas, pero requiere un adaptador y pruebas de compatibilidad.
- **Herramientas por `mensaje_id`**: el modelo elige *qué* mensaje procesar; los valores los leen las herramientas del fixture. El modelo no puede inventar un valor registrable.

## 3. Ciclo del agente

El motor LangGraph controla nodos separados de modelo, herramienta, detección de revisión, espera humana y registro aprobado. El proveedor LangChain devuelve solicitudes y consumo por una sola llamada: no ejecuta herramientas. Un interrupt pausa la cola antes de la siguiente herramienta; la reanudación usa Command tras verificar la decisión humana contra la propuesta exacta. Una bandera confirmado generada por el modelo no autoriza el registro.

El estado del grafo conserva cola, mensajes modelo/herramientas y revisión por sesión. Los checkpoints MemorySaver son adecuados para demostrar el reto en un proceso; no dan recuperación ante reinicios. La aprobación, persistencia durable, identidad, presupuestos concurrentes y restauración operativa se verifican por separado para el piloto. Los errores devuelven información parcial recuperable sin exponer detalles privados del proveedor.

MAX_STEPS, MAX_TOOL_CALLS, LLM_TIMEOUT_MS, LLM_MAX_OUTPUT_TOKENS y MAX_SESSION_TOKENS limitan la ejecución. Las trazas externas LangSmith están deshabilitadas por invocación. Véase ADR-004 para motivación, alternativas y pruebas de aceptación.

## 4. Elección del modelo

El coste actual por caso todavía no está acreditado. La referencia histórica siguiente pertenece a la versión AI SDK; no es una estimación válida de LangGraph ni permite inferir coste por operación.

- **Proveedor y modelo**: Anthropic, `claude-haiku-5-5` como default del código, configurable con `LLM_MODEL`. Se conserva la elección inicial para comparar calidad y consumo con una base conocida; no se ha demostrado que sea el modelo óptimo. La configuración efectiva se contrasta en health para el SHA desplegado.
- **Referencia histórica**: las notas de una corrida AI SDK del 2026-11-03 registran 53.358 tokens por lote (39.041 + 14.317; seis correos y confirmación). Sin desglose entrada/salida/caché, repetición comparable ni precio vigente aplicado, no se calcula USD ni un promedio por correo.
- **Medición pendiente**: registrar SHA, modelo efectivo, mensajes, altas/actualizaciones completadas, reintentos, fallos, uso de entrada/salida/caché y latencia. Aplicar tarifas verificadas y fechadas; incluir alojamiento, almacenamiento y operación para el coste completo. Coste por correo = gasto variable del periodo / correos recibidos; coste por operación = gasto variable / altas y actualizaciones completadas. Denominador cero se informa como no calculable. Una comparación manual/asistida mide minutos humanos por casos equivalentes; la latencia del modelo no demuestra ahorro de trabajo.
- **Dependencias** (exactas): `@langchain/langgraph` (estado y orquestación), `@langchain/core` (mensajes y contratos), `@langchain/anthropic` (proveedor), `langsmith` (control explícito de trazas; envío desactivado), `zod` (validación de argumentos de herramientas), `typescript` y `@types/node` (solo typecheck). Nada más.
- **Prompt caching**: no implementado (sin `cache_control` en `src/`). Se evaluaría sobre el system prompt si el costo medido lo justifica.

## 5. Estrategia de extracción

- **Determinista primero**: expresiones regulares por cláusula (partes, OBJETO, VALOR, PLAZO, GARANTÍAS) y el bloque de "Entre …" para identificar a la parte que no es Periferia.
- **Partes**: Periferia se reconoce por su NIT. El cliente es la otra parte. El país sale del identificador o del domicilio del cliente, nunca del domicilio de Periferia.
- **Valor**: se toma del importe numérico de la cláusula VALOR, con moneda y separadores normalizados. No se implementa una conversión general de cantidades escritas en letras. Valor por demanda se propone como 0 con confianza 0.5; una ausencia real conserva confianza 0 y sale como `null`.
- **Fechas y plazo**: fechas por el número entre paréntesis ("primero (1) de agosto de 2026"). Plazo en meses sin fechas: fin = inicio + N meses.
- **Póliza**: GARANTÍAS define requisito y tipo; un alta con póliza queda pendiente. Un reenvío no degrada una póliza vigente por el valor pendiente derivado del extractor. El otrosí del fixture exige ampliarla y aporta la evidencia para cambiar a pendiente. No hay fechas de vencimiento de pólizas ni verificación automática de firmas.
- **Confianza**: 1.0 explícito · 0.8 inferido acotado · 0.6 calculado · 0.5 indeterminado · 0 ausente (`null`). Un campo con confianza menor que 0.8 entra en `requiere_revision`.
- **Dónde entra el modelo**: explica al usuario lo extraído y conduce la conversación. No decide valores ni confianzas. Los valores registrables salen de las herramientas.

## 6. Regla de gobierno

Propuesta de una página para validar con la organización en B0; los plazos no son acuerdos ni mediciones. En A no se conectan buzones reales, envían acuses ni ejecuta la campaña:

1. **Canal y responsabilidad**: buzón propuesto `contratos@periferia.example`, dirección ficticia que sustituirá la organización. La analista administrativa administra el buzón y es dueña propuesta del maestro; se designa un suplente con acceso y procedimiento de relevo probado. TI mantiene permisos e integración y gerencia responde por cumplimiento y escalamiento. Los comerciales remiten documentos sin necesitar acceso al chat.
2. **Envío completo**: cada comercial envía contratos con y sin póliza, PDF firmado con texto, otrosíes y actas de terminación dentro de un plazo propuesto de 3 días hábiles desde la firma. Asunto: `[CONTRATO|OTROSÍ|TERMINACIÓN] <cliente> - <id>`; indicar NIT/RUC, responsable y contrato relacionado. Si falta id o texto legible, declararlo para revisión sin inventar datos. Conservar original y sus documentos posteriores.
3. **Acuse y estados**: proponer acuse de recepción en 15 minutos con identificador de recepción, documentos recibidos y faltantes. «Recibido» no significa «registrado». Tras validar y, si corresponde, obtener la decisión exacta de la analista, comunicar registro, actualización, duplicado o revisión pendiente con su id y motivo. Un fallo conserva el estado de pendiente y nunca se acusa como registro exitoso. Destinatarios, contenido y permiso de envío se acuerdan antes de habilitar mensajes externos.
4. **Excepciones y escalamiento**: la analista o su suplente solicita la versión firmada/legible cuando falte; no se simula verificación jurídica ni de firma. Valor por demanda, ausencia de valor/plazo y conflicto de identidad pasan a revisión con campos, fuente y propuesta exactos; una confirmación no inventa un dato ausente. Si no se resuelve con el comercial en un plazo propuesto de 5 días hábiles, escalar al responsable comercial designado y gerencia. Asignar responsable, fecha de seguimiento y evidencia de cierre a cada excepción y alerta de póliza.
5. **Campaña junio–agosto 2026**: proponer dos semanas con una lista de contratos por comercial desde el corte 2026-05-30. Facturación aporta el universo de contratos únicos identificables para la misma cohorte y corte; conciliar contra el maestro y los originales, solicitar faltantes con y sin póliza y conservar otrosíes/actas e historial. Facturas sin vínculo identificable quedan en lista de conciliación con responsable, sin excluirlas silenciosamente. La analista y el suplente verifican el cierre con comercial y gerencia; conservar fecha real de registro y procedencia, sin fingir reconstrucción ya ejecutada.
6. **Indicador mensual**: contratos únicos identificables en facturación con registro válido en el maestro / contratos únicos identificables en facturación, para la misma cohorte y corte. Reportar también los no identificables, las excepciones y el tiempo firma→recepción→registro. Ni clientes ni correos sustituyen al denominador de contratos. No hay línea base ni meta aprobada: fijarla después de conciliar. Gerencia revisa el indicador y el seguimiento de faltantes/pólizas con responsable y suplente.

## 7. Decisiones y trade-offs

| Decisión | Elegido | Alternativa descartada | Por qué |
|---|---|---|---|
| Patrón del agente | Un agente con ciclo acotado y transiciones explícitas LangGraph | Plan-and-Execute | La siguiente acción depende del resultado de `validar`; el grafo puede suspender antes del siguiente efecto para obtener la decisión humana. |
| Qué recibe la herramienta | `mensaje_id`; la herramienta relee el dato del fixture | Pasar el objeto contrato completo desde el modelo | Impide que el modelo invente o redondee un valor. El costo es que el modelo solo opera sobre mensajes existentes. |
| Quién autoriza el registro | Backend: revisión expuesta, operación y valores exactos, huella de fuente/maestro y decisión completa de la persona | Flag `confirmado` decidido por el modelo | El identificador correcto no autoriza texto condicionado o exceptivo. Regresiones del grafo real y revisión independiente focal comprueban la corrección local; el cierre publicado exige las puertas conjuntas. |
| Código interno en español | Nombres de dominio del PRD (lenguaje ubicuo) | Código en inglés | Coincide con el PRD y los fixtures. Inglés queda como roadmap. |
| Extracción de valores | Regex por cláusula | Extracción completa con LLM | Los valores son el dato crítico. Regex es auditable y reproducible; el LLM queda para explicar y conversar. |
| Framework | LangGraph + LangChain + zod | Mantener el bucle propio sobre AI SDK | La pausa y reanudación requieren estado explícito. Se acepta la dependencia para aprovechar checkpoints e interrupts; la autorización e integridad siguen siendo reglas propias. ADR-004. |
| Almacenamiento A | Maestro CSV y archivos en `out/`; rename atómico de cada CSV | Base de datos en esta entrega | Conserva el contrato del reto. No hay transacción conjunta con archivo/historial/procesados. B acuerda autoridad del maestro y prueba transacciones, recuperación y concurrencia. |

## 8. Supuestos

- El PRD no incluye una rúbrica de evaluación; no se asumió ninguna.
- `hoy` es un argumento de la herramienta de alertas, no la fecha del sistema, para que la demo sea reproducible. Se pasa en la demo como `2026-09-03`.
- El inicio propuesto de 006 se infiere de la fecha del correo, con confianza 0.8; no se afirma que esa sea una firma verificada.
- La póliza condicional del mensaje 006 se trata como de cumplimiento; es un supuesto documentado.
- Un otrosí que amplía la póliza deja `estado_poliza = pendiente`.
- Los vencidos van en una sección aparte del reporte de alertas.
- La deduplicación usa NIT + objeto, no solo NIT.
- A2 interpreta RN1 con prioridad para id/valor/fechas iguales; metadatos solos no actualizan. Un otrosí sin cambios efectivos se trata como duplicado. NIT+objeto≥0.9 con otro id requiere decidir explícitamente el destino; una discrepancia de moneda requiere revisar la decisión de conservar la del maestro. Son interpretaciones conservadoras de la ambigüedad RN1/RN2, pendientes de aceptación conjunta.
- Sin id se propone `AUTO-<año>-<secuencia>` para aprobación explícita. La generación depende del maestro; las colisiones se bloquean para corregir identidad. No es una identidad durable de documentos ni una garantía de idempotencia ante reinicios.
- A usa `contrato.txt`/`otrosi.txt` y copia el adjunto disponible; no lee PDF binario. El PDF con texto y procedencia se incorpora en B; escaneados/ilegibles se derivan a atención manual. OCR queda diferido.

## 9. Cobertura

La cobertura de la versión publicada sigue pendiente de revalidación. A1 se verificó en e735094; los cambios locales, las pruebas focales y los resultados de un autor no cierran A12. El bonus `modulo/` reexporta las mismas tools y se genera desde prompt/conocimiento; su paquete final debe verificarse e incluir `src/`, pues no es una carpeta autosuficiente. `contratos_leer_pdf` (P1) no está implementada.

| HU | Historia | Estado | Qué falta para producción |
|---|---|---|---|
| HU-1 | Leer el buzón | Parcial: tools de fixtures; flujo y despliegue final por verificar | Ingesta real autorizada y originales durables |
| HU-2 | Extraer datos con confianza | Parcial: A1 integrada y probada; nueva versión publicada por verificar | PDF nativo con procedencia y corpus representativo; atención manual a ilegibles |
| HU-3 | Validar y clasificar | Parcial: A2 implementada, con revisión independiente y aceptación conjunta pendientes | Identidad contractual, conciliación y evals de falsos limpios |
| HU-4 | Registrar y archivar | Parcial: gate local corregido y revisión focal; registro/archivo e integración por cerrar | Autoridad del maestro, identidad, transacciones, recuperación y efectos remotos reconciliables |
| HU-5 | Alertar | Parcial: reporte de fixtures; verificar reporte final tras confirmar 006 | Responsables, evidencia y seguimiento de alertas; fechas de póliza si se requieren |
| HU-6 | Manejo de errores | Parcial: regresiones de herramientas/proveedor simulado; integración y prueba real pendientes | Monitoreo, límites durables, recuperación probada y soporte operativo |

## 10. Uso de IA

**Asistentes usados para construir**: Claude Code (modelos Haiku, Sonnet y Opus, según la tarea) para el scaffold, el núcleo de dominio, el agente, la interfaz, la documentación y la revisión final. Gemini se usó para una primera propuesta de arquitectura.

Codex interviene en la migración LangGraph, reglas de clasificación, pruebas adversariales y sincronización documental. La tabla siguiente conserva decisiones de la primera entrega AI SDK; sus firmas no describen el adaptador LangChain actual.

**Lo que se descartó de Gemini y por qué**:

| Propuesta | Evidencia | Decisión |
|---|---|---|
| `generateText` con `maxSteps` | Versión actual del AI SDK usa `stopWhen` | Se usa `stopWhen: stepCountIs(n)` |
| Herramientas con `parameters` | Versión actual usa `inputSchema` | Se usa `inputSchema` |
| Confirmación con flag `confirmado` decidido por el modelo | El agente propone; no autoriza | Gate en código |
| Router como agente que delega | Un router clasifica una vez y se retira | Router por reglas RN1–RN4, sin LLM |
| `contrato: z.any()` | El PRD pide TypeScript sin `any` | Esquema zod `Contrato` |
| Historial en `out/historial.jsonl` | El PRD pide `out/sharepoint/historial.jsonl` | Ruta del PRD |
| Remitente no registrado bloquea | El PRD dice que se reporta pero no bloquea | Advertencia |
| "Periferia es siempre el contratista" | Cierto en los fixtures, frágil como regla | Se identifica por NIT propio |
| Trade-offs en "sección 6" | El PRD los pone en la sección 7 | Numeración del PRD |
| `modulo/` como copia del código | El PRD pide no tener copias divergentes | Generado desde las mismas fuentes con `npm run build:modulo` (bonus hecho) |

**Verificación**: contratos y firmas se contrastan con las versiones exactas instaladas y pruebas; para la migración se verifica LangChain/LangGraph. La revisión independiente intenta refutar el contenido exacto antes de integrar.

### Referentes

Sin citas textuales ni URLs.

| Referente | Dónde se ve en el repo |
|---|---|
| Curso DevTalles agentic-patterns. Labs usados: tool use, ReAct, chaining/gates, HITL. Descartados: plan-and-execute, CodeAct, orchestrator/parallel | Tool use en `src/tools/contratos.ts`; ReAct acotado en `src/agent/run.ts`; gate y HITL por código (§3, §7) |
| Anthropic, "Building effective agents" (2024) | Agente simple con herramientas y gate antes que framework multiagente (§7) |
| Yao et al., "ReAct" (2022) | Bucle observar/actuar con tope de 25 pasos (§3) |
| OWASP Top 10 for LLM Applications | Prompt injection tratada como dato, sin herramientas de borrado ni shell, topes de costo (§11) |
| Cockburn, Hexagonal | Adaptador de proveedor en `src/llm/adapter.ts`; herramientas como puertos |
| Nygard, Release It! | Topes y timeouts inspirados en su enfoque de estabilidad: pasos, tokens, rate limit, `/api/health`, degradación de errores (§3, §11) |

## 11. Riesgos en producción

| Riesgo | Mitigación prevista |
|---|---|
| Prompt injection desde correos o contratos | El contenido se trata como dato. Los valores y el gate están en código. No hay herramientas de borrado ni de shell. |
| Fuga de la clave de proveedor | Errores redactados, `.env` fuera de la imagen, `/api/health` sin secretos. |
| Abuso de coste del link | Pasos, herramientas, salida, tiempo, tokens por sesión/día y reservas concurrentes en el proceso; consumo desconocido se señala y reserva conservadoramente. `ACCESS_KEY` y rate limit acotan la demo; comprobar también presupuesto en el proveedor. B exige límites persistentes y concurrencia probados. |
| Despliegue de demo | Render Free: disco efímero (el estado se pierde al reiniciar) y se duerme por inactividad. Es una demo, no producción; ver `docs/RUNBOOK.md`. En producción: base de datos y sesiones fuera de memoria. |
| Escritura concurrente o fallo entre artefactos | Rename atómico del CSV no hace atómicos contrato, archivo, historial y procesados. En B acordar autoridad y probar transacción, idempotencia y recuperación; si Excel sigue como autoridad, exigir escritor único, versiones y reconciliación antes de habilitarlo. |
| Path traversal o CSV injection | Identificadores validados con regex, rutas dentro de `out/`, prefijo `'` en celdas que empiezan con `= + - @`. |
| Colisión o identidad contractual ambigua | Comparación por id y NIT+objeto≥0.9, revisión de cliente/NIT/objeto incompatible, destino explícito y bloqueo de candidatos múltiples. Son reglas de fixtures, no una precisión real acreditada. |
| Escaneados o documentos ilegibles | Cola manual en el piloto inicial; OCR requiere experimento separado autorizado. |
| El modelo redondea un valor o infiere una fecha | El valor registrado sale de la herramienta; el modelo solo propone y la persona confirma. |
| Pregunta abierta: dueño del maestro sin área legal | Queda fijado en la regla de gobierno (§6): la analista administrativa. |
| Datos personales en correos y contratos | Minimizar lo que se guarda en logs; definir retención. |
| Coste del modelo | Medición pendiente para LangGraph y modelo efectivo; no convertir la referencia histórica de tokens en USD actuales ni en ROI. |
| Rotación de claves | Clave en variable de entorno del proveedor de hosting; rotación periódica. |
