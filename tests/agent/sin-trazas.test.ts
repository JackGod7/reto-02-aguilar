import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const raiz = resolve(import.meta.dirname, "../..");
const url = (p: string): string => pathToFileURL(resolve(raiz, p)).href;

// Proceso hijo: las variables deben estar en true ANTES de importar LangChain, como en un despliegue mal configurado.
const hijo = `
import { createServer } from "node:http";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const peticiones = [];
const srv = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    peticiones.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end(req.url.startsWith("/v1/messages") ? JSON.stringify({ id: "msg_local", type: "message", role: "assistant", model: "local", content: [{ type: "text", text: "hola local" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 3, output_tokens: 2 } }) : "{}");
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + srv.address().port;
process.env.LANGSMITH_ENDPOINT = base + "/smith";
process.env.LANGCHAIN_ENDPOINT = base + "/smith";
const { crearAnthropicAdapter } = await import(${JSON.stringify(url("src/llm/anthropic.ts"))});
const { ejecutarTurnoGrafo } = await import(${JSON.stringify(url("src/agent/graph.ts"))});
const { crearSesion } = await import(${JSON.stringify(url("src/agent/session.ts"))});
const { ChatAnthropic } = await import("@langchain/anthropic");
const adapter = crearAnthropicAdapter({ ANTHROPIC_API_KEY: "clave-falsa-local" }, (c) => new ChatAnthropic({ ...c, anthropicApiUrl: base }));
const dir = mkdtempSync(join(tmpdir(), "reto-sin-trazas-"));
cpSync(${JSON.stringify(resolve(raiz, "fixtures"))}, join(dir, "fixtures"), { recursive: true });
const r = await ejecutarTurnoGrafo({ adapter, session: crearSesion(), directory: dir, message: "hola", prompt: "datos", maxTokens: 100000 });
await new Promise((ok) => setTimeout(ok, 1500));
rmSync(dir, { recursive: true, force: true });
srv.close();
console.log(JSON.stringify({ reply: r.reply, peticiones, env: [process.env.LANGSMITH_TRACING, process.env.LANGCHAIN_TRACING_V2] }));
`;

test("Regresión 6: con LANGSMITH_TRACING y LANGCHAIN_TRACING_V2 en true no sale ningún request de trazas", async () => {
  const salida = await new Promise<string>((ok, mal) => {
    execFile(process.execPath, ["--input-type=module", "-e", hijo], {
      cwd: raiz, timeout: 20_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANGSMITH_TRACING: "true", LANGCHAIN_TRACING_V2: "true", LANGCHAIN_TRACING: "true", LANGSMITH_TRACING_V2: "true", LANGSMITH_API_KEY: "clave-falsa-local", LANGCHAIN_API_KEY: "clave-falsa-local" },
    }, (error, stdout, stderr) => error ? mal(new Error(`${error.message}\n${stderr}`)) : ok(stdout));
  });
  const r = JSON.parse(salida.trim().split("\n").at(-1) ?? "{}") as { reply: string; peticiones: string[]; env: string[] };
  assert.ok(r.reply.startsWith("hola local"), r.reply);
  assert.deepEqual(r.peticiones.filter((p) => !p.startsWith("/v1/messages")), [], "ninguna petición a LangSmith");
  assert.equal(r.peticiones.length, 1, "solo la llamada al modelo");
  assert.deepEqual(r.env, ["false", "false"]);
});
