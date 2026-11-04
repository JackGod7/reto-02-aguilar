# SOLUCION — Registro de Contratos Vigentes

Estrategia de producto, roadmap, backlog y caso de negocio: [`docs/PRODUCTO.md`](docs/PRODUCTO.md). Decisiones de arquitectura: [`docs/adr/`](docs/adr/). Operación: [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

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
   │  bucle de herramientas (AI SDK) · tope de 25 pasos · tope de tokens · timeout
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
- **Proveedor**: interfaz propia en `src/llm/adapter.ts`, con implementación para Anthropic. Cambiar de proveedor no toca las herramientas.
- **Herramientas por `mensaje_id`**: el modelo elige *qué* mensaje procesar; los valores los leen las herramientas del fixture. El modelo no puede inventar un valor registrable.

## 3. Ciclo del agente

- Bucle de herramientas con `stopWhen: stepCountIs(25)`: tope de 25 pasos por turno.
- Tope de tokens por sesión (`MAX_SESSION_TOKENS`, 200000 por defecto), tope de 2000 caracteres por mensaje, rate limit por IP y timeout de 60 s por llamada al modelo.
- **Confirmación humana en código** (`src/agent/run.ts`):
  - **Gate**: `contratos_registrar` sin `confirmado` se detiene si hay campos en revisión y devuelve `revision[]`. La pregunta de confirmación la arma el servidor a partir de ese resultado, no el modelo.
  - **Confirmación ligada**: `confirmado: true` solo pasa si la revisión de ese `mensaje_id` ya estaba pendiente en un turno previo (la persona la vio), el último mensaje de la persona confirma y, con varias revisiones pendientes, nombra el `mensaje_id`. Los pendientes se guardan por `mensaje_id`. Detectar "confirmo" es una heurística de texto; `toolApproval` la reemplazaría por un evento explícito.
  - **Override acotado**: `contrato` solo se acepta junto con `confirmado: true` y solo para campos que estén en revisión; `contratos_validar` no lo acepta. Cualquier rechazo devuelve `ok:false` sin tocar el maestro.
  - **Evidencia**: `tests/core/gate-adversarial.test.ts` cubre override sin confirmar, override de un campo fuera de la revisión, confirmar en el mismo turno en que se crea la revisión y confirmar sin nombrar el `mensaje_id` con varios pendientes.
- Un error de herramienta o del proveedor se explica en lenguaje claro y la sesión sigue viva. Un error en un mensaje no aborta el lote.
- **Roadmap**: migrar la confirmación al mecanismo `toolApproval` del AI SDK. El gate actual ya es código; el cambio sería de integración, no de regla.

## 4. Elección del modelo

- **Proveedor y modelo**: Anthropic, `claude-haiku-5-5` por defecto, configurable con `LLM_MODEL`. Se eligió por soporte fiable de llamadas a herramientas y por costo bajo para un flujo de muchas llamadas cortas.
- **Costo por caso procesado**: 53.358 tokens por lote completo, medidos en una corrida real con `claude-haiku-5-5` (2026-11-03); costo en USD no calculado porque el precio por token no se verificó. (6 mensajes + confirmación de 006: 39.041 + 14.317 tokens, `usage.tokens`, sin desglose entrada/salida; una sola corrida, no es un promedio.)
- **Prompt caching**: no implementado (sin `cache_control` en `src/`). Se evaluaría sobre el system prompt si el costo medido lo justifica.

## 5. Estrategia de extracción

- **Determinista primero**: expresiones regulares por cláusula (partes, OBJETO, VALOR, PLAZO, GARANTÍAS) y el bloque de "Entre …" para identificar a la parte que no es Periferia.
- **Partes**: Periferia se reconoce por su NIT. El cliente es la otra parte. El país sale del identificador o del domicilio del cliente, nunca del domicilio de Periferia.
- **Valor**: se toma del paréntesis tras la cláusula VALOR, con normalización de separadores. Si falla, se usa el texto en letras como respaldo.
- **Fechas y plazo**: fechas por el número entre paréntesis ("primero (1) de agosto de 2026"). Plazo en meses sin fechas: fin = inicio + N meses.
- **Póliza**: la cláusula GARANTÍAS define si hay póliza y de qué tipo.
- **Confianza**: 1.0 explícito · 0.8 inferido acotado · 0.6 calculado · 0.5 indeterminado · 0 ausente (`null`). Un campo con confianza menor que 0.8 entra en `requiere_revision`.
- **Dónde entra el modelo**: explica al usuario lo extraído y conduce la conversación. No decide valores ni confianzas. Los valores registrables salen de las herramientas.

## 6. Regla de gobierno

Propuesta para que el proceso viva después de la demo. Se resume en una página:

1. **Canal único**: un buzón de contratos administrado por la analista administrativa, que es dueña del maestro. Dirección propuesta: `contratos@periferia.example` (ficticia; la real la define Periferia).
2. **Obligación del comercial**: enviar el PDF firmado, los otrosíes y las actas de terminación en un máximo de 3 días hábiles desde la firma, con asunto `[CONTRATO|OTROSÍ|TERMINACIÓN] <cliente> - <id>`.
3. **Acuse automático**: el agente responde en un máximo de 15 minutos con clasificación, campos dudosos y lo que falta.
4. **Excepciones y escalamiento**: contrato sin firma se devuelve al comercial. Contrato sin valor o plazo claro pasa a revisión humana. Sin respuesta del comercial en 5 días hábiles, se escala al director comercial.
5. **Cierre del gap jun–ago 2026**: campaña de 2 semanas. Cada comercial reenvía sus contratos firmados desde 2026-05-30 y se cruza con facturación para detectar faltantes.
6. **Indicador mensual**: porcentaje de clientes facturados en el mes con contrato vigente en el maestro (meta ≥ 95 %), más el tiempo entre firma y registro.

## 7. Decisiones y trade-offs

| Decisión | Elegido | Alternativa descartada | Por qué |
|---|---|---|---|
| Patrón del agente | ReAct acotado: un agente que observa cada resultado antes de elegir la siguiente acción | Plan-and-Execute | `registrar` depende de lo que devuelve `validar`; un plan fijo no reacciona a esos resultados. |
| Qué recibe la herramienta | `mensaje_id`; la herramienta relee el dato del fixture | Pasar el objeto contrato completo desde el modelo | Impide que el modelo invente o redondee un valor. El costo es que el modelo solo opera sobre mensajes existentes. |
| Quién autoriza el registro | Gate en código, según `requiere_revision`, con confirmación ligada a `mensaje_id` y override limitado a campos en revisión | Flag `confirmado` decidido por el modelo | Un modelo puede auto-aprobarse si decide el flag. En código, la condición no depende del texto del modelo. Se cerró un bypass: el override `contrato` ya no salta el gate (tests adversariales en `tests/core/gate-adversarial.test.ts`). |
| Código interno en español | Nombres de dominio del PRD (lenguaje ubicuo) | Código en inglés | Coincide con el PRD y los fixtures. Inglés queda como roadmap. |
| Extracción de valores | Regex por cláusula | Extracción completa con LLM | Los valores son el dato crítico. Regex es auditable y reproducible; el LLM queda para explicar y conversar. |
| Framework | AI SDK + zod | LangChain / LangGraph | Menos capas para un flujo de 5 herramientas. Las dependencias están fijadas en versiones exactas. |
| Almacenamiento | Maestro CSV en `out/`, con escritura atómica | Base de datos | Es lo que pide el PRD y basta para la demo. En producción sería una base con control de concurrencia. |

## 8. Supuestos

- El PRD no incluye una rúbrica de evaluación; no se asumió ninguna.
- `hoy` es un argumento de la herramienta de alertas, no la fecha del sistema, para que la demo sea reproducible. Se pasa en la demo como `2026-09-03`.
- La firma del mensaje 006 es la fecha del correo (dentro de agosto de 2026), con confianza 0.8.
- La póliza condicional del mensaje 006 se trata como de cumplimiento; es un supuesto documentado.
- Un otrosí que amplía la póliza deja `estado_poliza = pendiente`.
- Los vencidos van en una sección aparte del reporte de alertas.
- La deduplicación usa NIT + objeto, no solo NIT.
- Los contratos llegan como PDF con texto. Los escaneados requieren OCR.

## 9. Cobertura

Verificado en la integración final: `npm test` 38/38 (2026-11-03) y `tsc --noEmit` limpio. Extras: bonus `modulo/` hecho (generado con `npm run build:modulo`, con test). `contratos_leer_pdf` (P1) no se hizo: se asume texto ya extraído. El código interno está en español por decisión (lenguaje ubicuo del PRD); inglés queda como roadmap.

| HU | Historia | Estado | Qué falta para producción |
|---|---|---|---|
| HU-1 | Leer el buzón | Verificado: `leer_buzon` (tests core y demo: 6 mensajes, excluye procesados) | Lectura real de Exchange/Graph |
| HU-2 | Extraer datos con confianza | Verificado: extracción determinista con confianza (tests core: 001, 002, 004, 006 exactos) | OCR para escaneados; más variantes de plantilla |
| HU-3 | Validar y clasificar | Verificado: clasificación nuevo/actualización/duplicado/rechazado en demo y tests (tabla SPEC §4) | Mapeo de comerciales desde directorio real |
| HU-4 | Registrar y archivar | Verificado: registro, CSV, archivo, historial, y gate de 006 con tools reales (`tests/agent/integracion.test.ts`) | SharePoint real; control de concurrencia |
| HU-5 | Alertar | Verificado: `out/alertas.md` con las 3 secciones (demo) | Envío del reporte a gerencia |
| HU-6 | Manejo de errores | Verificado: rechazo de cotización, path traversal, args inválidos, 400/404 (tests); no probado contra errores reales del proveedor | Monitoreo y alertas técnicas |

## 10. Uso de IA

**Asistentes usados para construir**: Claude Code (modelos Haiku, Sonnet y Opus, según la tarea) para el scaffold, el núcleo de dominio, el agente, la interfaz, la documentación y la revisión final. Gemini se usó para una primera propuesta de arquitectura.

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

**Verificación**: las firmas de la API del AI SDK se confirman contra los tipos instalados en `node_modules`, no de memoria.

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
| Abuso de costo del link público | Tope de pasos, tope de tokens por sesión, tope diario global (`MAX_DAILY_TOKENS`, 2.000.000 por defecto, día UTC), máximo de 500 sesiones vivas con TTL de 2 h, tamaño de mensaje, rate limit por IP (con `x-forwarded-for` solo si `TRUST_PROXY=1` o en Render; se toma la última IP, la que añade el proxy), timeout y `ACCESS_KEY` comparada en tiempo constante (opcional en el código; **activa en el despliegue**). `POST /api/reset` queda deshabilitado (403) sin `ACCESS_KEY`. Estáticos con control de ruta y cabeceras CSP, `X-Frame-Options` y `nosniff`. |
| Despliegue de demo | Render Free: disco efímero (el estado se pierde al reiniciar) y se duerme por inactividad. Es una demo, no producción; ver `docs/RUNBOOK.md`. En producción: base de datos y sesiones fuera de memoria. |
| Escritura concurrente sobre el maestro | Escritura atómica (archivo temporal + renombrar). `registrar` es síncrono, así que es atómico dentro de un proceso; no hay mutex ni bloqueo entre procesos. Pendiente en producción con base de datos. |
| Path traversal o CSV injection | Identificadores validados con regex, rutas dentro de `out/`, prefijo `'` en celdas que empiezan con `= + - @`. |
| Nombres de cliente variables que generan duplicados | Deduplicación por NIT + objeto, con revisión humana por encima del umbral. |
| Escaneados sin texto | OCR antes de la extracción. |
| Datos personales en correos y contratos | Minimizar lo que se guarda en logs; definir retención. |
| Costo del modelo | Medición real por caso (≈53 mil tokens/lote; USD sin calcular), tope de tokens y revisión de precios vigentes. |
| Rotación de claves | Clave en variable de entorno del proveedor de hosting; rotación periódica. |
