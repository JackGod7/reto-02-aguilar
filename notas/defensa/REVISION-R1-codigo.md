# Revisión R1 — código (solo lectura)

Estado base: `npm test` 36/36 (sin sandbox; con sandbox fallan 3 tests por EPERM al abrir puerto), `npm run typecheck` OK, `node demo.ts` = tabla de SPEC §4 (001 nuevo CT-2026-015, 002 CT-2026-016, 003 actualización CT-2011, 004 duplicado, 005 rechazado, 006 pendiente→registrado; alertas idénticas). Nota: la demo reescribe `out/` (ignorado por git).

## Veredicto
- **P0-1 original (override `contrato` sin gate): CERRADO** a nivel de tool (`src/tools/contratos.ts:178-192`) y a nivel de sesión. Verificado: override sin `confirmado` → ok:false; con `confirmado` y clave fuera de `requiere_revision` → ok:false; `validar` ya no acepta `contrato`; confirmación para otro `mensaje_id` → rechazada.
- **Queda un bypass del gate en el mismo turno (P1-A)** y una ligadura débil con varios pendientes (P1-B). No son el P0 original, pero rompen la garantía HITL ("el usuario vio los valores antes de confirmar"). Recomiendo arreglar P1-A antes de entregar.

## Hallazgos

### P1-A — Confirmación y pendiente en el mismo turno (gate abierto por "ok" del usuario)
`src/agent/run.ts:85,99-104`: `pend` se llena DURANTE el turno (sonda de `validar`, `run.ts:~135-146`), y `confirma` se calcula sobre el mensaje del usuario al inicio del turno. Si el usuario escribe cualquier frase con "ok/sí/confirmo/adelante" ("ok, procesa el mensaje 006"), y el modelo (p. ej. manipulado por texto de un correo) llama `validar` y luego `registrar{confirmado:true}`, el gate lo deja pasar sin que la persona haya visto la propuesta.
Repro (`$TMPDIR/atk/atk.ts`, adapter simulado, copia de fixtures): turno "ok, procesa el mensaje 006" → `validar(msg-006)` + `registrar{msg-006, confirmado:true}` → `ok:true`, escribe maestro.
Arreglo: tomar un snapshot `const previos = new Set(pend.keys())` ANTES del turno y exigir `previos.has(a.mensaje_id)` para aceptar `confirmado:true` (la revisión debe haberse mostrado en un turno anterior).

### P1-B — `confirmaPara` con varios pendientes es laxo
`src/agent/run.ts:38-44`: basta que el texto contenga como subcadena un `valor_propuesto` (p. ej. `0`, `2027-08-31`). Con 2 pendientes (msg-006 y copia msg-009), el texto "ok, gracias 2026" contiene "0" → confirma msg-009 (repro `$TMPDIR/atk/atk2.ts`, línea C → ok:true). Un "ok" puro con varios pendientes sí se rechaza (bien).
Arreglo: con >1 pendientes exigir `mensaje_id` literal en el texto (quitar la rama por valores) o que el modelo pregunte cuál; si se quiere conservar valores, exigir coincidencia con ≥1 campo Y fecha/valor completo con límites de palabra y no valores triviales (`0`).

### P1-C — XFF: se toma la PRIMERA entrada (spoofeable)
`src/server.ts:111-112`: con `TRUST_PROXY=1`/`RENDER` se usa `xff.split(",")[0]`. Tras un proxy que AÑADE al final (Render), la primera entrada la controla el cliente → evade el rate limit rotando `X-Forwarded-For`. Arreglo: usar la última entrada (o la N-ésima desde el final según saltos de confianza). Además `RENDER` definido activa confianza sin configuración explícita; está bien en Render, pero documentarlo.

### P2
- **Prompt con conocimiento**: `src/server.ts:77` usa `buildSystemPrompt(...)`; OK. Pero `|| cargarPrompt()` solo actúa si ambos faltan; sin problema.
- `CONFIRMA`/`RECHAZA` (`run.ts:8-9`): `\bs[ií]\b` matchea "si" condicional ("¿lo registro si ...?" → confirma) y una pregunta del usuario ("¿confirmas?") cuenta como confirmación. `RECHAZA` por `\bno\b` anula "no hay problema, confirmo" (falso negativo, falla segura). Mitigar con P1-A (ya no basta una palabra).
- `server.ts:209` el tope diario cuenta tokens al terminar el turno: peticiones concurrentes pueden exceder el tope (acotado por `ocupadas` por sesión pero no global). Aceptable para demo.
- `server.ts:186-193`: se crea la sesión y se registra en `vivas` antes de comprobar el tope diario → un 429 deja sesión huérfana (se limpia por TTL solo cuando `vivas ≥ maxSesiones`). Mover la comprobación antes de `crearSesion`.
- `expirarSesiones` solo corre al llegar al tope; la memoria de sesiones inactivas no se libera antes. Aceptable.
- `/api/reset`: protegido (403 sin ACCESS_KEY, 401 sin clave, 409 si hay ocupadas). Borra `out/` completo (incluye `log.jsonl`); OK por diseño pero es destructivo para el log de auditoría.
- Tests con `any`: `tests/agent/agent.test.ts`, `integracion.test.ts` (varias `as any`/`: any`); `src` y `scripts` sin `any`. CLAUDE.md dice "sin any": limpiar con tipos mínimos.
- `tests/core/tools.test.ts:185-195`: el test de fórmula ahora escribe el maestro con `escribirMaestro` en vez de vía override; sigue probando el relectura/escape CSV pero ya no el camino por `registrar`. Aceptable, pero el nombre ("tras registrar override") ya no es exacto.
- `gate-adversarial.test.ts`: no cubre P1-A ni P1-B (los casos con varios pendientes y confirmación en el mismo turno). Añadir los dos repros.

## Checklist solicitada
1. **Gate**: ver P0-1 cerrado / P1-A / P1-B. Inyección desde texto de correo: `confirma` solo mira el mensaje del usuario (bien); el correo no puede confirmar por sí mismo, salvo combinado con P1-A.
2. **Servidor**: XFF ignorado sin TRUST_PROXY (ok, con test) pero primera entrada spoofeable (P1-C); `/api/reset` ok; tope diario ok (P2 menores); TTL de sesiones ok; CSP (`script-src/style-src 'unsafe-inline'`, `connect-src 'self'`) compatible: `web/index.html` solo tiene un `<script>` inline, sin handlers `on*=` ni recursos externos; `timingSafeEqual` sobre hash SHA-256 (correcto, longitudes iguales); HEAD / → 200 sin cuerpo con `content-length`.
3. **Contrato PRD**: 5 tools con mismos nombres (`leer_buzon, extraer, validar, registrar, alertas`); `validar` perdió el arg `contrato` (cambio de firma intencional, coherente con el arreglo; la demo y SPEC §4 siguen idénticos). CSV/maestro: sin cambios en columnas.
4. **Calidad**: sin `any` en src/scripts; `ejecutarTurno` es larga (~90 líneas, mezcla gate + sondeo + estado) — extraer `gate()` facilitaría arreglar P1-A/B; los tests nuevos son sustantivos (adversariales reales), salvo los huecos anotados.
5. **modulo/**: estructura = PRD §9.4 (agent.md con frontmatter description/mode/permission, tools/contratos.ts re-exporta las 5 tools de `src/`, skill/registro-contratos/SKILL.md con name/description); generado por `scripts/build-modulo.ts` desde `agent/prompt.md` y `src/knowledge/`; `tests/core/modulo.test.ts` verifica cuerpo == fuente. No ejecuté `npm run build:modulo` (escribiría en el repo); la idempotencia se infiere del test.

## Reproducciones
Scripts temporales (no tocan el repo): `$TMPDIR/atk/atk.ts` (P1-A), `$TMPDIR/atk/atk2.ts` (P1-B), ambos con copias de `fixtures/` en directorios temporales.
