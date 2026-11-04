# Registro de Contratos Vigentes — agente de chat

Agente conversacional que lee el buzón de contratos, extrae los datos, valida contra el maestro, registra lo que puede y pide confirmación humana para lo dudoso. Solución y decisiones en [SOLUCION.md](SOLUCION.md); estrategia de producto, roadmap y caso de negocio en [docs/PRODUCTO.md](docs/PRODUCTO.md).

## Link de prueba

- Chat: `https://reto-02-aguilar.onrender.com`
- Salud del servicio: `https://reto-02-aguilar.onrender.com/api/health`
- Clave de acceso: si el servidor tiene `ACCESS_KEY` configurada, la pantalla la pide. La instancia desplegada la tiene activa; el valor se entrega por el hilo de correo.

## Requisitos

- Node.js 24 o superior (TypeScript nativo, sin compilar ni Bun).

## Arranque local

```bash
npm install && npm run dev
```

Abre `http://localhost:3000`. Para el chat necesitas una clave de Anthropic en `.env` (ver variables abajo).

## Variables de entorno

Copia `.env.example` a `.env` y completa los valores. Nunca commitees `.env`.

| Variable | Obligatoria | Descripción |
|---|---|---|
| `ANTHROPIC_API_KEY` | Sí, para el chat | Clave del proveedor. No se usa en `demo.ts`. |
| `LLM_PROVIDER` | No | Proveedor. Por defecto `anthropic`. |
| `LLM_MODEL` | No | Modelo. Por defecto `claude-haiku-5-5`. |
| `MAX_SESSION_TOKENS` | No | Tope de tokens por sesión. Por defecto `200000`. |
| `ACCESS_KEY` | No | Si se define, el chat y la API la exigen en el encabezado `x-access-key`. |
| `PORT` | No | Puerto del servidor. Por defecto `3000`. |
| `MAX_DAILY_TOKENS` | No | Tope diario global de tokens (día UTC). Por defecto `2000000`; al superarlo responde 429. |
| `TRUST_PROXY` | No | `1` usa `x-forwarded-for` para el rate limit. Se activa solo si existe `RENDER`. |
| `HOY` | No | Fecha de referencia `YYYY-MM-DD` para alertas. Ejemplo: `2026-09-03`. |

## Demo sin modelo

```bash
node demo.ts
```

Procesa los 6 mensajes del buzón llamando a las herramientas directamente, sin modelo ni clave. Deja la salida en `out/` y muestra una tabla por mensaje. El mensaje 006 queda sin registrar hasta una segunda pasada con confirmación.

Pruebas (38/38 el 2026-11-03):

```bash
npm test
npm run typecheck
npm run build:modulo   # regenera modulo/ (bonus) desde agent/prompt.md y src/knowledge/
```

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | Envía `{ sessionId?, message }`. Devuelve la respuesta, las llamadas a herramientas y, si hace falta, `needsConfirmation`. |
| `GET` | `/api/sessions/:id` | Historial de la sesión y confirmación pendiente. 404 si la sesión no existe. |
| `POST` | `/api/reset` | Borra el contenido de `out/` y las sesiones en memoria. 403 si el servidor no tiene `ACCESS_KEY`, 401 si la clave es incorrecta, 409 si hay turnos en curso. |
| `GET` | `/api/health` | Estado del servicio, proveedor y modelo. No expone secretos. |

Las confirmaciones se envían por `POST /api/chat` como texto ("confirmo …" o "rechazo …"); el botón de la interfaz hace lo mismo.

Antes de una demo conviene llamar a `/api/reset` (con `x-access-key`) para partir de un estado limpio, por ejemplo `curl -X POST -H "x-access-key: $ACCESS_KEY" https://reto-02-aguilar.onrender.com/api/reset`.

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
