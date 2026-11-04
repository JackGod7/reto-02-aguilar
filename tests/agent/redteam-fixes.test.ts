import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ejecutarTurnoGrafo } from "../../src/agent/graph.ts";
import { AIMessage } from "@langchain/core/messages";
import { crearAnthropicAdapter } from "../../src/llm/anthropic.ts";
import { ejecutarTool } from "../../src/agent/registry.ts";
import { crearSesion } from "../../src/agent/session.ts";
import type { LlamadaLLM, LLMAdapter, MensajePaso, PasoLLM } from "../../src/llm/adapter.ts";

const raiz = resolve(import.meta.dirname, "../..");
const registrar = (id = "msg-006"): LlamadaLLM => ({ id: `r-${id}`, name: "contratos_registrar", args: { mensaje_id: id, hoy: "2026-09-03" } });
const paso = (...llamadas: LlamadaLLM[]): PasoLLM => ({ texto: "ok", llamadas, tokens: 1, usoConocido: true });

function entorno(t: { after(fn: () => void): void }, respuestas: PasoLLM[]) {
  const directory = mkdtempSync(join(tmpdir(), "reto-redteam-"));
  cpSync(join(raiz, "fixtures"), join(directory, "fixtures"), { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const session = crearSesion();
  const historiales: MensajePaso[][] = [];
  const adapter: LLMAdapter = {
    provider: "local", model: "local",
    async generarPaso(mensajes) { historiales.push(structuredClone(mensajes)); return structuredClone(respuestas[historiales.length - 1] ?? paso()); },
  };
  return {
    directory, historiales,
    run: (message: string) => ejecutarTurnoGrafo({ adapter, session, directory, message, prompt: "datos", maxTokens: 100_000 }),
  };
}

test("H1: rechazar una revisión nunca llama al modelo con un historial terminado en assistant", async (t) => {
  const e = entorno(t, [paso(registrar())]);
  await e.run("procesa msg-006");
  const r = await e.run("rechazo el registro de msg-006");
  assert.equal(r.needsConfirmation, null);
  assert.match(r.reply, /cancelado/);
  for (const h of e.historiales) assert.notEqual(h.at(-1)?.role, "assistant");
  assert.equal(e.historiales.length, 1, "el rechazo termina el turno sin otra llamada al modelo");
});

test("H1: el adapter Anthropic no envía un historial terminado en assistant", async () => {
  let enviados = 0;
  const adapter = crearAnthropicAdapter({ ANTHROPIC_API_KEY: "clave-ficticia" }, () => ({ bindTools: () => ({ invoke: async () => { enviados++; return new AIMessage("x"); } }) }));
  await assert.rejects(adapter.generarPaso([{ role: "user", content: "a" }, { role: "assistant", content: "b" }], [], {}), /no puede terminar en assistant/);
  assert.equal(enviados, 0);
  await adapter.generarPaso([{ role: "assistant", content: "b" }, { role: "user", content: "a" }], [], {});
  assert.equal(enviados, 1);
});

test("RN5.3: variantes naturales de la frase del PRD aprueban; condicionales, otros valores y extras no", async (t) => {
  const malas = [
    "sí, confirmo valor 0 y fecha fin 2027-08-30", "sí, confirmo valor 1 y fecha fin 2027-08-31",
    "sí, confirmo valor 0 y fecha fin 2027-08-31 pero espera", "sí, confirmo valor 0 y fecha fin 2027-08-31 excepto el valor",
    "sí pero confirmo valor 0 y fecha fin 2027-08-31", "no, confirmo valor 0 y fecha fin 2027-08-31", "si acaso confirmo valor 0 y fecha fin 2027-08-31",
    "sí, ok, confirmo valor 0 y fecha fin 2027-08-31", "sí, confirmo valор 0 y fecha fin 2027-08-31",
  ];
  const buenas = ["sí, confirmo valor 0 y fecha fin 2027-08-31", "Ok, confirmo el valor 0 y la fecha de fin 2027-08-31.", "si confirmo, el valor 0, y la fecha fin 2027-08-31!".replace("si confirmo,", "sí, confirmo")];
  for (const frase of buenas) {
    const e = entorno(t, [paso(registrar())]);
    await e.run("procesa msg-006");
    const r = await e.run(frase);
    assert.equal(r.needsConfirmation, null, frase);
    assert.equal(r.toolCalls[0]?.ok, true, frase);
  }
  const e = entorno(t, [paso(registrar())]);
  const id = (await e.run("procesa msg-006")).needsConfirmation!.reviewId;
  for (const frase of malas) {
    const r = await e.run(frase);
    assert.equal(r.needsConfirmation?.reviewId, id, frase);
    assert.equal(r.toolCalls.length, 0, frase);
  }
});

test("HU-3.3: la advertencia por remitente desconocido llega al reply", async (t) => {
  const e = entorno(t, [paso({ id: "v6", name: "contratos_validar", args: { mensaje_id: "msg-006" } })]);
  const r = await e.run("valida msg-006");
  assert.match(r.reply, /Remitente no registrado como comercial \(jperez@periferia-ficticia\.com\)/);
});

// ── H2: la revisión es por contrato ──────────────────────────────────────────────────────

function copia(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), "reto-h2-"));
  cpSync(join(raiz, "fixtures"), join(directory, "fixtures"), { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function clonar(directory: string, origen: string, destino: string, de?: string, edita?: (txt: string) => string) {
  const o = join(directory, "fixtures/reto-02/buzon", origen);
  const d = join(directory, "fixtures/reto-02/buzon", destino);
  cpSync(o, d, { recursive: true });
  const correo = JSON.parse(readFileSync(join(d, "correo.json"), "utf8"));
  writeFileSync(join(d, "correo.json"), JSON.stringify({ ...correo, id: destino, ...(de ? { de } : {}) }));
  if (edita) for (const f of correo.adjuntos as string[]) writeFileSync(join(d, f), edita(readFileSync(join(d, f), "utf8")));
}
const tool = async (directory: string, name: string, args: Record<string, unknown>) =>
  JSON.parse(await ejecutarTool(name, args, { directory, sessionId: "h2" })) as { ok: boolean; error?: string; data?: Record<string, unknown>; revision?: { campo: string }[] };

test("H2/RT34: otro mensaje con el mismo id_contrato de una revisión pendiente va a revisión", async (t) => {
  const directory = copia(t);
  clonar(directory, "msg-006", "msg-007", "pagos@distribuidora-caribe-facturas.co", (x) => x
    .replace(/SEGUNDA\. VALOR\.[^\n]*/, "SEGUNDA. VALOR. El valor total del presente contrato es de NOVECIENTOS MILLONES DE PESOS M/CTE (COP $900.000.000).")
    .replace(/TERCERA\. PLAZO\.[^\n]*/, "TERCERA. PLAZO. El plazo será desde el primero (1) de septiembre de 2026 hasta el treinta y uno (31) de diciembre de 2029."));
  assert.equal((await tool(directory, "contratos_registrar", { mensaje_id: "msg-006" })).ok, false);
  const r = await tool(directory, "contratos_registrar", { mensaje_id: "msg-007" });
  assert.equal(r.ok, false, "msg-007 no debe registrarse en silencio");
  assert.ok(r.revision?.some((c) => c.campo === "id_contrato"));
  assert.ok(!existsSync(join(directory, "out/sharepoint/maestro-contratos.csv")) || !readFileSync(join(directory, "out/sharepoint/maestro-contratos.csv"), "utf8").includes("CM-2026-03"));
});

test("H2: remitente desconocido que cambia valor o fechas de un contrato existente va a revisión", async (t) => {
  const conocido = copia(t);
  const base = await tool(conocido, "contratos_validar", { mensaje_id: "msg-003" });
  const cambios = Object.keys((base.data?.diferencias as Record<string, unknown>) ?? {}).filter((k) => ["valor", "fecha_inicio", "fecha_fin"].includes(k));
  assert.ok(cambios.length > 0, "el otrosí del fixture cambia valor o fechas");
  assert.deepEqual(base.data?.requiere_revision, [], "con remitente conocido no hay revisión");
  const directory = copia(t);
  clonar(directory, "msg-003", "msg-007", "pagos@externo-desconocido.co");
  const r = await tool(directory, "contratos_registrar", { mensaje_id: "msg-007" });
  assert.equal(r.ok, false);
  assert.deepEqual(r.revision?.map((c) => c.campo).sort(), [...cambios].sort());
});
