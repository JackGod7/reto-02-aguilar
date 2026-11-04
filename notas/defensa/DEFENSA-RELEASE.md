# Defensa técnica — release `entrega-2026-11-03` (commit `0a5eaa6`)

Todas las citas `archivo:línea` son del **tag** (`git show entrega-2026-11-03:<ruta>`), no del árbol de trabajo. `PRD:n` = `docs/PRD.md:n` del tag. Criterio de lectura: "el mejor código es el que no se escribe" (PRD:16 pide poder explicar cada línea).

**Verificación hecha** (copia del tag en carpeta temporal, sin tocar el árbol): `npx tsc --noEmit` limpio; `node demo.ts` produce las 7 filas esperadas (001 nuevo, 002 nuevo, 003 actualización, 004 duplicado, 005 rechazado, 006 en revisión → confirmado) y las alertas del SPEC; `node --test`: 47 tests, 33 pasan y 14 fallan **todos** por `listen EPERM` (el sandbox de esta sesión no deja abrir puertos; son los tests que levantan el servidor). El README del tag afirma 47/47 (README:47); no pude reproducir ese 47/47 aquí, solo que los 33 que no abren puerto pasan.

Leyenda de la tabla: ✅ requisito directo · 🟡 requisito indirecto o ampliado más allá de lo pedido · ❌ sin requisito en el PRD · 💀 código muerto.

---

## 1. Trazabilidad archivo → PRD

Total: **2.545 líneas** en los 27 archivos pedidos (más `web/` = 507 de esas).

| Archivo | Qué hace (1 línea) | Requisito (PRD) | Líneas | Marca |
|---|---|---|---|---|
| `package.json` | Manifiesto: 3 deps prod, 2 dev, scripts `test/demo/dev/typecheck/build:modulo` | §8 Dependencias PRD:336; arranque PRD:330; módulo PRD:364-375 | 22 | ✅ |
| `Dockerfile` | Imagen `node:24-slim`, usuario no root, `npm ci --omit=dev`, copia solo lo necesario | Link público PRD:360-362; arranque PRD:330 | 25 | ✅ (HEALTHCHECK `:22-23` ❌: Render ya usa `healthCheckPath`, `render.yaml`) |
| `agent/prompt.md` | System prompt: flujo, reglas "solo afirmas lo que sale de una tool", datos ≠ instrucciones | PRD:164; CA2 PRD:208; HU-6 PRD:135 | 19 | ✅ |
| `demo.ts` | Corre 001→006 llamando `execute` directo; 006 queda pendiente y luego `confirmado:true`; imprime alertas | §6.6 PRD:250-256; determinismo PRD:331; HU-4 PRD:120 | 51 | ✅ |
| `src/server.ts` | `node:http`: `/api/chat`, `/api/sessions/:id`, `/api/health`, estáticos, `ACCESS_KEY`, topes | API PRD:213-221; backend PRD:161; costo PRD:333; auth opcional PRD:166 | 244 | ✅ núcleo; ❌/🟡 ver abajo |
| `src/agent/run.ts` | Turno del agente: gate HITL, tope de pasos, sonda de revisión, respuesta determinista | CA1 PRD:207; CA3 PRD:209; CA4 PRD:210; RN5 PRD:299 | 236 | ✅ |
| `src/agent/registry.ts` | Convierte los exports de `tools/contratos.ts` en `contratos_<export>` y re-valida con zod | Nombre de tool PRD:170; "backend valida antes de ejecutar" PRD:189 | 40 | ✅ (🟡 duplica `ToolContext`, ver §1.2) |
| `src/agent/session.ts` | Mapa en memoria de sesiones (mensajes, pendiente, tokens) | Sesión en memoria o archivo PRD:161,165; `GET /api/sessions/:id` PRD:220 | 56 | ✅ |
| `src/agent/context.ts` | Une `prompt.md` + `knowledge/*.md` en el system prompt, con guarda de ruta | Conocimiento que el agente consulta PRD:237,248; ADR-003 | 32 | ✅ |
| `src/llm/adapter.ts` | Interfaz propia `LLMAdapter.enviar(mensajes, herramientas, opciones)` | PRD:163 | 32 | ✅ |
| `src/llm/anthropic.ts` | Implementa el adaptador con `generateText`, `stopWhen`, timeout 60 s | PRD:163; CA1 PRD:207; robustez PRD:334 | 31 | ✅ |
| `src/tools/contratos.ts` | Las 5 tools zod (`leer_buzon`, `extraer`, `validar`, `registrar`, `alertas`) y su lógica de registro | §6.2 PRD:192-200; HU-1…HU-6; RN7 PRD:301 | 342 | ✅ (🟡 `validar` informativo `:158-171`) |
| `src/domain/extraccion.ts` | Extracción determinista por regex: partes, país, valor, plazo, póliza, confianza por campo | HU-2 PRD:100-106; §7.2 PRD:271-289; msg-006 PRD:312 | 262 | ✅ (🟡 `tituloEs` `:40-53`) |
| `src/domain/reglas.ts` | Clasifica nuevo/actualización/duplicado/rechazado (id, NIT+Jaccard ≥ 0,9) | HU-3 PRD:108-114; RN1–RN4 PRD:295-298 | 65 | ✅ |
| `src/domain/contrato.ts` | Tipos del maestro, `overrideSchema`, umbral 0,8, revisión por confianza | §7.2 PRD:271-289; RN5 PRD:299; override PRD:199 | 87 | ✅ (💀 `contratoSchema` `:11-29` solo se usa como tipo) |
| `src/domain/alertas.ts` | Calcula 3 secciones + vencidos y renderiza `alertas.md` | HU-5 PRD:126-131; O4 PRD:70 | 56 | ✅ |
| `src/domain/fechas.ts` | Fechas en español → ISO, sumas de meses/días | HU-2 PRD:100; `fecha_fin` por meses PRD:282 | 68 | ✅ |
| `src/domain/dinero.ts` | Normaliza montos `265.000.000` / `120,000.00` y extrae moneda | §7.2 `valor` PRD:280; HU-6 "moneda desconocida" PRD:134 | 44 | ✅ |
| `src/domain/csv.ts` | CSV RFC 4180 con prefijo `'` contra inyección de fórmulas | Maestro CSV PRD:76; seguridad PRD:332 (la inyección de fórmulas no se nombra) | 41 | ✅ (el escape de fórmulas es 🟡: 3 líneas) |
| `src/domain/slug.ts` | `slugCliente` para la carpeta `<cliente-slug>` | HU-4 PRD:122 | 11 | ✅ |
| `src/infra/rutas.ts` | `dirs()` y `dentroDe()` (guarda de path traversal) | `ctx.directory` PRD:180; seguridad PRD:332 | 18 | ✅ |
| `src/infra/buzon.ts` | Lista y lee mensajes del buzón; elige el adjunto contrato/otrosí | HU-1 PRD:97; fixtures PRD:264-269 | 53 | ✅ |
| `src/infra/maestro.ts` | Copia el fixture a `out/`, lee y escribe el CSV atómicamente | HU-4 PRD:121; RN6 PRD:300 | 38 | ✅ |
| `src/infra/registros.ts` | `historial.jsonl`, `procesados.json`, `log.jsonl`, escritura de `alertas.md` | HU-4 PRD:123-124; RN7 PRD:301; CA4 PRD:210 | 62 | ✅ |
| `src/infra/archivo.ts` | Copia el adjunto a `Contratos/<año>/<slug>/<id>.<ext>` sin pisar | HU-4 PRD:122 | 32 | ✅ (🟡 versionado `-vN` `:17-26`; ❌ `extDe` `:30-32` envuelve `extname`) |
| `src/knowledge/registro-contratos.md` | Conocimiento del proceso (glosario, RN, confianza, gobierno) | PRD:236-237,248 | 71 | ✅ |
| `web/index.html` | Chat de una página: historial, "pensando", tool calls colapsables, panel de confirmación | Front PRD:160; CA3 PRD:209; CA5 PRD:211 | 507 | ✅ núcleo; ❌ ver abajo |

### 1.1 Lo que NO tiene requisito (❌), con rango exacto

| Qué | Dónde | Líneas | Por qué sobra / qué lo sostiene |
|---|---|---|---|
| `POST /api/reset` | `src/server.ts:159-174` | 16 | El PRD solo pide 3 rutas (PRD:217-221). Existe por conveniencia de demo (`docs/RUNBOOK.md`). Riesgo: la clave que protege es la publicada en README:9, así que cualquiera con el README puede vaciar el estado. |
| Cabeceras de seguridad/CSP | `src/server.ts:37-43` | 7 | PRD:332 pide no filtrar claves, no CSP. Hardening por OWASP (SOLUCION:150). |
| Tabla MIME de 7 tipos | `src/server.ts:27-35` | 8 sobrantes | `web/` es un solo `index.html`; solo se necesita `.html`. |
| Renderer markdown seguro | `web/index.html:231-299` | 69 | El PRD pide mostrar tool calls y resaltar confirmación (PRD:160), no render de tablas. Commit `c6fdfc5`. El mismo resultado sale con `white-space:pre-wrap` (ya está en `.msg`, `:22`). |
| Tema oscuro | `web/index.html:9-12` | 4 | Sin requisito. |
| Recuperar sesión con `localStorage` tras reinicio | `web/index.html:157-165, 454-471` | ~27 | PRD:161 pide "mantiene la sesión" en backend; la recuperación del front es extra (commit `6d3d1e6`, hallazgo de auditoría, no del PRD). |
| `HEALTHCHECK` del Dockerfile | `Dockerfile:22-23` | 2 | `render.yaml` ya define `healthCheckPath: /api/health`. |
| `extDe` (envuelve `extname`) | `src/infra/archivo.ts:30-32` | 3 | Se puede importar `extname` directamente. |
| `ToolContext` duplicado | `src/agent/registry.ts:5-8` vs `src/tools/contratos.ts:21-24` | 4 | Misma interfaz declarada dos veces. |

**Suma ❌: ≈ 140 líneas de 2.545 (5,5 %).** Es la cifra "sin justificación" que reporto; de ella, ~100 están en `web/`.

### 1.2 Requisito indirecto o ampliado (🟡, ≈ 120 líneas)

Se pueden defender, pero el argumento es de criterio, no del PRD:

- **Rate limit, tope diario global, tope de sesiones vivas, TTL, XFF** (`src/server.ts:18-21, 44, 82-129, 156, 187, 195-196`; ≈ 53 líneas). Sostén: PRD:333 "un usuario no puede gastar tu clave sin límite", que habla de tope por sesión y de iteraciones; lo demás es ampliación para un link público.
- **`contratos_validar` con comparación informativa** (`src/tools/contratos.ts:158-171`, 14 líneas). PRD:198 exige el argumento `contrato` pero no dice qué hacer con él. Aquí se compara y se ignora a propósito.
- **`tituloEs`** (`src/domain/extraccion.ts:40-53`, 14 líneas): reproduce la capitalización del maestro del fixture; es consistencia con datos, no PRD.
- **Versionado `-vN` del adjunto** (`src/infra/archivo.ts:17-26`, 10 líneas): evita pisar archivos; el PRD calla.
- **Pantalla de clave** (`web/index.html:379-406`, 28 líneas): PRD:166 solo exige publicar la clave si se protege.
- `MAX_MENSAJE = 2000` (`src/agent/run.ts:6`, `server.ts:185`, `web/index.html:95`): sin requisito; coste acotado.

### 1.3 Código muerto y exports innecesarios (💀)

- `contratoSchema` (`src/domain/contrato.ts:11-29`, 19 líneas): nunca se ejecuta como validador; solo alimenta `type Contrato = z.infer<…>` (`:29`). Un `interface` ahorraría ~3 líneas netas, no 19.
- `Extraccion.referencia` (`src/domain/extraccion.ts:23, 132, 154`): se escribe, nadie la lee (grep en `src/` y `web/`).
- `LLM_PROVIDER`: figura en `.env.example`, `render.yaml` y README:30, pero **ningún archivo de `src/` la lee**. Configuración muerta.
- `valor_indeterminado` (`contrato.ts:18, 68`; `extraccion.ts:182, 244`) no tiene columna en el maestro (`COLUMNAS`, `contrato.ts:3-7`); solo viaja al modelo. PRD:280 la nombra, pero no se persiste.
- **34 `export` sin uso en otros archivos de `src/`** (medido con grep sobre el tag): `CORTE_MAESTRO`, `VENTANA_DIAS`, `ItemAlerta`, `Alertas`, `Override`, `CAMPOS_REVISION`, `UMBRAL`, `escaparCelda`, `parseDinero`, `NIT_PERIFERIA`, `tituloEs`, `iso`, `Clasificacion`, `Diferencias`, `jaccard`, `MensajeLeido`, `rutaMaestro`, `asegurarMaestro`, `EntradaHistorial`, `Ejecutor`, `MAX_PASOS`, `usuarioRechaza`, `usuarioConfirma`, `construirPregunta`, `Decision`, `evaluarConfirmacion`, `resumir`, `RunOpts`, `RunResult`, `StoredMessage`, `ToolDef`, `esquema`, `ServerOpts`, `crearServidor`. Solo una parte los usan los tests (p. ej. `evaluarConfirmacion`, `resumir`, `usuarioConfirma`, `crearServidor`); el resto es `export` gratuito. No cambian el comportamiento, pero obligan a explicar una API pública que no existe.
- **Triple validación de argumentos**: el SDK valida contra `inputSchema` (`src/llm/anthropic.ts:17`), `ejecutarTool` vuelve a validar (`src/agent/registry.ts:34`) y cada `execute` hace `esquema(ARGS).parse` (`src/tools/contratos.ts:109, 132, 155, 281, 330`). Los dos primeros son redundantes con el tercero, que sí es necesario porque `demo.ts` y el módulo llaman a `execute` sin pasar por el registro.
- Fuera del alcance pedido pero en el tag: `modulo/` (3 archivos generados + README) y `scripts/build-modulo.ts` (72 líneas) sostienen el bonus PRD:364-375.

---

## 2. Dependencias (`package.json:13-21`)

| Dependencia | Versión | Para qué | Requisito | Alternativa descartada |
|---|---|---|---|---|
| `ai` | 7.0.162 | Bucle modelo↔herramientas (`generateText`, `stopWhen: stepCountIs`, `tool`) en `src/llm/anthropic.ts:20-27` | PRD:161 (ciclo con tope); SOLUCION:50,83 | LangChain/LangGraph: "menos capas para 5 herramientas" (SOLUCION:83). **Inferencia mía** (no está escrita): el SDK oficial `@anthropic-ai/sdk` con bucle manual de ~30-40 líneas; no habría traído la capa de proveedor, pero sí habría que escribir y probar el bucle. |
| `@ai-sdk/anthropic` | 4.0.96 | Proveedor Anthropic para `ai` (`createAnthropic`, `anthropic.ts:1,8`) | PRD:163 (adaptador con implementación) | No consta en SOLUCION. **Inferencia**: otro proveedor (OpenAI, Google) o `fetch` directo a la API. |
| `zod` | 4.6.7 | `args` de cada tool y `overrideSchema` | PRD:189 y PRD:336 ("zod obligatorio") | Ninguna posible: es obligatorio. |
| `typescript` (dev) | 7.0.2 | Solo `tsc --noEmit` (`package.json:10`; `tsconfig.json` con `noEmit`) | PRD:335 (sin `any`) | Node 24 ejecuta `.ts` sin compilar (README:13), por lo que `tsc` es solo verificación; la alternativa es no tener typecheck. |
| `@types/node` (dev) | 26.6.6 | Tipos de `node:*` para `tsc` | Depende de `typescript` | Idem. |

Hechos: el lock tiene 35 paquetes, 12 de producción (transitivos de `ai`/`@ai-sdk`/`zod`; medido en `package-lock.json`). `.npmrc` fija `ignore-scripts=true`. SOLUCION:50 lista las 5 con una línea cada una: **PRD:336 pide "justificadas en SOLUCION.md" y la justificación de `typescript`/`@types/node` es solo "solo typecheck"**; la de `ai` es "bucle de herramientas". Es suficiente para pasar, corta para una defensa.

---

## 3. Por qué se entregó hasta ahí

### 3.1 Línea de tiempo (de `git log` del tag)

| Hora (UTC-5, 2026-11-03) | Commit | Hito |
|---|---|---|
| 21:26 | `e59d109` | Scaffold |
| 21:29-21:30 | `ab2a631`, `4261f8f` | Docker/render.yaml; prompt, conocimiento, README, SOLUCION |
| 21:31-21:32 | `a3864c3`, `97ad589` | Agente + adaptador + servidor; front |
| 21:35 | `195fc28`, `431ef6b`, `9a6b800` | Dominio, 5 tools, `demo.ts` determinista |
| 21:37-21:47 | `5e16a39`, `5369ffb`, `e16c70d` | Integración con tools reales; sonda de revisión tras `validar` |
| 22:06 | `b1dc41b` | **URL pública y acceso**: deploy hecho |
| 22:18 | `5ab6d9f`, `79bf380`, `eed55c6`, `ada23ef`, `6d3d1e6`, `537939e` | Cierra bypass del gate, endurece servidor, inyecta conocimiento, bonus `modulo/`, docs |
| 22:22-22:31 | `b0cf756`, `c6fdfc5`, `411fc18`, `e330b08`, `578e220`, `8e00329`, `0a5eaa6` | Gate ligado a revisión vista, markdown, refactor, docs, clave en README, tope de pasos, fix `args` nulos |
| 22:53 | tag | "Versión entregada a Periferia IT" |

**Lectura con cuidado**: varios commits comparten el mismo segundo (21:35:22 ×3; 22:18:36 ×6), lo que indica que se commitearon en lote (**inferencia**). La línea de tiempo muestra cuándo se confirmó el trabajo, no cuánto se trabajó. De scaffold al último commit pasan 65 minutos; hasta el tag, 87.

### 3.2 Alcance y plazo

- **Plazo**: ADR-001:6 dice "ventana de 2 h". El PRD no fija duración: "se comunica al inicio de la sesión" (PRD:12). El plan era de 40 minutos de ejecución con modelos baratos y Opus solo para revisar (`plan/MVP.md:1`). El plan nombró lo recortable: "sin ADRs, sin `modulo/`, sin `toolApproval`" y lo no recortable: "demo verde, chat, link público" (`plan/MVP.md:18`).
- **Qué entró**: los P0 del PRD: 5 tools (PRD:196-200), front con tool calls y confirmación (PRD:160), `demo.ts` (PRD:250-256), prompt separado (PRD:164), conocimiento separado (PRD:236-237), `SOLUCION.md` de 11 secciones (PRD:342-354), README con link y clave (PRD:356-358, README:5-9), link público (PRD:360-362; `plan/PROGRESO.md`: "Deploy + link ✅"), y el bonus `modulo/` (PRD:364-375).
- **Qué se priorizó**, por evidencia:
  1. *Cumplir el PRD obligatorio*: SOLUCION:99-108 tabla HU-1…HU-6 con estado "Verificado".
  2. *Demo determinista sin modelo*: la extracción es regex (SOLUCION:55-61, SOLUCION:82), así `demo.ts` corre sin clave (`demo.ts:1`).
  3. *Gate HITL en código y no en prompt*: ADR-001:11, SOLUCION:38-42, y 156 líneas de tests adversariales (`tests/core/gate-adversarial.test.ts`). Dos commits de gate (`5ab6d9f`, `b0cf756`) vinieron de revisión independiente (`plan/PROGRESO.md`: "Revisión final … hallazgos corregidos (gate, XFF, front)").
  4. *Deploy público acotado en costo*: topes por sesión/día, rate limit, clave (SOLUCION:150, RUNBOOK §2).
- **Qué se dejó fuera conscientemente** (todo está escrito en el tag):

| Fuera | Evidencia | Motivo declarado |
|---|---|---|
| `contratos_leer_pdf` (P1) y OCR | SOLUCION:99; PRD:74,201 | PRD lo marca opcional; los fixtures traen texto. |
| `toolApproval` nativo | SOLUCION:44; ADR-001:30; `plan/MVP.md:18` | Estaba en la lista de recortes desde el plan. El gate ya es código; el cambio sería de integración (SOLUCION:44). |
| Streaming | README:59 | Opcional (PRD:160). |
| Base de datos / mutex entre procesos | SOLUCION:84,152; ADR-002:21 | PRD:76 prohíbe BD; atómico solo dentro de un proceso. |
| RAG | ADR-003:15 | 5 KB caben en el contexto. |
| Prompt caching | SOLUCION:51; ADR-003:23 | No medido. |
| Costo en USD | SOLUCION:49 | "El precio por token no se verificó". Solo 53.358 tokens/lote en **una** corrida. |
| Plan-and-Execute, CodeAct, router LLM, multiagente | ADR-001:19-22 | `registrar` depende del resultado de `validar`; CodeAct sin aislamiento es riesgo de RCE. |
| Código en inglés | SOLUCION:81,99 | Lenguaje ubicuo del PRD. |

**Inferencias que no están escritas en ningún archivo**: que el plazo real fuese exactamente 2 h; que las decisiones de recorte se tomaran por falta de tiempo y no por criterio de diseño (el plan las llama "recorte si vas tarde", pero ADR/SOLUCION las presentan como decisiones técnicas); que la ausencia del precio USD fuese solo falta de tiempo.

---

## 4. Decisiones arquitectónicas y trade-offs

Convenciones: las citas sin prefijo son del tag `entrega-2026-11-03`. Las que llevan **[LG]** son de la rama `codex/langgraph-reto` (`a843ee4`, commit `wip`, **no publicada**; `docs/adr/004-langgraph-orquestacion.md` de esa rama dice "migración PARCIAL, A4-P0 abierto", ADR-004:3). La rama `release/ai-sdk-referencia` conserva el AI SDK como referencia (ADR-004:9). Los umbrales de "cuándo la cambiaría" son **propuestas mías** salvo donde cito una medición; el release solo midió una corrida (53.358 tokens por lote de 6 correos, SOLUCION:49).

### D1. Loop ReAct propio sobre AI SDK, frente a LangGraph o un agente autónomo

- **Fuerza.** PRD:161 exige "ciclo con tope de iteraciones" y PRD:163 una interfaz propia de adaptador; PRD:336 cobra cada dependencia. Había 5 tools y un plazo corto (ADR-001:6).
- **Decisión.** Un ReAct acotado: `generateText` con `stopWhen: stepCountIs(25)` (`src/llm/anthropic.ts:20-27`), y el ciclo de negocio (gate, tope, sonda) en un ejecutor propio (`src/agent/run.ts:175-202`) detrás de `LLMAdapter` (`src/llm/adapter.ts:27-32`).
- **Alternativas.** (a) LangChain/LangGraph: "menos capas para un flujo de 5 herramientas" (SOLUCION:83). (b) Agente autónomo de alto nivel: oculta el gate y los topes, que "deben ser visibles en código" (ADR-002:20). (c) Plan-and-Execute: `registrar` depende del resultado de `validar` (ADR-001:19). (d) Bucle manual sobre el SDK oficial: **no está documentado en el tag**; es mi inferencia.
- **Se ganó.** Una dependencia de orquestación en vez de varias; el proveedor se cambia tocando solo `llm/`; las tools se prueban sin modelo (`demo.ts`).
- **Se pagó.** El turno es *una* llamada `generateText` que no se detiene a medio bucle: la espera humana se resuelve **terminando el turno** y reconstruyendo el estado con texto (`src/agent/session.ts:24-29` guarda solo `text` y `toolCalls` resumidos). No hay reanudación del mismo bucle, y un fallo del proveedor a mitad de turno pierde el progreso intermedio (el reply determinista de `run.ts:204-213` solo cubre tope o texto vacío). Deuda reconocida: SOLUCION:44, ADR-001:30.
- **Cuándo la cambiaría.** Cuando aparezca cualquiera de: (1) una aprobación que deba sobrevivir a un reinicio o a un fallo del proveedor; (2) más de un punto de pausa por turno; (3) necesidad de reanudar con resultados parciales conservados. El release ya tenía el primer disparador en su propia lista de deuda (SOLUCION:44).

### D2. Extracción determinista con reglas, frente a extracción por LLM

- **Fuerza.** El valor, las fechas y el NIT son el dato crítico (SOLUCION:82); PRD:105 declara la extracción determinista como P0; PRD:208 prohíbe que el modelo afirme valores; PRD:331 pide `demo.ts` determinista y sin clave.
- **Decisión.** Regex por cláusula con confianza por campo (`src/domain/extraccion.ts:90-262`; confianza 1 / 0,8 / 0,6 / 0,5 / 0, SOLUCION:60); clasificación RN1–RN4 en código (`src/domain/reglas.ts:42-65`); el modelo solo conduce y explica (`agent/prompt.md:15-16`).
- **Alternativas.** (a) Extracción completa con LLM (descartada en SOLUCION:82). (b) Híbrido: reglas primero y LLM como segunda opinión sobre los campos de baja confianza (PRD:105 lo permite si el valor final pasa por `validar`; **no implementado**). (c) Parser de PDF/OCR: fuera de alcance (PRD:74).
- **Se ganó.** Reproducibilidad (`demo.ts` da la misma tabla en cada corrida), auditoría con un diff, costo cero por extracción y el modelo no puede "redondear" un valor.
- **Se pagó.** Acoplamiento a la plantilla de los 6 fixtures: patrones fijos (`extraccion.ts:31-37, 64, 143, 224`) y `NIT_PERIFERIA` constante (`:7`). Otra plantilla degrada a confianza 0 y cae en revisión humana (`src/domain/contrato.ts:81-83`), lo cual es seguro pero caro en tiempo de la analista.
- **Cuándo la cambiaría.** Con datos reales, si el porcentaje de campos que caen en revisión por formato (no por ambigüedad real) supera un umbral acordado con la analista (propuesta: más de 1 de cada 5 contratos), o llegan escaneados. Primero pasaría al híbrido (b); la regex quedaría como baseline y como oráculo de prueba.

### D3. Gate HITL en código, frente a confiar en la confirmación del modelo

- **Fuerza.** Un valor mal registrado es costoso (ADR-001:6); PRD:209 (CA3) y PRD:299 (RN5) piden que solo se proceda si el usuario confirma; PRD:390 nombra el riesgo de que el modelo infiera.
- **Decisión.** `registrar` sin confirmación devuelve `revision[]` y no escribe (`src/tools/contratos.ts:304`). `confirmado:true` pasa solo si la revisión de ese `mensaje_id` la vio la persona en un turno previo, su último mensaje es una afirmación sin pregunta, condicional ni negación y, con varias pendientes, nombra el id; el override solo toca campos en revisión (`src/agent/run.ts:55-71`, `175-202`; `tools/contratos.ts:202-214`). La pregunta la arma el servidor (`run.ts:41-43`).
- **Alternativas.** (a) Flag `confirmado` decidido por el modelo: "puede auto-aprobarse" (SOLUCION:80). (b) Confirmación solo en el prompt: "un prompt no garantiza nada" (ADR-001:23). (c) Evento explícito (`toolApproval`/`needsApproval`, token de un solo uso): no implementado (SOLUCION:44; el SDK instalado lo expone en `ai/dist/index.d.ts`, no lo probé).
- **Se ganó.** El peor caso lo acota código con 156 líneas de tests adversariales (`tests/core/gate-adversarial.test.ts`); fallar cierra.
- **Se pagó.** La autorización es una **heurística de texto** (`run.ts:9-20`): falsos negativos ("no hay problema, confirmo") y la ligadura laxa de `run.ts:63` (una sola pendiente basta sin nombrar el id). Y el gate vive en el agente, no en la tool: `modulo/tools/contratos.ts:3` re-exporta `registrar` sin gate y `demo.ts:28` lo salta a propósito.
- **Cuándo la cambiaría.** (1) Al primer hallazgo de confirmación ambigua aceptada con un id válido; (2) al exponer el módulo `modulo/` a un integrador externo; (3) con datos reales o más de una persona aprobando. Pasaría a un evento explícito con operación y valores exactos atados a la aprobación, y movería el veto dentro de la tool.

### D4. Conocimiento inyectado en el prompt, frente a RAG

- **Fuerza.** PRD:248 separa comportamiento, conocimiento y ejecución; el corpus son 71 líneas / ~5 KB (`src/knowledge/registro-contratos.md`); Render Free sin infraestructura extra.
- **Decisión.** `buildSystemPrompt` concatena `agent/prompt.md` y el documento al arrancar (`src/agent/context.ts:24-32`; `src/server.ts:77`). Las reglas que *deben* cumplirse siguen en código; el documento "da contexto, no autoridad" (ADR-003:10).
- **Alternativas.** RAG vectorial, fine-tuning, y "solo en el prompt sin archivo" (ADR-003:12-17).
- **Se ganó.** Cero infraestructura, el agente ve siempre el mismo texto, y el cambio de una regla se revisa con un diff.
- **Se pagó.** Cada llamada paga esos tokens: sin caché de prompt (`SOLUCION:51`; ADR-003:23 lo llama "hipótesis, sin medir"). Y una regla duplicada en prosa y en código puede divergir.
- **Cuándo la cambiaría.** Los disparadores ya están escritos y son cualitativos (ADR-003:24); yo los concretaría así (propuesta): (1) el documento supera ~10-15 % de la ventana de contexto elegida o el prompt de sistema deja de caber cómodo; (2) se añaden procesos con documentos distintos; (3) se necesita consultar contratos históricos o cláusulas. Antes de RAG, activar caché de prompt y medir el ahorro.

### D5. Haiku por defecto, frente a Sonnet o una cascada

- **Fuerza.** Muchas llamadas cortas por lote; el modelo no decide valores (D2) ni autoriza (D3); costo acotado de un link público (PRD:333).
- **Decisión.** `claude-haiku-5-5` por defecto, configurable con `LLM_MODEL` (`src/llm/anthropic.ts:6`; `render.yaml`; SOLUCION:48).
- **Alternativas.** (a) Sonnet por defecto. (b) Cascada: Haiku conduce y escala a Sonnet ante error de herramienta, texto vacío o tope de pasos. (c) Modelo local. Ninguna está evaluada en el tag.
- **Se ganó.** Costo y latencia bajos con un techo de error limitado: el peor fallo del modelo es explicar mal, no registrar mal.
- **Se pagó.** **No hay evaluación comparativa**: una sola corrida real (SOLUCION:49), sin precio en USD y sin suite que mida la conducción del modelo (`tests/agent/integracion.test.ts:17-18` usa `provider: "mock"`).
- **Cuándo la cambiaría.** Con una eval fija (los 6 fixtures más casos adversariales) y estas señales: (1) Haiku falla la conducción del lote por encima de un umbral acordado (propuesta: 1 corrida de cada 20 sin cerrar el lote); (2) el costo medido por lote, ya con precio verificado, justifica pagar Sonnet; (3) crece el número de tipos de documento. Solo entonces armaría la cascada.

### D6. CSV y carpetas en `out/`, frente a una base de datos

- **Fuerza.** PRD:76 prohíbe base de datos; PRD:121 y PRD:300 definen el maestro como CSV copiado del fixture; PRD:165 acepta persistencia en `out/`.
- **Decisión.** Maestro CSV con escritura atómica (temporal + `rename`, `src/infra/maestro.ts:31-38`), CSV RFC 4180 con prefijo `'` contra fórmulas (`src/domain/csv.ts:1-13`), `historial.jsonl`, `procesados.json` y `log.jsonl` (`src/infra/registros.ts`).
- **Alternativas.** (a) SQLite. (b) Postgres. (c) SharePoint/Graph real (fuera de alcance, PRD:55).
- **Se ganó.** Es lo que pide el PRD, se inspecciona a mano y no hay infraestructura.
- **Se pagó.** Sin lock entre procesos; `registrar` es atómico solo por ser síncrono dentro de un proceso (SOLUCION:152); en Render Free el disco es efímero (ADR-002:25); y un registro escribe tres cosas (archivo, CSV, historial) sin transacción conjunta.
- **Cuándo la cambiaría.** Al haber más de un escritor (segunda instancia o segundo usuario), al requerir restaurar tras un reinicio, o al pasar de una sola persona a un equipo. Propuesta: una tabla transaccional para contrato + historial + aprobación, y los archivos fuera del request path.

### D7. Un solo agente, frente a multiagente

- **Fuerza.** Cinco tools, un flujo lineal con una dependencia (`validar` → `registrar`), y PRD:336 penaliza complejidad sin justificar.
- **Decisión.** Un agente único (`src/agent/run.ts:226`, una llamada al adaptador por turno) con las 5 tools.
- **Alternativas.** Orchestrator-workers y paralelización: "más tokens y complejidad sin un especialista que lo justifique" (ADR-001:22); router con LLM (ADR-001:21); Plan-and-Execute (ADR-001:19).
- **Se ganó.** Menos tokens, comportamiento auditable, un solo prompt que mantener.
- **Se pagó.** Si crecen los tipos de documento, el agente único se vuelve un prompt grande con muchas ramas (ADR-001:29 lo admite).
- **Cuándo la cambiaría.** Cuando exista un segundo tipo de documento (actas de terminación, pólizas) con reglas y herramientas propias, o cuando una tarea larga (reconstruir junio–agosto en lote) justifique trabajadores paralelos con revisión independiente.

### D8. Render Free con Docker, frente a otras opciones, y memoria en el proceso

- **Fuerza.** PRD:360-362 pide un link público activo durante la defensa y acepta Vercel, Render, Fly.io, Railway, Azure o un túnel; el local en defensa cuesta -10 puntos. Sesiones, rate limit y escritura a disco exigen un proceso de larga vida.
- **Decisión.** Imagen `node:24-slim` no root (`Dockerfile:1-25`), `render.yaml` con `plan: free` y `healthCheckPath`, `ACCESS_KEY` activa, sesiones y contadores en `Map` (`src/agent/session.ts:38`; `src/server.ts:82-89`).
- **Alternativas.** (a) Vercel/funciones sin estado: **inferencia mía**, no encaja con sesiones en memoria ni con escritura a `out/`. (b) Fly.io o Railway con volumen. (c) Túnel local (-10, PRD:362). El tag no documenta por qué Render sobre Fly/Railway; solo que la cuenta de Render era un prerrequisito del plan (`plan/MVP.md:7`).
- **Se ganó.** Un link público en minutos, con Docker reproducible y sin costo.
- **Se pagó.** Se duerme por inactividad, el disco se pierde al reiniciar (RUNBOOK §1, SOLUCION:151), un reinicio **resetea también el tope diario de tokens** (`server.ts:88-89`) y las sesiones no escalan a varias instancias (ADR-002:26). El control de gasto real es el límite de la consola del proveedor (RUNBOOK §2).
- **Cuándo la cambiaría.** Con más de una instancia, con datos que no puedan perderse, o con un SLA: pasaría a un servicio con volumen persistente o a una base de datos, con sesiones y topes fuera del proceso.

### D9. Dependencias mínimas

- **Fuerza.** PRD:336 exige justificar cada dependencia; PRD:16 exige poder explicar cada línea.
- **Decisión.** Tres de producción (`ai`, `@ai-sdk/anthropic`, `zod`) y dos de desarrollo (`typescript`, `@types/node`), todas en versión exacta (`package.json:13-21`; `.npmrc` con `ignore-scripts=true`). Node 24 ejecuta `.ts` sin compilar. El lock tiene 35 paquetes, 12 de producción.
- **Alternativas.** (a) Más framework (LangChain: SOLUCION:83). (b) Menos: sin `ai`, con `fetch` directo a la API (**inferencia**). (c) Sin typecheck.
- **Se ganó.** Superficie de supply chain pequeña, arranque rápido en Docker y todo explicable en la defensa.
- **Se pagó.** Se escribió a mano lo que un framework da hecho: el gate, la sonda de revisión, el tope y el reply determinista (`run.ts`, 236 líneas); y la justificación escrita de cada dependencia es de una línea (SOLUCION:50).
- **Cuándo la cambiaría.** Cuando mantener el mecanismo propio cueste más que la dependencia: típicamente al necesitar pausa/reanudación durable (D1) o trazas y evaluaciones (LangSmith u otra), y entonces con la justificación escrita por dependencia.

### 4.1 Cómo la migración posterior a LangGraph confirma o revierte cada decisión

Nota de honestidad: la migración es un `wip` sin publicar y con un P0 abierto ("un ID de revisión válido no autoriza un mensaje con excepción o instrucciones adicionales", ADR-004:15); sus ventajas de "rapidez y ahorro de tokens son hipótesis por medir" (ADR-004:15). Es evidencia de dirección, no de resultado.

| # | Decisión | Veredicto | Evidencia **[LG]** |
|---|---|---|---|
| D1 | ReAct propio sobre AI SDK | **Revierte la herramienta, confirma el disparador.** El trigger era "pausa/reanudación durable"; ADR-004:7 diagnostica "brechas en la suspensión, conservación de resultados parciales y vinculación de aprobaciones" y adopta `StateGraph` con `interrupt` y `Command` (`src/agent/graph.ts:192-297`). El AI SDK se conserva como referencia (ADR-004:9). | ADR-004:7,11; graph.ts:192-297 |
| D2 | Extracción por reglas | **Confirma.** Sigue siendo regex (`extraccion.ts` +31 líneas) y las fixtures y la demo sin modelo "permanecen independientes de LangGraph" (ADR-004:21). Lo que cambia es la clasificación: `reglas.ts` +95 líneas con `motivos_revision`. | ADR-004:21; graph diff |
| D3 | Gate HITL en código | **Confirma y profundiza.** El gate sigue en código, ahora con "operación, propuesta y valores exactos" y un snapshot por id (ADR-004:19; `graph.ts:97-98`). El P0 abierto es justo la debilidad que anticipé (confirmación por texto, §5 #1-#3): la heurística de texto sigue presente en `run.ts:9-19`. | ADR-004:15,19 |
| D4 | Conocimiento en el prompt | **Confirma.** `context.ts` y `knowledge/` no cambiaron entre el tag y la rama. | diff vacío |
| D5 | Haiku por defecto | **Confirma.** Sigue `claude-haiku-5-5` (`anthropic.ts:56`); se añaden topes de salida (4096) y timeout (`:58-59`), sin evaluación comparativa todavía. | anthropic.ts:56-59 |
| D6 | CSV y `out/` | **Confirma y precisa el límite.** `maestro.ts` no cambió, y ADR-004:26 reconoce que un checkpoint "no hace atómica una escritura conjunta de CSV, archivo y SharePoint"; para B exige almacenamiento durable. | ADR-004:26 |
| D7 | Un solo agente | **Confirma.** El grafo es control de flujo de **un** agente (un nodo `modelo`, `graph.ts:194`), no multiagente; ADR-004:35 vuelve a descartar el agente autónomo. | graph.ts:194; ADR-004:35 |
| D8 | Render Free + memoria en proceso | **Confirma la limitación.** `MemorySaver` sigue en memoria (`graph.ts:39-43`) y "no sobrevive a reinicios" (ADR-004:26); `Dockerfile` apenas cambia (+3/-1) y B requiere checkpointer durable e identidad. | graph.ts:39-43; ADR-004:26 |
| D9 | Dependencias mínimas | **Revierte, con el costo declarado.** De 3 a 5 de producción (`@langchain/anthropic`, `@langchain/core`, `@langchain/langgraph`, `langsmith`, `zod`; `package.json:13-19` en la rama). ADR-004:11 acepta "el costo de dependencias y conceptos" a cambio de no mantener otro mecanismo de pausa; LangSmith externo queda deshabilitado (ADR-004:30). | package.json:13-19; ADR-004:11,30 |

**Frase para la defensa:** el release minimizó dependencias y movió la autorización a código; dejó escrito como deuda (SOLUCION:44, ADR-001:30) que la pausa durable era el disparador para adoptar un framework. La migración a LangGraph ejecuta ese disparador (D1, D9) y deja intactos los trade-offs de dominio (D2, D4, D5, D6, D7); D3 y D8 se mantienen en el principio y siguen con trabajo abierto.

---

## 5. Debilidades honestas y respuesta corta

| # | Debilidad | Evidencia | Respuesta corta |
|---|---|---|---|
| 1 | **Pausa/reanudación del AI SDK**: la confirmación se detecta por regex sobre el texto, no por evento. | `run.ts:9-20` (`AFIRMA`, `PREGUNTA`, `CONDICIONAL`, `RECHAZA`); SOLUCION:40; ADR-001:28 | "El AI SDK 7.0.162 instalado sí trae `needsApproval` y `tool-approval-request` (están en `ai/dist/index.d.ts`; no lo probé). No lo usé porque reanudar exige guardar los `ModelMessage` completos por sesión y el release solo guarda texto (`session.ts:24-29`). Lo compensé con un gate en código atado a `mensaje_id`, a una revisión vista en un turno previo y a un texto sin pregunta, sin condicional y sin negación. Fallar cierra: ante la duda, no registra." |
| 2 | **Falsos negativos del regex**: "no hay problema, confirmo" se rechaza por `\bno\b`. | `run.ts:12,19` | "Es deliberado: el rechazo siempre gana. El costo es una pregunta de más, no un registro indebido." |
| 3 | **Con una sola revisión vista, el texto no necesita nombrar el `mensaje_id`.** | `run.ts:63` (`vistas.size === 1 \|\| …`) | "Con una pendiente, 'confirmo' alcanza porque el único destino posible es esa; con varias, exige nombrarlo." |
| 4 | **El gate vive en `run.ts`, no en la tool.** `registrar` acepta `confirmado:true` por sí sola, y `modulo/tools/contratos.ts` solo re-exporta las tools sin gate. | `tools/contratos.ts:304`; `demo.ts:28`; `modulo/tools/contratos.ts:3` (re-export) | "Es la debilidad más seria para el bonus: quien use el módulo sin mi `run.ts` puede auto-confirmar. En esta app el modelo nunca ejecuta una tool sin pasar por `crearEjecutor` (`run.ts:175-202`). Para el módulo, el gate debería migrar a la tool. No lo hice por plazo." |
| 5 | **Haiku en lugar de Sonnet.** | `anthropic.ts:6`; SOLUCION:48 | "Flujo de muchas llamadas cortas y el modelo no decide valores: la extracción es regex y el gate es código, así que el techo de error del modelo es explicar mal, no registrar mal. Solo medí **una** corrida real (53.358 tokens). No hay evaluación comparativa Haiku vs Sonnet; si falla la conducción del lote, cambio `LLM_MODEL` sin tocar código." |
| 6 | **Maestro en CSV.** Sin lock entre procesos; en Render Free el disco es efímero. | `maestro.ts:31-38`; SOLUCION:152; ADR-002:25 | "Lo exige el PRD (PRD:76). La escritura es temp + `rename`, atómica dentro de un proceso; `registrar` es síncrono. Con más de un escritor, la tabla pasa a base de datos." |
| 7 | **Memoria del proceso.** Sesiones, pendientes, rate limit y el tope diario viven en `Map`; un reinicio los borra. | `session.ts:38`; `run.ts:25`; `server.ts:82-89` | "Aceptable para demo (SOLUCION:151). Un reinicio **resetea también el tope diario** de tokens (`server.ts:88-89`): el control de costo real es el límite de gasto en la consola del proveedor (RUNBOOK §2)." |
| 8 | **Texto libre del modelo**: el modelo redacta la respuesta y puede mal-citar un valor; CA2 se sostiene por prompt. | `prompt.md:15-16`; CA2 PRD:208 | "Lo que se **registra** nunca sale del modelo: sale de la tool por `mensaje_id` (SOLUCION:79). Lo que el modelo **dice** sí es texto libre y solo está restringido por prompt. El front muestra args y resumen de cada tool (`web/index.html:220-229`) para contrastarlo." |
| 9 | **Extracción por regex**: acoplada a la plantilla de los 6 fixtures. | `extraccion.ts:31-37,64,143,224` | "PRD:105 acepta regex como P0. Cubre los 6 casos exactamente; otra plantilla bajaría la confianza a 0 y caería en revisión humana (`revisionPorConfianza`, `contrato.ts:81-83`), no en un dato malo. Ampliarlo con el modelo requeriría que el valor final pase por `validar` (PRD:105)." |
| 10 | **Prompt injection**: el contenido de correos llega al modelo (`asunto`, `objeto`, `motivos`). | `tools/contratos.ts:117`; `prompt.md:17` | "Se trata como dato por prompt, pero la defensa real es que ningún texto del correo puede abrir el gate ni escribir fuera de `out/`. No hay tools de borrado ni shell (`prompt.md:18`)." |
| 11 | **La clave de acceso está publicada** en el README. | README:9 (PRD:166 lo permite) | "Es lo que pide PRD:166 para un link protegido. Protege del tráfico al azar, no es secreto. Por eso hay tope diario y por sesión, y por eso `/api/reset` es riesgoso (§1.1)." |
| 12 | **Sin eval real del agente**: los tests del agente usan modelo simulado (`provider: "mock"`). | `tests/agent/integracion.test.ts:17-18` | "El dominio y el gate se prueban con tools reales y modelo simulado; la conducción del modelo real la comprobé con una corrida end-to-end (`plan/PROGRESO.md` M7), no con una suite." |
| 13 | **Docs desalineadas**: PROGRESO dice 38/38, README 47/47; `LLM_PROVIDER` documentado pero sin efecto. | `plan/PROGRESO.md` (M9); README:30,47 | "El número vigente es el del README. `LLM_PROVIDER` hoy no hace nada: es el único proveedor." |

---

## 6. Guion de 2 minutos (arquitectura, punta a punta)

> **[0:00] Problema.** El maestro de contratos está congelado desde el 30 de mayo y nadie sabe qué vence ni qué pólizas faltan. Hice un agente de chat que actúa como punto único de recepción: lee el buzón, extrae, valida, registra y alerta.
>
> **[0:15] Tres capas separadas, como pide el PRD.** *Comportamiento* en `agent/prompt.md`. *Conocimiento* en `src/knowledge/registro-contratos.md`, que inyecto entero en el system prompt porque son 5 KB (ADR-003). *Ejecución* en `src/tools/contratos.ts`, cinco tools con zod que además importa `demo.ts` sin modelo.
>
> **[0:35] Flujo.** El front (un `index.html`, 507 líneas) llama a `POST /api/chat`. El servidor `node:http` aplica clave, rate limit y topes y delega en `ejecutarTurno` (`run.ts`). Ese turno llama al adaptador LLM, que es una interfaz propia con una implementación Anthropic sobre el AI SDK: Haiku, tope de 25 pasos y timeout de 60 s.
>
> **[0:55] La decisión central.** El modelo elige *qué mensaje* procesar, nunca *qué valor*. Las tools reciben un `mensaje_id` y releen el fixture. La extracción es regex con confianza por campo y las reglas RN1–RN4 son código, así que el modelo solo conduce y explica. Lo que se registra no sale del modelo.
>
> **[1:15] Human-in-the-loop en código.** Si un campo baja de 0,8, `registrar` devuelve `revision[]` y no escribe. El servidor, no el modelo, arma la pregunta y fija la pendiente. `confirmado:true` solo pasa si esa revisión ya la vio la persona en un turno anterior, su último mensaje es una afirmación sin pregunta ni negación y, con varias pendientes, nombra el id. El override solo puede tocar campos en revisión. Hay tests adversariales para cada bypass.
>
> **[1:40] Honestidad.** La confirmación se detecta por texto, no por evento; el AI SDK ya trae `needsApproval`, y migrar es el siguiente paso. El gate vive en el agente, no en la tool, lo que debilita el módulo del bonus. Estado en memoria y CSV en disco efímero: aceptable para demo, no para producción.
>
> **[1:55] Evidencia.** `demo.ts` corre los 6 mensajes sin clave y deja 006 en revisión hasta confirmar; `tsc` limpio; y el link público está desplegado en Render con topes de costo.
