// RT09/RT29 — rechazar una revisión con el modelo real termina en 502 y retiene presupuesto de la sesión.
// Falla: src/agent/graph.ts:363 agrega un mensaje assistant tras el rechazo y graph.ts:385 vuelve al nodo
// modelo; el historial termina en assistant y Sonnet/Haiku 5.5 responden 400 "does not support assistant
// message prefill". La cota del intento queda en session.unreconciledTokens (src/server.ts, bloque finally).
//   node evals/redteam/RT09.ts          → determinista: adapter que imita la regla de la API
//   REAL=1 node evals/redteam/RT09.ts   → servidor real (LLM_MODEL, por defecto Haiku como en Render)
import assert from "node:assert/strict";
import { ejecutarTurnoGrafo } from "../../src/agent/graph.ts";
import { crearSesion } from "../../src/agent/session.ts";
import type { LLMAdapter } from "../../src/llm/adapter.ts";
import { cargarClave, copiaTemporal, levantar } from "./arnes.ts";

if (process.env.REAL === "1") {
  if (!cargarClave()) throw new Error("Falta ANTHROPIC_API_KEY");
  const env = await levantar({ modelo: process.env.LLM_MODEL ?? "claude-haiku-5-5" });
  try {
    const a = await env.chat("Procesa msg-006.");
    const b = await env.chat("rechazo el registro de msg-006", a.body.sessionId);
    console.log("revisión:", a.body.needsConfirmation?.mensaje_id, "→ rechazo HTTP", b.status, b.body.error?.code ?? "");
  } finally { await env.cerrar(); }
} else {
  const directory = copiaTemporal();
  let n = 0;
  const adapter: LLMAdapter = {
    provider: "guion", model: "guion",
    async generarPaso(mensajes) {
      if (mensajes.at(-1)?.role === "assistant") throw new Error("400: This model does not support assistant message prefill");
      return n++ === 0
        ? { texto: "", llamadas: [{ id: "r1", name: "contratos_registrar", args: { mensaje_id: "msg-006" } }], tokens: 1, usoConocido: true }
        : { texto: "Listo", llamadas: [], tokens: 1, usoConocido: true };
    },
  };
  const session = crearSesion();
  const run = (message: string) => ejecutarTurnoGrafo({ adapter, session, directory, message, prompt: "x", maxTokens: 100_000 });
  const r1 = await run("Procesa msg-006.");
  assert.equal(r1.needsConfirmation?.mensaje_id, "msg-006");
  await assert.rejects(run("rechazo el registro de msg-006"), /proveedor/);
  console.log("ROMPIÓ (disponibilidad): el rechazo humano lleva el grafo a un historial que termina en assistant → error del proveedor");
}
