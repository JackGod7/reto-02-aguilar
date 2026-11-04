import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crearServidor, type ServerOpts } from "../../src/server.ts";
import type { LLMAdapter } from "../../src/llm/adapter.ts";

const adapter: LLMAdapter = {
  provider: "mock",
  model: "mock-1",
  async generarPaso() {
    throw new Error("no usado");
  },
};

async function con(opts: Partial<ServerOpts>, fn: (base: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "reto02-hard-"));
  const srv = crearServidor({ adapter, prompt: "p", webDir: "web", directory: dir, ...opts });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
}

const sesion = (base: string, ip: string) => fetch(`${base}/api/sessions/x`, { headers: { "x-forwarded-for": ip } });

test("XFF se ignora sin TRUST_PROXY: un solo cubo", async () => {
  await con({ rateLimit: 2, trustProxy: false }, async (base) => {
    assert.equal((await sesion(base, "1.1.1.1")).status, 404);
    assert.equal((await sesion(base, "2.2.2.2")).status, 404);
    assert.equal((await sesion(base, "3.3.3.3")).status, 429);
  });
});

test("XFF se usa con TRUST_PROXY: cubos por IP", async () => {
  await con({ rateLimit: 2, trustProxy: true }, async (base) => {
    for (const ip of ["1.1.1.1", "1.1.1.1"]) assert.equal((await sesion(base, ip)).status, 404);
    assert.equal((await sesion(base, "1.1.1.1")).status, 429);
    assert.equal((await sesion(base, "2.2.2.2")).status, 404);
  });
});

test("/api/reset: 403 sin ACCESS_KEY configurada, 401 sin clave, 200 con clave", async () => {
  await con({}, async (base) => {
    assert.equal((await fetch(`${base}/api/reset`, { method: "POST" })).status, 403);
  });
  await con({ accessKey: "secreta" }, async (base) => {
    assert.equal((await fetch(`${base}/api/reset`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${base}/api/reset`, { method: "POST", headers: { "x-access-key": "mala" } })).status, 401);
    assert.equal((await fetch(`${base}/api/reset`, { method: "POST", headers: { "x-access-key": "secreta" } })).status, 200);
  });
});

test("HEAD / responde 200 con cabeceras de seguridad y sin cuerpo", async () => {
  await con({}, async (base) => {
    const r = await fetch(`${base}/`, { method: "HEAD" });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.ok(r.headers.get("content-security-policy"));
    assert.equal((await r.text()).length, 0);
    assert.equal((await fetch(`${base}/..%2Fpackage.json`)).status, 404);
  });
});

test("tope diario de tokens", async () => {
  await con({ maxDailyTokens: 0 }, async (base) => {
    const r = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hola" }) });
    assert.equal(r.status, 429);
    assert.equal(((await r.json()) as { error: { code: string } }).error.code, "daily_token_limit");
  });
});

test("el tope diario se comprueba antes de crear sesión: un 429 no deja sesiones huérfanas", async () => {
  // Con maxSesiones=1, una sesión huérfana del primer 429 convertiría el segundo en 503.
  await con({ maxDailyTokens: 0, maxSesiones: 1 }, async (base) => {
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hola" }) });
      assert.equal(r.status, 429);
    }
  });
});
