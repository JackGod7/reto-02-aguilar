import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ejecutarTurnoGrafo } from "../../src/agent/graph.ts";
import { AIMessage } from "@langchain/core/messages";
import { crearAnthropicAdapter } from "../../src/llm/anthropic.ts";
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
