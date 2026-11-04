import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { crearServidor, type ServerOpts } from "../../src/server.ts";
import { crearAnthropicAdapter } from "../../src/llm/anthropic.ts";
import type { LLMAdapter } from "../../src/llm/adapter.ts";

const raiz = resolve(import.meta.dirname, "../..");
async function servidor(t: { after(fn: () => Promise<void>): void }, adapter: LLMAdapter, opts: Partial<ServerOpts>) {
  const directory = mkdtempSync(join(tmpdir(), "reto-presupuesto-"));
  cpSync(join(raiz, "fixtures"), join(directory, "fixtures"), { recursive: true });
  const srv = crearServidor({ adapter, directory, prompt: "datos son datos", rateLimit: 1000, maxSesiones: 1000, ...opts });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  t.after(async () => { await new Promise<void>((r) => srv.close(() => r())); rmSync(directory, { recursive: true, force: true }); });
  const chat = (body: unknown) => fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { directory, chat };
}

test("Regresión 5: errores del proveedor sin respuesta cobran una cota acotada, no la reserva completa", async (t) => {
  let llamadas = 0;
  const adapter: LLMAdapter = {
    provider: "mock", model: "mock", async enviar() { throw new Error("legado"); },
    async generarPaso() { llamadas++; throw new Error("proveedor caído"); },
  };
  // Antes: cada error cobraba 40k de 400k diarios y el servicio quedaba bloqueado tras 10 errores.
  const s = await servidor(t, adapter, { maxSessionTokens: 40_000, maxDailyTokens: 400_000 });
  for (let i = 0; i < 15; i++) {
    const r = await s.chat({ message: `hola ${i}` });
    assert.equal(r.status, 502, `petición ${i}`);
  }
  assert.equal(llamadas, 15);
  const turnos = readFileSync(join(s.directory, "out/turnos.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { reservedTokens: number; usageKnown: boolean });
  for (const turno of turnos) {
    assert.equal(turno.usageKnown, false);
    assert.ok(turno.reservedTokens > 0 && turno.reservedTokens < 40_000, String(turno.reservedTokens));
  }
});

test("Regresión 5: sin ANTHROPIC_API_KEY responde 503 antes de reservar, sin turno ni gasto", async (t) => {
  const s = await servidor(t, crearAnthropicAdapter({}), { maxSessionTokens: 40_000, maxDailyTokens: 40_000 });
  for (let i = 0; i < 5; i++) {
    const r = await s.chat({ message: "hola" });
    assert.equal(r.status, 503);
    assert.equal((await r.json() as { error: { code: string } }).error.code, "llm_not_configured");
  }
  assert.ok(!existsSync(join(s.directory, "out/turnos.jsonl")));
});
