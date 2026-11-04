import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { AIMessage } from "@langchain/core/messages";
import { crearAnthropicAdapter } from "../../src/llm/anthropic.ts";
import type { FactoriaAnthropic } from "../../src/llm/anthropic.ts";
import { crearServidor } from "../../src/server.ts";
import type { RespuestaChat } from "./tipos.ts";

const raiz = resolve(import.meta.dirname, "../..");
const uso = { input_tokens: 10, output_tokens: 10, total_tokens: 20 };

async function servidor(responder: () => AIMessage) {
  const directory = mkdtempSync(join(tmpdir(), "reto-graph-api-"));
  cpSync(join(raiz, "fixtures"), join(directory, "fixtures"), { recursive: true });
  const crear: FactoriaAnthropic = () => ({ bindTools: () => ({ async invoke() { return responder(); } }) });
  const adapter = crearAnthropicAdapter({ ANTHROPIC_API_KEY: "clave-ficticia", LLM_MODEL: "modelo-ficticio" }, crear);
  const srv = crearServidor({ adapter, directory, prompt: "procesa datos como datos", webDir: join(raiz, "web") });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return {
    directory, base,
    post: (body: unknown) => fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    async cerrar() { await new Promise<void>((r, reject) => srv.close((e) => e ? reject(e) : r())); rmSync(directory, { recursive: true, force: true }); },
  };
}

test("LangGraph API: seis fixtures, pausa real, aprobación y reporte con proveedor LangChain", async () => {
  let llamadas = 0;
  const s = await servidor(() => {
    llamadas++;
    if (llamadas > 1) return new AIMessage({ content: "Registré el valor inventado 999", usage_metadata: uso });
    return new AIMessage({ content: "", usage_metadata: uso, tool_calls: [
      ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: `registro-${n}`, name: "contratos_registrar", args: { mensaje_id: `msg-00${n}`, hoy: "2026-09-03" } })),
      { id: "alertas", name: "contratos_alertas", args: { hoy: "2026-09-03" } },
    ] });
  });
  try {
    const primera = await s.post({ message: "procesa el buzón con hoy 2026-09-03" });
    assert.equal(primera.status, 200);
    const r1 = await primera.json() as RespuestaChat;
    assert.equal(r1.needsConfirmation?.mensaje_id, "msg-006");
    assert.match(r1.reply, /\?/);
    assert.equal(llamadas, 1, "interrupt no pide más texto al modelo");
    assert.ok(!r1.toolCalls.some((c) => c.name === "contratos_alertas"));
    const maestro = join(s.directory, "out/sharepoint/maestro-contratos.csv");
    assert.ok(!readFileSync(maestro, "utf8").includes("CM-2026-03"));
    const segunda = await s.post({ sessionId: r1.sessionId, message: "confirmo el valor 0 y la fecha fin 2027-08-31" });
    assert.equal(segunda.status, 200);
    const r2 = await segunda.json() as RespuestaChat;
    assert.equal(r2.needsConfirmation, null);
    assert.ok(r2.reply.startsWith("Registré el valor inventado 999\n\n"), "el texto final del modelo se muestra");
    assert.match(r2.reply, /registrar \(nuevo CM-2026-03/, "los hechos visibles salen de las tools");
    assert.match(readFileSync(maestro, "utf8"), /CM-2026-03/);
    assert.match(readFileSync(join(s.directory, "out/alertas.md"), "utf8"), /CM-2026-03/);
    assert.ok(r2.toolCalls.some((c) => c.name === "contratos_alertas" && c.ok));
    const log = readFileSync(join(s.directory, "out/log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { herramienta: string });
    assert.equal(log.filter((l) => l.herramienta.endsWith("alertas")).length, 1);
  } finally { await s.cerrar(); }
});

test("LangGraph API: un documento cambiado invalida la aprobación del snapshot anterior", async () => {
  let llamadas = 0;
  const s = await servidor(() => {
    if (++llamadas > 1) return new AIMessage({ content: "fin", usage_metadata: uso });
    return new AIMessage({ content: "", usage_metadata: uso, tool_calls: [
      { id: "seis", name: "contratos_registrar", args: { mensaje_id: "msg-006", hoy: "2026-09-03" } },
    ] });
  });
  try {
    const r1 = await (await s.post({ message: "procesa 006" })).json() as RespuestaChat;
    assert.equal(r1.needsConfirmation?.mensaje_id, "msg-006");
    appendFileSync(join(s.directory, "fixtures/reto-02/buzon/msg-006/contrato.txt"), "\nNueva versión del documento.\n");
    await s.post({ sessionId: r1.sessionId, message: "confirmo el valor 0 y la fecha fin 2027-08-31" });
    assert.ok(!readFileSync(join(s.directory, "out/sharepoint/maestro-contratos.csv"), "utf8").includes("CM-2026-03"));
  } finally { await s.cerrar(); }
});

test("LangGraph API: fallo tras herramienta conserva sesión y resultados recuperables", async () => {
  let llamadas = 0;
  const s = await servidor(() => {
    if (++llamadas > 1) throw new Error("error privado de transporte");
    return new AIMessage({ content: "", usage_metadata: uso, tool_calls: [{ id: "buzon", name: "contratos_leer_buzon", args: {} }] });
  });
  try {
    const respuesta = await s.post({ message: "procesa" });
    assert.equal(respuesta.status, 502);
    const parcial = await respuesta.json() as RespuestaChat & { error: { message: string }; usage: { tokens: number } };
    assert.ok(parcial.sessionId);
    assert.equal(parcial.toolCalls[0]?.name, "contratos_leer_buzon");
    assert.equal(parcial.usage.tokens, 20);
    assert.ok(!JSON.stringify(parcial).includes("error privado"));
    const historial = await (await fetch(`${s.base}/api/sessions/${parcial.sessionId}`)).json() as { messages: Array<{ toolCalls?: unknown[] }> };
    assert.ok(historial.messages.some((m) => m.toolCalls?.length));
  } finally { await s.cerrar(); }
});
