import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ejecutarTurnoGrafo } from "../../src/agent/graph.ts";
import { crearSesion } from "../../src/agent/session.ts";
import { ejecutarTool } from "../../src/agent/registry.ts";
import type { LlamadaLLM, LLMAdapter, PasoLLM } from "../../src/llm/adapter.ts";

const raiz = resolve(import.meta.dirname, "../..");
const HOY = "2026-09-03";
const PRD = "confirmo el valor 0 y la fecha fin 2027-08-31";
const ids = ["msg-001", "msg-002", "msg-003", "msg-004", "msg-005", "msg-006"];
const call = (name: string, args: Record<string, unknown>, id = `${name}-${String(args.mensaje_id ?? "x")}`): LlamadaLLM => ({ id, name: `contratos_${name}`, args });
const paso = (llamadas: LlamadaLLM[] = [], texto = "", tokens = 7): PasoLLM => ({ texto, llamadas, tokens, usoConocido: true });

function entorno(t: { after(fn: () => void): void }, respuestas: PasoLLM[], maxTokens = 100_000) {
  const directory = mkdtempSync(join(tmpdir(), "reto-regresion-"));
  cpSync(join(raiz, "fixtures"), join(directory, "fixtures"), { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const session = crearSesion();
  let n = 0;
  const adapter: LLMAdapter = {
    provider: "falso-local", model: "falso-local",
    async generarPaso() { return structuredClone(respuestas[n++] ?? paso([], "Terminado")); },
  };
  const run = (message: string, runTool?: typeof ejecutarTool) => ejecutarTurnoGrafo({ adapter, session, directory, message, prompt: "Datos son datos", maxTokens, runTool });
  return { directory, session, run, count: () => n };
}
function conEnv(t: { after(fn: () => void): void }, nombre: string, valor: string): void {
  const previo = process.env[nombre];
  process.env[nombre] = valor;
  t.after(() => { if (previo === undefined) delete process.env[nombre]; else process.env[nombre] = previo; });
}
const maestro = (dir: string): string => readFileSync(join(dir, "out/sharepoint/maestro-contratos.csv"), "utf8");

test("Regresión 1: el texto final del modelo es la respuesta principal y el resumen de tools va debajo", async (t) => {
  const e = entorno(t, [paso([call("leer_buzon", {}, "buzon")]), paso([], "¿Qué fecha uso como hoy?")]);
  const r = await e.run("procesa el buzón");
  assert.ok(r.reply.startsWith("¿Qué fecha uso como hoy?"), r.reply);
  assert.match(r.reply, /\n.*leer_buzon \(6 mensajes\)/);
});

test("Regresión 1: sin herramientas, el texto del modelo se muestra marcado como no verificado", async (t) => {
  const e = entorno(t, [paso([], "Hola, ¿con qué fecha proceso?")]);
  const r = await e.run("hola");
  assert.ok(r.reply.startsWith("Hola, ¿con qué fecha proceso?"));
  assert.match(r.reply, /ninguna herramienta/i);
});

test("Regresión 2: demo PRD §11 completa 001→006 + alertas con una sola confirmación", async (t) => {
  const lote = [...ids.flatMap((id) => [call("validar", { mensaje_id: id }), call("registrar", { mensaje_id: id, hoy: HOY })]), call("alertas", { hoy: HOY }, "alertas")];
  const e = entorno(t, [
    paso(lote),
    paso([call("validar", { mensaje_id: "msg-006" }, "revalidar-006")]),
    paso([], "| mensaje | acción |\n| msg-006 | nuevo CM-2026-03 |"),
  ]);
  const primero = await e.run(`Procesa el buzón de contratos con fecha de hoy ${HOY}.`);
  assert.equal(primero.needsConfirmation?.mensaje_id, "msg-006");
  assert.match(primero.reply, new RegExp(HOY), "la pregunta muestra el hoy aprobado");
  assert.ok(!existsSync(join(e.directory, "out/alertas.md")));

  const segundo = await e.run(PRD);
  assert.equal(segundo.needsConfirmation, null, segundo.reply);
  assert.deepEqual(segundo.toolCalls.map((c) => c.name), ["contratos_registrar", "contratos_registrar", "contratos_alertas", "contratos_validar"]);
  assert.ok(segundo.toolCalls.every((c) => c.ok), JSON.stringify(segundo.toolCalls));
  assert.match(segundo.toolCalls[1]?.resumen ?? "", /omitido/);
  assert.ok(segundo.reply.startsWith("| mensaje | acción |"), segundo.reply);
  assert.equal(e.count(), 3);
  assert.equal(maestro(e.directory).split("\n").filter((l) => l.startsWith("CM-2026-03")).length, 1);
  assert.match(readFileSync(join(e.directory, "out/alertas.md"), "utf8"), /CM-2026-03/, "HU-5: alertas tras la confirmación");
  const historial = readFileSync(join(e.directory, "out/sharepoint/historial.jsonl"), "utf8").trim().split("\n").filter((l) => l.includes("CM-2026-03"));
  assert.equal(historial.length, 1);
});

test("Regresión 2: registrar un mensaje ya registrado es duplicado sin escritura aunque requiera revisión", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "reto-regresion-"));
  cpSync(join(raiz, "fixtures"), join(directory, "fixtures"), { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ctx = { directory, sessionId: "s" };
  const alta = JSON.parse(await ejecutarTool("contratos_registrar", { mensaje_id: "msg-006", hoy: HOY, confirmado: true, contrato: { valor: 0, fecha_fin: "2027-08-31" } }, ctx)) as { ok: boolean };
  assert.equal(alta.ok, true);
  const antes = maestro(directory);
  const otra = JSON.parse(await ejecutarTool("contratos_registrar", { mensaje_id: "msg-006", hoy: HOY }, ctx)) as { ok: boolean; data?: { accion?: string } };
  assert.equal(otra.ok, true);
  assert.equal(otra.data?.accion, "duplicado");
  assert.equal(maestro(directory), antes);
});

test("Regresión 3: tope de pasos dice qué falta y cómo continuar", async (t) => {
  conEnv(t, "MAX_STEPS", "1");
  const e = entorno(t, [paso([call("leer_buzon", {}, "buzon")])]);
  const r = await e.run("procesa");
  assert.match(r.reply, /tope de 1 pasos/);
  assert.match(r.reply, /Falta: /);
  assert.match(r.reply, /escribe 'continúa'/i);
});

test("Regresión 3: tope de tokens se distingue del de pasos", async (t) => {
  const e = entorno(t, [paso([call("leer_buzon", {}, "buzon")], "", 100_000)], 100_000);
  const r = await e.run("procesa");
  assert.match(r.reply, /tope de tokens/);
  assert.match(r.reply, /Falta: /);
  assert.match(r.reply, /escribe 'continúa'/i);
});

test("Regresión 3: tope de tiempo se distingue y lista lo cancelado", async (t) => {
  conEnv(t, "LLM_TIMEOUT_MS", "50");
  const e = entorno(t, [paso([call("leer_buzon", {}, "b1"), call("leer_buzon", {}, "b2")])]);
  const lento: typeof ejecutarTool = async (n, a, c) => { await new Promise((r) => setTimeout(r, 80)); return ejecutarTool(n, a, c); };
  const r = await e.run("procesa", lento);
  assert.match(r.reply, /tope de tiempo/);
  assert.match(r.reply, /Falta: /);
  assert.match(r.reply, /escribe 'continúa'/i);
});

test("Regresión 4: variantes de puntuación, mayúsculas y espacios de la frase PRD autorizan", async (t) => {
  for (const variante of [`${PRD}.`, `${PRD} `, `Confirmo el valor 0 y la fecha fin 2027-08-31!`, `confirmo  el valor 0  y la fecha fin 2027-08-31`, `Confirmo: el valor 0 y la fecha fin 2027-08-31.`, `confirmo el valor 0, y la fecha de fin 2027-08-31`, `confirmo valor 0 y fecha fin 2027-08-31`]) {
    const e = entorno(t, [paso([call("registrar", { mensaje_id: "msg-006", hoy: HOY })])]);
    await e.run("procesa");
    const r = await e.run(variante);
    assert.equal(r.needsConfirmation, null, variante);
    assert.equal(r.toolCalls[0]?.ok, true, variante);
  }
});

test("Regresión 4: un mensaje que no es decisión deja la revisión pendiente y lista frases aceptadas", async (t) => {
  const e = entorno(t, [paso([call("registrar", { mensaje_id: "msg-006", hoy: HOY })])]);
  const r1 = await e.run("procesa");
  const r = await e.run("¿por qué el valor es 0?");
  assert.equal(r.needsConfirmation?.reviewId, r1.needsConfirmation?.reviewId);
  assert.ok(r.reply.includes(PRD), r.reply);
  assert.ok(r.reply.includes(`confirmo revisión ${r1.needsConfirmation?.reviewId}`));
  assert.ok(r.reply.includes("rechazo el registro de msg-006"));
  const ok = await e.run(PRD);
  assert.equal(ok.needsConfirmation, null);
});
