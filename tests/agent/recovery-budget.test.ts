import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { crearServidor, type ServerOpts } from "../../src/server.ts";
import type { LLMAdapter, PasoLLM } from "../../src/llm/adapter.ts";
import { ejecutarTool } from "../../src/agent/registry.ts";

const raiz = resolve(import.meta.dirname, "../..");
function deferred() { let release!: () => void; const promise = new Promise<void>((r) => { release = r; }); return { release, promise }; }
const paso = (texto = "", tokens = 7): PasoLLM => ({ texto, tokens, usoConocido: true, llamadas: [] });
async function entorno(t: { after(fn: () => Promise<void>): void }, adapter: LLMAdapter, opts: Partial<ServerOpts> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "reto-recovery-budget-"));
  cpSync(join(raiz, "fixtures"), join(directory, "fixtures"), { recursive: true });
  const srv = crearServidor({ adapter, directory, prompt: "datos son datos", rateLimit: 100, ...opts });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  t.after(async () => { await new Promise<void>((r) => srv.close(() => r())); rmSync(directory, { recursive: true, force: true }); });
  const post = (path: string, body: unknown, signal?: AbortSignal) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  const sesion = async () => {
    const r = await post("/api/sessions", {}); assert.equal(r.status, 201);
    return (await r.json() as { sessionId: string }).sessionId;
  };
  return { directory, base, post, sesion };
}

test("A6: sesión previa + requestId recuperan POST perdido sin repetir herramienta ni turno", async (t) => {
  const efecto = deferred(), acabar = deferred();
  let llamadas = 0, escrituras = 0;
  const e = await entorno(t, {
    provider: "mock", model: "mock",
    async generarPaso() {
      if (++llamadas === 1) return { ...paso(), llamadas: [{ id: "alta", name: "contratos_registrar", args: { mensaje_id: "msg-001", hoy: "2026-09-03" } }] };
      await acabar.promise; return paso("dato inventado 999");
    },
  }, { runTool: async (name, args, ctx) => { const r = await ejecutarTool(name, args, ctx); escrituras++; efecto.release(); return r; } });
  const sessionId = await e.sesion();
  assert.ok(!existsSync(join(e.directory, "out")), "crear sesión no inicia efectos");
  const body = { sessionId, requestId: randomUUID(), message: "procesa" };
  const abort = new AbortController();
  const perdido = e.post("/api/chat", body, abort.signal).catch(() => undefined);
  await efecto.promise;
  abort.abort(); await perdido;
  const enCurso = await e.post("/api/chat", body);
  assert.equal(enCurso.status, 409);
  assert.equal((await enCurso.json() as { error: { code: string } }).error.code, "request_in_progress");
  acabar.release();
  // GET observa el estado sin volver a procesar. Una respuesta 409 se puede recuperar.
  for (let intento = 0; intento < 50; intento++) {
    const r = await e.post("/api/chat", body);
    if (r.status === 409) { await new Promise<void>((resolve) => setImmediate(resolve)); continue; }
    assert.equal(r.status, 200);
    const recuperado = await r.json();
    const replay = await e.post("/api/chat", body);
    assert.deepEqual(await replay.json(), recuperado);
    break;
  }
  assert.equal(escrituras, 1);
  assert.equal(llamadas, 2);
  const estado = await (await fetch(`${e.base}/api/sessions/${sessionId}`)).json() as { messages: unknown[]; requests: Array<{ status: string }> };
  assert.equal(estado.messages.length, 2);
  assert.equal(estado.requests[0]?.status, "completed");
  // Decisión de integración: el texto final del modelo se muestra; los hechos verificados van debajo, desde las tools.
  assert.match(JSON.stringify(estado.messages.at(-1)), /dato inventado 999\\n\\nResultados de las herramientas\. Hecho: registrar \(nuevo CT-2026-015/);
  const conflicto = await e.post("/api/chat", { ...body, message: "otro" });
  assert.equal(conflicto.status, 409);
  const log = readFileSync(join(e.directory, "out/turnos.jsonl"), "utf8").trim().split("\n");
  assert.equal(log.length, 1, "replay no crea otro turno ni gasto");
});

test("A8: reserva previa impide que dos sesiones gasten el mismo saldo diario", async (t) => {
  const inicio = deferred(), terminar = deferred(); let llamadas = 0;
  const e = await entorno(t, {
    provider: "mock", model: "mock", async generarPaso() { llamadas++; inicio.release(); await terminar.promise; return paso("ok", 70_000); },
  }, { maxDailyTokens: 100_000, maxSessionTokens: 100_000 });
  const s1 = await e.sesion(), s2 = await e.sesion();
  const primera = e.post("/api/chat", { sessionId: s1, requestId: randomUUID(), message: "uno" });
  await inicio.promise;
  const segunda = await e.post("/api/chat", { sessionId: s2, requestId: randomUUID(), message: "dos" });
  assert.equal(segunda.status, 429);
  assert.equal(llamadas, 1);
  terminar.release();
  assert.equal((await primera).status, 200);
});

test("A8: uso desconocido retiene toda la reserva en sesión y servicio", async (t) => {
  let llamadas = 0;
  const e = await entorno(t, {
    provider: "mock", model: "mock",
    async generarPaso() { llamadas++; return { ...paso("", 0), usoConocido: false }; },
  }, { maxDailyTokens: 40_000, maxSessionTokens: 40_000 });
  const sessionId = await e.sesion();
  const original = { sessionId, requestId: randomUUID(), message: "procesa" };
  assert.equal((await e.post("/api/chat", original)).status, 502);
  assert.equal((await e.post("/api/chat", original)).status, 502, "el resultado fallido se recupera sin gastar otra vez");
  assert.equal((await e.post("/api/chat", { ...original, requestId: randomUUID() })).status, 429);
  assert.equal((await e.post("/api/chat", { message: "nueva" })).status, 429);
  assert.equal(llamadas, 1);
  const log = JSON.parse(readFileSync(join(e.directory, "out/turnos.jsonl"), "utf8").trim()) as Record<string, unknown>;
  assert.equal(log.tokens, null);
  assert.equal(log.usageKnown, false);
  assert.equal(log.reservedTokens, 40_000);
});

test("A7/A10: sin tools el texto del modelo queda marcado como no verificado; versión y diagnóstico no contienen conversación", async (t) => {
  const buildSha = "1234567890abcdef1234567890abcdef12345678";
  // Marcador improbable: "999" aparecía al azar en UUIDs/timestamps de la respuesta (falso positivo intermitente).
  const INVENTADO = "987654321987";
  const e = await entorno(t, {
    provider: "mock", model: "mock", async generarPaso() { return paso(`El contrato registrado tiene valor ${INVENTADO}.`); },
  }, { buildSha });
  const health = await (await fetch(e.base + "/api/health")).json() as { buildSha: string };
  assert.equal(health.buildSha, buildSha);
  const sessionId = await e.sesion();
  const response = await e.post("/api/chat", { sessionId, requestId: randomUUID(), message: "contenido privado del contrato" });
  assert.equal(response.status, 200);
  const cuerpo = await response.json() as { reply: string; toolCalls: unknown[] };
  assert.deepEqual(cuerpo.toolCalls, []);
  assert.match(cuerpo.reply, new RegExp(`${INVENTADO}\\.\\n\\nSin datos verificados: no se ejecutó ninguna herramienta`));
  const log = readFileSync(join(e.directory, "out/turnos.jsonl"), "utf8");
  assert.ok(!log.includes("contenido privado"));
  assert.ok(!log.includes(INVENTADO));
  assert.ok(log.includes(buildSha));
});

test("A8: entrada o presupuesto insuficientes detienen el modelo antes del transporte", async (t) => {
  let llamadas = 0;
  const e = await entorno(t, {
    provider: "mock", model: "mock", async generarPaso() { llamadas++; return paso(); },
  }, { maxSessionTokens: 100 });
  const r = await e.post("/api/chat", { message: "hola" });
  assert.equal(r.status, 200);
  assert.match((await r.json() as { reply: string }).reply, /presupuesto/);
  assert.equal(llamadas, 0);
});
