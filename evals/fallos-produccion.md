# Fallos reales en producción (Render) antes de la migración a LangGraph

Generado: 2026-11-04, solo lectura vía MCP de Render. Servicio `srv-dbla0hqjnfac73fblb6g`.

## Conclusión

**Los logs de Render NO contienen ningún fallo de producción que convertir en caso de evaluación.** No hay evidencia de errores reales; los casos de la sección 4 salen del historial de commits, no de logs, y no deben presentarse como incidentes observados.

## 1. Cobertura de los datos

- El servicio se creó el 2026-11-04 03:02 UTC (primer deploy `dep-dbla0iajnfac73fblckg`). No existen datos del 02/03-nov: el servicio aún no existía.
- Ventana revisada: 2026-11-01 00:00Z → 2026-11-04 07:54Z (deploy de `62eb282`), que cubre toda la vida del servicio. La retención de Render Free no es el límite aquí.
- Limitación real: la app emite casi sin logs de runtime. La única línea de aplicación es `Servidor en :10000` por arranque. No hay request logs ni trazas de turnos en Render. El detalle por turno (`status`, `latencyMs`, `outcome`) va a `out/turnos.jsonl`, que vive en disco efímero y se pierde en cada deploy/reinicio. Por eso un fallo de proveedor o de tool pasado no sería visible aquí aunque hubiera ocurrido.

## 2. Resultados de la búsqueda

| Búsqueda (todo el rango) | Resultado |
|---|---|
| Nivel error / warn / fatal | 0 líneas |
| Request logs (cualquier estado, incluidos 5xx) | 0 líneas |
| Texto `llm_error`, `timeout`, `429`, `rate limit`, `exception`, `TypeError`, `ECONN`, `max_steps`, `tope`, `unhandled`, `killed`, `heap`, `SIGTERM` | 0 líneas |
| Eventos `server_failed`, `server_restarted`, `image_pull_failed`, `server_hardware_failure` | 0 eventos |

Reinicios: solo arranques "Servidor en :10000" sin evento de falla asociado (4 el 2026-11-04 entre 04:38 y 07:22 UTC, consistentes con suspensión por inactividad de Render Free). No son fallos.

## 3. Deploys

18 deploys (03:02 → 07:54 UTC del 2026-11-04). **0 fallidos**: todos `build_ended`/`deploy_ended` con `succeeded`. 2 manuales (`e16c70d` y `8e8f50d`), el resto por commit. No hay causa de fallo que reportar. El deploy de `62eb282` (LangGraph) tardó 34 s.

## 4. Candidatos a evaluación (derivados de commits `fix`, NO de logs)

Fuente: historial de git en la ventana de despliegue. Son defectos corregidos antes/durante el despliegue, útiles como regresiones. Resultado esperado según PRD §5 (HU-4), §6.3 (CA1, CA3), RN5. Verificar cada caso contra el PRD antes de fijarlo.

### E1 — `registrar` con argumentos nulos
- Commit: `0a5eaa6` "registrar.execute nunca lanza con args nulos" (2026-11-04 03:31 UTC, deploy `dep-dblae1u7bikc73af5b8g`).
- Síntoma probable: la tool lanzaba excepción si el modelo enviaba `contrato: null`. Violaba la regla "execute nunca lanza".
- Evidencia de log: ninguna.
- Caso: estado inicial = buzón cargado y `msg-001` extraído. Mensaje de usuario: "registra msg-001". Forzar al proveedor a emitir `contratos_registrar {mensaje_id:"msg-001", contrato:null}`.
- Esperado: respuesta `{ok:false,error:...}` en JSON (sin excepción, sin 5xx) y el agente continúa o reporta; PRD §6.2 y reglas de tools.

### E2 — Confirmación humana: gate (CA3 / RN5)
- Commit: `b0cf756` "solo se confirma una revisión vista en un turno previo y nombrada si hay varias".
- Síntoma probable: un "sí / confirmo" ambiguo o una confirmación de una revisión no vista permitía `confirmado:true`. Es el riesgo A4-P0 ya señalado en CLAUDE.md.
- Evidencia de log: ninguna.
- Caso: sesión nueva (sin turno previo). Mensaje: "confirmo el valor 0 y la fecha fin 2027-08-31" antes de procesar el buzón. Segundo caso: con dos revisiones pendientes, mensaje: "confirmo".
- Esperado: no se registra nada (`registrar` rechazado, RN5); el agente pide nombrar el mensaje/revisión.

### E3 — Tope de pasos (CA1)
- Commit: `8e00329` "tope de pasos, gate, id AUTO".
- Síntoma probable: bucle de tools sin tope o respuesta sin informar lo pendiente.
- Evidencia de log: ninguna (nunca se alcanzó el tope en producción; la ejecución real usó 2–3 pasos).
- Caso: adapter simulado que siempre devuelve una tool call. Mensaje: "Procesa el buzón con hoy=2026-09-03".
- Esperado: el turno termina al alcanzar el tope (sugerido 25), con respuesta de "lo que tiene y lo que falta", HTTP 200 y sin gasto adicional.

### E4 — Identificador AUTO y XFF
- Commits: `8e00329` (id AUTO) y `b0cf756` (X-Forwarded-For toma la IP añadida por el proxy).
- Síntoma probable: ids de contrato nuevos mal asignados; límite de uso evadible falsificando `X-Forwarded-For`.
- Evidencia de log: ninguna. Con `TRUST_PROXY` no verificado (el MCP no lista variables).
- Caso A: registrar dos contratos nuevos en la misma sesión; esperado ids consecutivos únicos (`CT-AAAA-NNN`). Caso B: peticiones con `X-Forwarded-For: 1.2.3.4` falso delante de la IP real; esperado límite por la IP añadida por el proxy.

## 5. Recomendación

- Para obtener fallos reales: persistir un log de turnos en stdout (el `turnos.jsonl` ya existe; imprimir cada línea) para que Render lo retenga entre deploys, y repetir esta revisión tras una semana de uso.
- Prueba post-migración del 2026-11-04 (`62eb282`): 2 turnos reales sin errores; no es un fallo, solo línea base.
