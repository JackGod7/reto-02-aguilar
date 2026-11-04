# Registro de Contratos Vigentes — agente de chat

Agente conversacional que lee el buzón de contratos, extrae los datos, valida contra el maestro, registra lo que puede y pide confirmación humana para lo dudoso. Solución y decisiones en [SOLUCION.md](SOLUCION.md); estrategia de producto, roadmap y caso de negocio en [docs/PRODUCTO.md](docs/PRODUCTO.md).

## Link de prueba

- Chat: [reto-02-aguilar.onrender.com](https://reto-02-aguilar.onrender.com).
- Salud del servicio: [GET /api/health](https://reto-02-aguilar.onrender.com/api/health).
- Clave de acceso de la demo (PRD §6.1): `ia-generativa-reto-2026.=.`. La pantalla la pide la primera vez. Es una clave de acceso al ejemplo público; la clave del proveedor permanece en el backend.

La migración local a LangGraph sigue en integración, sin commit ni despliegue. La revisión focal independiente de A3/A4-P0 pasó 36/36; A2 y las puertas conjuntas siguen en revisión. No atribuir a la URL el código de este checkout hasta contrastar el SHA desplegado y una conversación. Configuración Render comprobada por MCP: servicio `srv-dbla0hqjnfac73fblb6g`, plan Free, rama `main`, despliegue automático. El coste actual en USD y el arranque en máquina limpia aún requieren medición.

## Requisitos

- Node.js 24 o superior (TypeScript nativo, sin compilar ni Bun).

## Arranque local

```bash
npm ci && npm run dev
```

Abre `http://localhost:3000`. Para el chat necesitas una clave de Anthropic en `.env` (ver variables abajo).

## Variables de entorno

Copia `.env.example` a `.env` y completa los valores. Nunca commitees `.env`.

| Variable | Obligatoria | Descripción |
|---|---|---|
| `ANTHROPIC_API_KEY` | Sí, para el chat | Clave del proveedor. No se usa en `demo.ts`. |
| `LLM_PROVIDER` | No | Proveedor. Por defecto `anthropic`. |
| `LLM_MODEL` | No | Modelo. Por defecto `claude-haiku-5-5`. |
| `MAX_STEPS` | No | Máximo de llamadas al modelo por turno (25). |
| `MAX_TOOL_CALLS` | No | Máximo de herramientas por turno (100). |
| `LLM_TIMEOUT_MS` | No | Presupuesto temporal del turno (60000 ms). |
| `LLM_MAX_OUTPUT_TOKENS` | No | Techo de salida por llamada (4096). |
| `MAX_SESSION_TOKENS` | No | Tope de tokens por sesión. Por defecto `200000`. |
| `ACCESS_KEY` | No | Si se define, el chat y la API la exigen en el encabezado `x-access-key`. |
| `PORT` | No | Puerto del servidor. Por defecto `3000`. |
| `MAX_DAILY_TOKENS` | No | Tope diario global de tokens (día UTC). Por defecto `2000000`; al superarlo responde 429. |
| `TRUST_PROXY` | No | `1` usa `x-forwarded-for` para el rate limit. Se activa solo si existe `RENDER`. |
| `HOY` | No | Fecha de referencia `YYYY-MM-DD` para alertas. Ejemplo: `2026-09-03`. |
| `LANGSMITH_TRACING` | No | `false` en el ejemplo; el código desactiva las trazas externas incluso si una variable heredada las habilita. |
| `BUILD_SHA` | No | SHA de 40 caracteres para identificar un build fuera de Render; en Render se usa `RENDER_GIT_COMMIT`. Sin SHA válido, health informa `desconocido`. |

## Demo sin modelo

```bash
node demo.ts
```

Limpia `out/` y procesa los 6 mensajes llamando a las herramientas directamente, sin modelo ni clave. Muestra una primera pasada que deja 006 pendiente y una segunda llamada con `confirmado:true` como simulación explícita de la decisión humana. Ejecutarla solo sobre datos de demo que se puedan borrar.

Pruebas (el resultado vigente se registra en `plan/CONTINUAR.md` local):

```bash
npm test
npm run typecheck
npm run build:modulo   # regenera modulo/ (bonus) desde agent/prompt.md y src/knowledge/
```

## Dónde vive el ciclo

`src/agent/run.ts` dirige el proveedor del servidor a `src/agent/graph.ts`. LangGraph controla los nodos modelo, herramienta, revisión, interrupt y reanudación con Command. LangChain ChatAnthropic realiza una sola invocación por paso y nunca ejecuta herramientas. El backend verifica la aprobación contra el snapshot mostrado. ADR vigente: [ADR-004](docs/adr/004-langgraph-orquestacion.md).

Los checkpoints de esta entrega usan MemorySaver: conservan la pausa dentro del proceso y se pierden al reiniciarlo. El piloto requiere checkpointer durable, identidad y recuperación probados. LangSmith externo está desactivado explícitamente; disponer del SDK no implica estar enviando trazas.

La URL pública puede seguir ejecutando la versión anterior hasta verificar y publicar la migración; health por sí solo no acredita qué motor está desplegado.

Sin streaming: la respuesta llega completa; el indicador 'pensando…' cubre la espera.

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/sessions` | Crea una sesión antes del primer envío y devuelve `sessionId`. |
| `POST` | `/api/chat` | Envía `{ sessionId?, message, requestId? }`; `requestId` es un UUID ligado a una sesión ya creada. Devuelve respuesta, llamadas, consumo y `needsConfirmation` si hace falta. |
| `GET` | `/api/sessions/:id` | Historial, revisión pendiente y estado de peticiones de la sesión. 404 si ya no existe. |
| `POST` | `/api/reset` | Borra el contenido de `out/` y las sesiones en memoria. 403 si el servidor no tiene `ACCESS_KEY`, 401 si la clave es incorrecta, 409 si hay turnos en curso. |
| `GET` | `/api/health` | Estado, proveedor/modelo, `buildSha`, persistencia del proceso y trazas desactivadas. |

Los botones envían `confirmo revisión <reviewId>` o `rechazo revisión <reviewId>` para la propuesta mostrada. La gramática consume el mensaje completo: añadir condiciones, excepciones o cambios exige aclaración. También se conserva el ejemplo textual del PRD para 006. Una respuesta perdida se recupera usando la misma sesión y el mismo `requestId` y mensaje; cambiar el contenido con ese identificador devuelve conflicto. La deduplicación de peticiones dura lo que dure el proceso.

Para preparar una demostración desde cero, el operador puede usar `/api/reset` con `x-access-key` cuando no haya turnos activos. Borra datos de demo y sesiones; no se usa como recuperación de un fallo del proveedor. Véase [RUNBOOK](docs/RUNBOOK.md).

## Estructura

- `agent/prompt.md`: comportamiento del agente.
- `src/knowledge/registro-contratos.md`: reglas de negocio y gobierno del proceso (se inyecta en el system prompt).
- `src/tools/`: herramientas `contratos_*`.
- `src/domain/`, `src/infra/`: lógica de extracción, validación y archivos.
- `docs/`: `PRODUCTO.md` (estrategia, roadmap, backlog, caso de negocio, UX), `adr/` (decisiones de arquitectura), `RUNBOOK.md` (operación).
- `web/`: interfaz de chat.
- `modulo/`: agente empaquetado como módulo reutilizable (bonus), generado con `npm run build:modulo`.
- `fixtures/`: datos de entrada, solo lectura.
- `out/`: salida generada (maestro, archivos, historial, alertas, log).

## Prompt de demo (PRD §11)

En una sesión nueva del chat:

```
Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que
esté limpio, muéstrame lo que requiere revisión campo por campo y termina
con el reporte de alertas. No registres nada dudoso sin preguntarme.
```

Cuando se muestre la revisión única de 006, responde `confirmo el valor 0 y la fecha fin 2027-08-31`. La aceptación exige registrar exactamente esos valores y completar el reporte. El resultado del despliegue actual debe verificarse durante la entrega.

Demo sin modelo tras instalar: `node demo.ts`. El runtime autorizado es Node con TypeScript nativo.

## Flujo de trabajo

Trabajo de integración en `codex/langgraph-reto`; solo el coordinador integra y publica tras revisión independiente, typecheck, suite completa, demo dos veces e inspección de fixtures/secretos. Un push a `main` despliega automáticamente en el servicio verificado. La versión entregada sigue congelada en el tag `entrega-2026-11-03`; `release/ai-sdk-referencia` conserva e735094. El piloto B exige identidad, persistencia durable, integridad y recuperación probadas antes de admitir datos reales.
