> Actualización: este documento contiene la referencia operativa de la etapa AI SDK. La migración Node + LangGraph se define en ADR-004; los recuentos y mediciones históricos deben revalidarse. MemorySaver no proporciona recuperación ante reinicios ni acredita operación productiva.

# RUNBOOK — Operar la demo en producción

Servicio: https://reto-02-aguilar.onrender.com (Render Free, Docker, usuario no root). `ACCESS_KEY` está activa en el despliegue: las rutas `/api/*` (salvo `/api/health`) exigen la cabecera `x-access-key`, y sin ella `/api/reset` responde 403.

## 1. Antes de la demo
1. **Despertar** (Free duerme por inactividad): abrir `GET /api/health` 2-3 min antes. Debe responder `{"ok":true,"provider":...,"model":...}`. El primer arranque en frío puede tardar; reintentar.
2. **Reiniciar el estado**: `POST /api/reset` con `x-access-key: <ACCESS_KEY>`:
   `curl -X POST -H "x-access-key: $ACCESS_KEY" https://reto-02-aguilar.onrender.com/api/reset`
   Borra el contenido de `out/` (el maestro se recopia desde `fixtures/`) y las sesiones en memoria. Responde 409 si hay sesiones procesando (esperar y reintentar). Alternativa: reiniciar el servicio en Render.
3. Probar un caso corto en el chat para confirmar que el modelo responde (consume tokens).

## 2. Clave y gasto
- **Rotar `ANTHROPIC_API_KEY`**: crear clave nueva en Anthropic Console, actualizarla en Render > Environment (el servicio redespliega), verificar con `/api/health` y un chat, y revocar la anterior. Nunca pegarla en chat, logs ni repo. Igual para `ACCESS_KEY`.
- **Límite de gasto**: fijarlo en Anthropic Console (límite mensual del workspace/organización) antes de exponer la URL. Es la única barrera externa; los topes del servidor son la interna.
- Topes en código: `MAX_SESSION_TOKENS` (200.000 por defecto), `MAX_DAILY_TOKENS` (2.000.000 por día UTC, global), rate limit por IP. Referencia medida: ~53.358 tokens por lote de 6 correos, es decir, unos 37 lotes al día antes de tocar el tope diario (2.000.000 / 53.358, orden de magnitud).

## 3. Qué mirar en logs (Render > Logs)
- El servidor imprime solo `Servidor en :<puerto>` al arrancar. Los eventos de negocio van al archivo `out/log.jsonl` (auditoría), **no** a stdout, así que no aparecen en Render. Para verlos, Render Shell no existe en Free: pedir el estado por la web/`/api/sessions/:id`.
- Respuestas HTTP a vigilar: 401 (clave), 429 (`rate_limited`, `token_limit`, `daily_token_limit`), 409 (`busy`), 500 (`reset_failed`).
- Siguiente paso (no hecho): log estructurado a stdout para verlo en Render.

## 4. Fallos típicos
| Síntoma | Causa probable | Respuesta |
|---|---|---|
| Primera petición muy lenta o 502 | Servicio dormido | Esperar 1-2 min, reintentar `/api/health`. |
| 401 `unauthorized` | Falta o es incorrecta `x-access-key` | Enviar la clave correcta. |
| 403 en `/api/reset` | `ACCESS_KEY` no configurada | Configurarla en Render o reiniciar el servicio. |
| 429 `daily_token_limit` | Tope global diario | Esperar al día UTC siguiente o subir `MAX_DAILY_TOKENS` conscientemente. |
| 429 `token_limit` | Sesión llena | Iniciar sesión nueva. |
| El agente contesta con error del proveedor | Clave inválida/sin saldo/límite de gasto | Revisar Console; rotar o subir límite. La sesión sigue viva. |
| Datos de la demo "desaparecieron" | Disco efímero de Free tras reinicio | Esperado; repetir el lote. |
| Plan B si falla el modelo o la red | n/a | `node demo.ts` corre el flujo sin modelo. |
