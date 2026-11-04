# SOLUCION — Registro de Contratos Vigentes

> Estado: en construcción. Este documento describe el diseño y lo que se implementa. La cobertura de cada historia de usuario se verifica en la integración final (M7) y hasta entonces figura como pendiente de verificar.

## 1. Problema

El maestro de contratos vigentes está congelado desde el corte de 2026-05-30: los contratos nuevos no se registran y no se sabe qué vence ni qué pólizas faltan. Le duele a la analista administrativa, dueña del maestro, y a gerencia, que no tiene visibilidad de vencimientos ni de garantías pendientes.

## 2. Arquitectura

```
Navegador (web/)
   │  POST /api/chat · GET /api/sessions/:id · GET /api/health
   ▼
Servidor node:http (src/server.ts)
   │  rate limit · ACCESS_KEY · tamaños · sesiones en memoria
   ▼
Agente (src/agent/)  ── system prompt: agent/prompt.md
   │  bucle de herramientas (AI SDK) · tope de 25 pasos · tope de tokens · timeout
   │  conocimiento: src/knowledge/registro-contratos.md
   ▼
Herramientas contratos_* (src/tools/contratos.ts)
   │  leer_buzon · extraer · validar · registrar · alertas
   ▼
Dominio e infraestructura (src/domain/, src/infra/)
   ├── lectura: fixtures/reto-02/ (solo lectura)
   └── escritura: out/ (maestro CSV, archivos de contratos, historial, procesados, log, alertas)
```

- **Dónde vive cada cosa**: el comportamiento del agente está en `agent/prompt.md`. Las reglas de negocio están en `src/knowledge/` y, como código, en `src/domain/`. La ejecución está en `src/tools/`.
- **Proveedor**: interfaz propia en `src/llm/adapter.ts`, con implementación para Anthropic. Cambiar de proveedor no toca las herramientas.
- **Herramientas por `mensaje_id`**: el modelo elige *qué* mensaje procesar; los valores los leen las herramientas del fixture. El modelo no puede inventar un valor registrable.

## 3. Ciclo del agente

- Bucle de herramientas con `stopWhen: stepCountIs(25)`: tope de 25 pasos por turno.
- Tope de tokens por sesión (`MAX_SESSION_TOKENS`, 200000 por defecto), tope de 2000 caracteres por mensaje, rate limit por IP y timeout de 60 s por llamada al modelo.
- **Confirmación humana en código**: `contratos_registrar` sin `confirmado` se detiene si hay campos en revisión y devuelve `revision[]`. El servidor arma la pregunta de confirmación a partir de ese resultado, no del texto del modelo. Solo deja pasar `confirmado: true` si la sesión tiene esa revisión pendiente para ese `mensaje_id` y la persona confirma en su último mensaje.
- Un error de herramienta o del proveedor se explica en lenguaje claro y la sesión sigue viva. Un error en un mensaje no aborta el lote.
- **Roadmap**: migrar la confirmación al mecanismo `toolApproval` del AI SDK. El gate actual ya es código; el cambio sería de integración, no de regla.

## 4. Elección del modelo

- **Proveedor y modelo**: Anthropic, `claude-haiku-5-5` por defecto, configurable con `LLM_MODEL`. Se eligió por soporte fiable de llamadas a herramientas y por costo bajo para un flujo de muchas llamadas cortas.
- **Costo por caso procesado**: `<COSTO>`. Se medirá con tokens reales en la integración final (M7) × precio vigente del proveedor a la fecha de medición. No se estima aquí.
- **Prompt caching**: se evaluará sobre el system prompt si el costo medido lo justifica.

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

1. **Canal único**: un buzón de contratos administrado por la analista administrativa, que es dueña del maestro. (Dirección a definir por Periferia; en el repo se usa como ejemplo ficticio.)
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
| Quién autoriza el registro | Gate en código, según `requiere_revision` | Flag `confirmado` decidido por el modelo | Un modelo puede auto-aprobarse si decide el flag. En código, la condición no depende del texto del modelo. |
| Extracción de valores | Regex por cláusula | Extracción completa con LLM | Los valores son el dato crítico. Regex es auditable y reproducible; el LLM queda para explicar y conversar. |
| Framework | AI SDK + zod | LangChain / LangGraph | Menos capas para un flujo de 5 herramientas. Las dependencias están fijadas en versiones exactas. |
| Almacenamiento | Maestro CSV en `out/`, con escritura atómica | Base de datos | Es lo que pide el PRD y basta para la demo. En producción sería una base con control de concurrencia. |

## 8. Supuestos

- La "rúbrica de la sección 10" mencionada en fuentes no existe en el PRD; no se aplicó.
- `hoy` es un argumento de la herramienta de alertas, no la fecha del sistema, para que la demo sea reproducible. Se pasa en la demo como `2026-09-03`.
- La firma del mensaje 006 es la fecha del correo (dentro de agosto de 2026), con confianza 0.8.
- La póliza condicional del mensaje 006 se trata como de cumplimiento; es un supuesto documentado.
- Un otrosí que amplía la póliza deja `estado_poliza = pendiente`.
- Los vencidos van en una sección aparte del reporte de alertas.
- La deduplicación usa NIT + objeto, no solo NIT.
- Los contratos llegan como PDF con texto. Los escaneados requieren OCR.

## 9. Cobertura

Estado pendiente de verificar en M7 (integración final). Ningún estado se marca como hecho hasta que la prueba de integración lo confirme.

| HU | Historia | Estado | Qué falta para producción |
|---|---|---|---|
| HU-1 | Leer el buzón | Pendiente de verificar en M7 | Lectura real de Exchange/Graph |
| HU-2 | Extraer datos con confianza | Pendiente de verificar en M7 | OCR para escaneados; más variantes de plantilla |
| HU-3 | Validar y clasificar | Pendiente de verificar en M7 | Mapeo de comerciales desde directorio real |
| HU-4 | Registrar y archivar | Pendiente de verificar en M7 | SharePoint real; control de concurrencia |
| HU-5 | Alertar | Pendiente de verificar en M7 | Envío del reporte a gerencia |
| HU-6 | Manejo de errores | Pendiente de verificar en M7 | Monitoreo y alertas técnicas |

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
| `modulo/` como copia del código | El PRD pide no tener copias divergentes | Se generará desde las mismas fuentes (bonus, si da tiempo) |

**Verificación**: las firmas de la API del AI SDK se confirman contra los tipos instalados en `node_modules`, no de memoria.

## 11. Riesgos en producción

| Riesgo | Mitigación prevista |
|---|---|
| Prompt injection desde correos o contratos | El contenido se trata como dato. Los valores y el gate están en código. No hay herramientas de borrado ni de shell. |
| Fuga de la clave de proveedor | Errores redactados, `.env` fuera de la imagen, `/api/health` sin secretos. |
| Abuso de costo del link público | Tope de pasos, tope de tokens por sesión, tamaño de mensaje, rate limit por IP, timeout y `ACCESS_KEY` opcional. |
| Escritura concurrente sobre el maestro | Escritura atómica (archivo temporal + renombrar) y bloqueo. Pendiente en producción con base de datos. |
| Path traversal o CSV injection | Identificadores validados con regex, rutas dentro de `out/`, prefijo `'` en celdas que empiezan con `= + - @`. |
| Nombres de cliente variables que generan duplicados | Deduplicación por NIT + objeto, con revisión humana por encima del umbral. |
| Escaneados sin texto | OCR antes de la extracción. |
| Datos personales en correos y contratos | Minimizar lo que se guarda en logs; definir retención. |
| Costo del modelo | Medición real por caso (`<COSTO>`), tope de tokens y revisión de precios vigentes. |
| Rotación de claves | Clave en variable de entorno del proveedor de hosting; rotación periódica. |
