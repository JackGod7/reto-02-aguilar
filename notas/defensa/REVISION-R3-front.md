# Revisión R3 — prueba manual del front (solo lectura)

Fecha: 2026-11-03 · Servidor: `src/server.ts` en `localhost:3999` · Navegador integrado.

## Veredicto

Sin bloqueantes P0/P1. El flujo principal funciona de extremo a extremo: envío, "pensando…", tool calls colapsables, panel ámbar, Aprobar, restauración de sesión y recuperación tras reinicio. Un hallazgo P2 de legibilidad (markdown sin renderizar).

## Método

- Servidor arrancado contra una copia de `fixtures/` y `out/` vacío en `$TMPDIR`-equivalente (scratchpad), para no tocar el `out/` del repo. Web y `.env` del repo. El bind necesitó sandbox desactivado (EPERM con sandbox).
- Llamadas al modelo: **2** (límite cumplido): (1) PRD §11 hasta msg-006; (2) Aprobar en el panel.
- Repo: no se editó nada ni se hizo commit. Único archivo escrito: este informe.
- Servidor detenido al final; `curl localhost:3999/api/health` no responde.

## Resultados por punto

| Punto | Resultado | Evidencia |
|---|---|---|
| Carga sin errores / CSP | OK. La UI renderiza (scripts y estilos inline ejecutan bajo la CSP nueva). Cabecera `content-security-policy` presente en `/`. | Snapshot de página; `curl -I /` |
| Consola | No concluyente: `read_console_messages` devolvió "No console logs" incluso tras recargar. No se detectó ningún bloqueo visible. | — |
| Envío de mensaje | OK | Burbuja "Tú" con el texto del PRD §11 |
| Indicador "pensando…" | OK | `01-pensando.jpg` |
| Tool calls visibles y colapsables | OK. 18 `details.tool`; al expandir una, `open` pasa a `true` y muestra `Args`/`Resumen`. | DOM vía JS, `02-panel-ambar.jpg` |
| Panel ámbar msg-006 | OK. Tabla campo/valor/confianza/motivo (valor 0 · 50%; fecha_fin 2027-08-31 · 60%) + Aprobar/Rechazar. | `02-panel-ambar.jpg` |
| Aprobar | OK. Botones se deshabilitan, muestra "Enviado: aprobado"; el modelo confirma CM-2026-03 registrado. | `03-aprobado.jpg` |
| Restaurar sesión viva al recargar | OK. 2 mensajes de usuario y 18 tool calls restaurados (sin llamada al modelo). | DOM vía JS |
| Recuperación tras reinicio | OK. Tras reiniciar el servidor, `GET /api/sessions/:id` → 404 `session_not_found`; el front muestra "La sesión expiró (el servicio se reinició); empecé una nueva.", limpia localStorage y muestra bienvenida. | `04-recuperacion.jpg` |

## Hallazgos

### P2 — Markdown del asistente sin renderizar
- Síntoma: en la respuesta final aparecen literalmente `**Pregunta pendiente (msg-006):**`, `**Pendiente de tu confirmación**`, `| Campo | Valor propuesto |…` (tablas como líneas de pipes) y `- ` como texto.
- Efecto: la tabla "por mensaje" que pide el PRD §11 se lee mal en la demo.
- Sugerencia: renderizar un subconjunto de markdown seguro (negrita, listas, tablas) con escape previo de HTML; o, mínimo, `white-space: pre-wrap` no basta para tablas.

### P2 — Texto de confirmación duplicado
- La pregunta de msg-006 aparece en el texto del asistente y otra vez en el panel ámbar. Aceptable, pero ocupa espacio en móvil. No verificado a 375px.

### Observación (no del front)
- `out/` del repo tiene archivos modificados a las 22:18 (`alertas.md`, `log.jsonl`, `procesados.json`, `sharepoint/`). Mi servidor escribió solo en la copia de scratchpad, así que ese cambio no lo causé yo; probablemente otra sesión activa. Revisar antes de la entrega.

## Limitaciones no cubiertas
- No se probó el reintento automático de `sendMessage` con sesión caducada durante un envío (requeriría una llamada extra al modelo; fuera del presupuesto de 2).
- No se probó a ancho móvil ni la consola del navegador con captura real de errores CSP.

## Capturas (scratchpad)
- `/private/tmp/claude-501/-Users-jackaguilar-reto-periferia-ia/dd8ecb0c-f94e-4a36-b6cb-e98a123588a3/scratchpad/capturas/01-pensando.jpg`
- `/private/tmp/claude-501/-Users-jackaguilar-reto-periferia-ia/dd8ecb0c-f94e-4a36-b6cb-e98a123588a3/scratchpad/capturas/02-panel-ambar.jpg`
- `/private/tmp/claude-501/-Users-jackaguilar-reto-periferia-ia/dd8ecb0c-f94e-4a36-b6cb-e98a123588a3/scratchpad/capturas/03-aprobado.jpg`
- `/private/tmp/claude-501/-Users-jackaguilar-reto-periferia-ia/dd8ecb0c-f94e-4a36-b6cb-e98a123588a3/scratchpad/capturas/04-recuperacion.jpg`
