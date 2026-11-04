# Registro de Contratos Vigentes — agente de chat

Agente conversacional que lee el buzón de contratos, extrae los datos, valida contra el maestro, registra lo que puede y pide confirmación humana para lo dudoso. Detalle de decisiones en [SOLUCION.md](SOLUCION.md).

## Link de prueba

- Chat: `<URL_PUBLICA>`
- Salud del servicio: `<URL_PUBLICA>/api/health`
- Clave de acceso: si el servidor tiene `ACCESS_KEY` configurada, la pantalla la pide. Valor: `<ACCESS_KEY>`

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
| `HOY` | No | Fecha de referencia `YYYY-MM-DD` para alertas. Ejemplo: `2026-09-03`. |

## Demo sin modelo

```bash
node demo.ts
```

Procesa los 6 mensajes del buzón llamando a las herramientas directamente, sin modelo ni clave. Deja la salida en `out/` y muestra una tabla por mensaje. El mensaje 006 queda sin registrar hasta una segunda pasada con confirmación.

Pruebas:

```bash
npm test
npm run typecheck
```

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | Envía `{ sessionId?, message }`. Devuelve la respuesta, las llamadas a herramientas y, si hace falta, `needsConfirmation`. |
| `GET` | `/api/sessions/:id` | Historial de la sesión y confirmación pendiente. 404 si la sesión no existe. |
| `GET` | `/api/health` | Estado del servicio, proveedor y modelo. No expone secretos. |

Las confirmaciones se envían por `POST /api/chat` como texto ("confirmo …" o "rechazo …"); el botón de la interfaz hace lo mismo.

## Estructura

- `agent/prompt.md`: comportamiento del agente.
- `src/knowledge/registro-contratos.md`: reglas de negocio y gobierno del proceso.
- `src/tools/`: herramientas `contratos_*`.
- `src/domain/`, `src/infra/`: lógica de extracción, validación y archivos.
- `web/`: interfaz de chat.
- `fixtures/`: datos de entrada, solo lectura.
- `out/`: salida generada (maestro, archivos, historial, alertas, log).
