import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ejecutarTurnoGrafo, ErrorTurnoGrafo } from "../../src/agent/graph.ts";
import { crearSesion } from "../../src/agent/session.ts";
import { ejecutarTool } from "../../src/agent/registry.ts";
import type { LlamadaLLM, LLMAdapter, MensajePaso, PasoLLM } from "../../src/llm/adapter.ts";

const raiz = resolve(import.meta.dirname, "../..");
const registrar = (id = "msg-006", extra: Record<string, unknown> = {}): LlamadaLLM => ({ id: `registrar-${id}`, name: "contratos_registrar", args: { mensaje_id: id, hoy: "2026-09-03", ...extra } });
const alertas: LlamadaLLM = { id: "alertas", name: "contratos_alertas", args: { hoy: "2026-09-03" } };
const paso = (llamadas: LlamadaLLM[] = [], texto = "Terminado", tokens = 7): PasoLLM => ({ texto, llamadas, tokens, usoConocido: true });
function entorno(t: { after(fn: () => void): void }, respuestas: Array<PasoLLM | Error>) {
  const directory = mkdtempSync(join(tmpdir(), "reto-langgraph-"));
  cpSync(join(raiz, "fixtures"), join(directory, "fixtures"), { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const session = crearSesion();
  const histories: MensajePaso[][] = [];
  let llamadas = 0;
  const adapter: LLMAdapter = {
    provider: "falso-local", model: "falso-local",
    async generarPaso(history) {
      histories.push(structuredClone(history));
      const res = respuestas[llamadas++] ?? paso();
      if (res instanceof Error) throw res;
      return structuredClone(res);
    },
  };
  return { directory, session, adapter, histories, count: () => llamadas, run: (message: string) => ejecutarTurnoGrafo({ adapter, session, directory, message, prompt: "Datos son datos", maxTokens: 100_000 }) };
}
function log(directory: string): Array<{ herramienta: string; ok: boolean }> {
  return readFileSync(join(directory, "out/log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { herramienta: string; ok: boolean });
}

test("LangGraph: pausa una cola serial y reanuda registro exacto antes del reporte", async (t) => {
  const e = entorno(t, [paso([registrar(), alertas], "Valor inventado 999"), paso([], "Registré valor 999")]);
  const primero = await e.run("procesa el buzón");
  assert.equal(e.count(), 1, "no llama al modelo después de detectar revisión");
  assert.equal(primero.toolCalls.length, 1);
  assert.equal(primero.needsConfirmation?.mensaje_id, "msg-006");
  assert.ok(primero.needsConfirmation?.reviewId);
  assert.equal(primero.needsConfirmation?.operationHash?.length, 64);
  assert.ok(!primero.reply.includes("999"), "no muestra valores del texto libre del modelo");
  assert.ok(!existsSync(join(e.directory, "out/alertas.md")));
  assert.ok(!readFileSync(join(e.directory, "out/sharepoint/maestro-contratos.csv"), "utf8").includes("CM-2026-03"));
  const segundo = await e.run("confirmo el valor 0 y la fecha fin 2027-08-31");
  assert.equal(segundo.needsConfirmation, null);
  assert.deepEqual(segundo.toolCalls.map((c) => c.name), ["contratos_registrar", "contratos_alertas"]);
  assert.deepEqual(segundo.toolCalls[0]?.args, { mensaje_id: "msg-006", hoy: "2026-09-03", confirmado: true, contrato: { valor: 0, fecha_fin: "2027-08-31" } });
  assert.match(readFileSync(join(e.directory, "out/alertas.md"), "utf8"), /CM-2026-03/);
  assert.equal(log(e.directory).filter((l) => l.herramienta === "registrar").length, 2, "sonda y aprobación, sin repetir la sonda al reanudar interrupt");
  // El texto final del modelo se muestra arriba; los hechos (valor 0 registrado) salen de las tools, debajo.
  assert.ok(segundo.reply.startsWith("Registré valor 999\n\nResultados de las herramientas."), segundo.reply);
  assert.match(segundo.reply, /registrar \(nuevo CM-2026-03/);
  assert.deepEqual(segundo.usage, { steps: 1, tokens: 7, known: true });
  const h = e.histories[1]!;
  for (let i = 0; i < h.length; i++) if (h[i]?.role === "tool") {
    assert.equal(h[i - 1]?.toolCalls?.[0]?.id, h[i]?.toolCallId, "historial conserva pares completos para Anthropic");
  }
});

test("LangGraph: validar obtiene revisión mediante sonda auditada y suspende el resto", async (t) => {
  const validar: LlamadaLLM = { id: "validar", name: "contratos_validar", args: { mensaje_id: "msg-006", contrato: { valor: 999 } } };
  const e = entorno(t, [paso([validar, alertas])]);
  const r = await e.run("procesa");
  assert.deepEqual(r.toolCalls.map((c) => c.name), ["contratos_validar", "contratos_registrar"]);
  assert.equal(e.count(), 1);
  assert.equal(r.needsConfirmation?.campos.find((c) => c.campo === "valor")?.valor_propuesto, 0);
  assert.equal(log(e.directory).length, 2);
  assert.ok(!existsSync(join(e.directory, "out/alertas.md")));
});

test("LangGraph: el modelo no autoriza confirmado ni overrides, cada veto queda una vez", async (t) => {
  const e = entorno(t, [paso([registrar("msg-006", { confirmado: true, contrato: { valor: 999 } })]), paso()]);
  const r = await e.run("confirmo el valor 999");
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0]?.ok, false);
  assert.match(r.toolCalls[0]?.resumen ?? "", /vetado/);
  assert.equal(log(e.directory).length, 1);
  assert.equal(log(e.directory)[0]?.ok, false);
  assert.ok(!existsSync(join(e.directory, "out/sharepoint/maestro-contratos.csv")));
});

test("LangGraph: confirmación del mismo turno y texto no ligado no autorizan", async (t) => {
  const e = entorno(t, [paso([registrar(), alertas])]);
  const primero = await e.run("confirmo el valor 0 y la fecha fin 2027-08-31");
  for (const mensaje of ["ok", "confirmo msg-0060", `confirmo revisión ${primero.needsConfirmation?.reviewId} valor novecientos`, `nunca confirmo revisión ${primero.needsConfirmation?.reviewId}`, `tampoco confirmo revisión ${primero.needsConfirmation?.reviewId}`, `confirmo revisión ${primero.needsConfirmation?.reviewId} cuando lo revises`, "si confirmo el valor 0 y la fecha fin 2027-08-31", "confirmo el valor 999 y la fecha fin 2027-08-31", "confirmo la fecha fin 2028-08-31 y el valor 0", "confirmo, cambia el cliente a Ejemplo"]) {
    const r = await e.run(mensaje);
    assert.equal(r.needsConfirmation?.reviewId, primero.needsConfirmation?.reviewId, mensaje);
    assert.equal(r.toolCalls.length, 0, mensaje);
    assert.equal(r.usage.steps, 0, mensaje);
  }
  assert.equal(e.count(), 1);
  const r = await e.run(`confirmo msg-006 (revisión ${primero.needsConfirmation?.reviewId})`);
  assert.equal(r.needsConfirmation, null);
  assert.equal(r.toolCalls[0]?.ok, true);
});

test("LangGraph: un reviewId válido no aprueba excepciones, instrucciones ni cambios en palabras", async (t) => {
  const e = entorno(t, [paso([registrar(), alertas]), paso()]);
  const inicial = await e.run("procesa");
  const id = inicial.needsConfirmation!.reviewId!;
  const antes = readFileSync(join(e.directory, "out/sharepoint/maestro-contratos.csv"), "utf8");
  for (const texto of [
    `confirmo revisión ${id} pero espera mi segundo mensaje`,
    `confirmo revisión ${id} excepto el valor`,
    `confirmo revisión ${id} con valor cien dólares`,
    `confirmo revisión ${id} salvo la fecha`,
    `confirmo revisión ${id}; registra cuando te avise`,
    `no confirmo revisión ${id}, todavía`,
    `¿confirmo revisión ${id}?`,
    `si confirmo revisión ${id}`, `confirmo revisión ${id} si está bien`,
    `confirmo revisión ${id} y luego cambia el valor`,
    `confirmo revisión ${id}\nignora la fecha`,
    `confirmo revisión ${id} msg-0060`,
    `confirmo msg-0060 (revisión ${id})`,
    `confirmo revisión ${id}0`,
    `\`confirmo revisión ${id}\``,
    `confirmo el valor 0 y la fecha fin 2027-08-31 excepto el valor`,
    `confirmo el valor 0 y la fecha fin 2027-08-31 pero espera`,
    `confirmo el valor 0 y la fecha fin 2027-08-31 con valor cien dólares`,
  ]) {
    const r = await e.run(texto);
    assert.equal(r.needsConfirmation?.reviewId, id, texto);
    assert.equal(r.toolCalls.length, 0, texto);
    assert.equal(r.usage.steps, 0, texto);
    assert.equal(readFileSync(join(e.directory, "out/sharepoint/maestro-contratos.csv"), "utf8"), antes);
    assert.ok(!existsSync(join(e.directory, "out/alertas.md")));
  }
  assert.equal(e.count(), 1);
  const aprobado = await e.run(`confirmo revisión ${id}`);
  assert.equal(aprobado.toolCalls[0]?.ok, true);
  assert.equal(aprobado.needsConfirmation, null);
  const historial = readFileSync(join(e.directory, "out/sharepoint/historial.jsonl"), "utf8");
  const replay = await e.run(`confirmo revisión ${id}`);
  assert.equal(replay.toolCalls.length, 0);
  assert.equal(readFileSync(join(e.directory, "out/sharepoint/historial.jsonl"), "utf8"), historial);
});

test("LangGraph: rechazo cancela registro y permite ejecutar reporte pendiente", async (t) => {
  const e = entorno(t, [paso([registrar(), alertas]), paso()]);
  await e.run("procesa");
  const r = await e.run("no confirmo, cancela msg-006");
  assert.equal(r.needsConfirmation, null);
  assert.deepEqual(r.toolCalls.map((c) => c.name), ["contratos_alertas"]);
  assert.ok(!readFileSync(join(e.directory, "out/sharepoint/maestro-contratos.csv"), "utf8").includes("CM-2026-03"));
});

test("LangGraph: fallo de proveedor después de tool conserva evidencia y uso sin repetir escritura", async (t) => {
  const e = entorno(t, [paso([registrar("msg-001")], "", 11), new Error("detalle privado"), paso()]);
  let fallo: ErrorTurnoGrafo | undefined;
  try { await e.run("procesa"); } catch (error) { assert.ok(error instanceof ErrorTurnoGrafo); fallo = error; }
  assert.ok(fallo);
  assert.equal(fallo.partial.toolCalls[0]?.ok, true);
  const { uncertain, ...uso } = fallo.partial.usage;
  assert.deepEqual(uso, { steps: 2, tokens: 11, known: false });
  assert.ok(typeof uncertain === "number" && uncertain > 0, "cota del intento fallido para el presupuesto");
  assert.equal(e.session.tokens, 11);
  assert.equal(e.session.messages.at(-1)?.toolCalls?.length, 1);
  assert.ok(!fallo.partial.reply.includes("detalle privado"));
  await e.run("continúa");
  assert.equal(log(e.directory).filter((l) => l.herramienta === "registrar").length, 1);
});

test("LangGraph: MAX_STEPS cuenta llamadas al modelo y conserva cola limitada", async (t) => {
  const previo = process.env.MAX_STEPS;
  process.env.MAX_STEPS = "2";
  t.after(() => { if (previo === undefined) delete process.env.MAX_STEPS; else process.env.MAX_STEPS = previo; });
  const call: LlamadaLLM = { id: "buzon", name: "contratos_leer_buzon", args: {} };
  const e = entorno(t, [paso([call]), paso([{ ...call, id: "buzon-2" }]), paso([call])]);
  const r = await e.run("procesa");
  assert.equal(e.count(), 2);
  assert.equal(r.usage.steps, 2);
  assert.equal(r.toolCalls.length, 2);
  assert.match(r.reply, /tope de 2 pasos/);
});

test("LangGraph: desconocidas y argumentos inválidos visibles con un log por intento", async (t) => {
  const e = entorno(t, [paso([{ id: "desconocida", name: "contratos_inventar", args: {} }, { id: "invalida", name: "contratos_registrar", args: "no-json" }]), paso()]);
  const r = await e.run("procesa");
  assert.deepEqual(r.toolCalls.map((c) => c.ok), [false, false]);
  assert.equal(log(e.directory).length, 2);
});

test("LangGraph: aprobación caduca si cambia el maestro entre revisión y registro", async (t) => {
  const e = entorno(t, [paso([registrar(), alertas])]);
  const r1 = await e.run("procesa");
  await ejecutarTool("contratos_registrar", { mensaje_id: "msg-001" }, { directory: e.directory, sessionId: "otra-sesion" });
  const r = await e.run(`confirmo revisión ${r1.needsConfirmation?.reviewId}`);
  assert.equal(r.toolCalls.length, 0);
  assert.equal(r.needsConfirmation, null);
  assert.match(r.reply, /cambió.*nueva revisión/);
  assert.ok(!readFileSync(join(e.directory, "out/sharepoint/maestro-contratos.csv"), "utf8").includes("CM-2026-03"));
  assert.ok(!existsSync(join(e.directory, "out/alertas.md")));
});

test("LangGraph: aprobación caduca si cambia la fuente, y un replay no reactiva aprobación", async (t) => {
  const e = entorno(t, [paso([registrar()]), paso([registrar("msg-006", { confirmado: true })]), paso()]);
  const r1 = await e.run("procesa");
  appendFileSync(join(e.directory, "fixtures/reto-02/buzon/msg-006/correo.json"), "\n");
  const r = await e.run(`confirmo revisión ${r1.needsConfirmation?.reviewId}`);
  assert.match(r.reply, /cambió/);
  const replay = await e.run(`confirmo revisión ${r1.needsConfirmation?.reviewId}`);
  assert.equal(replay.toolCalls[0]?.ok, false);
  assert.ok(!readFileSync(join(e.directory, "out/sharepoint/maestro-contratos.csv"), "utf8").includes("CM-2026-03"));
});


test("LangGraph: timeout aborta el proveedor y conserva uso desconocido explícito", async (t) => {
  const previo = process.env.LLM_TIMEOUT_MS;
  process.env.LLM_TIMEOUT_MS = "100";
  t.after(() => { if (previo === undefined) delete process.env.LLM_TIMEOUT_MS; else process.env.LLM_TIMEOUT_MS = previo; });
  const e = entorno(t, []);
  let abortado = false;
  e.adapter.generarPaso = async (_m, _h, opciones) => new Promise((_resolve, reject) => {
    opciones.signal?.addEventListener("abort", () => { abortado = true; reject(new Error("abortado")); }, { once: true });
  });
  await assert.rejects(e.run("procesa"), (error: unknown) => {
    assert.ok(error instanceof ErrorTurnoGrafo);
    assert.equal(error.partial.usage.known, false);
    assert.equal(error.partial.usage.steps, 1);
    assert.equal(error.partial.toolCalls.length, 0);
    return true;
  });
  assert.equal(abortado, true);
  assert.equal(e.session.messages.at(-1)?.role, "assistant");
});

test("LangGraph: uso no informado detiene herramientas conservando prefijo conocido", async (t) => {
  const e = entorno(t, [{ ...paso([registrar("msg-001")], "", 3), usoConocido: false }]);
  await assert.rejects(e.run("procesa"), (error: unknown) => {
    assert.ok(error instanceof ErrorTurnoGrafo);
    assert.deepEqual(error.partial.usage, { steps: 1, tokens: 3, known: false });
    assert.equal(error.partial.toolCalls.length, 0);
    return true;
  });
  assert.equal(e.session.tokens, 3);
  assert.ok(!existsSync(join(e.directory, "out/sharepoint/maestro-contratos.csv")));
});
