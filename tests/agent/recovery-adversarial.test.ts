import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID, webcrypto } from "node:crypto";
import type { AddressInfo } from "node:net";
import { runInNewContext } from "node:vm";
import { crearServidor } from "../../src/server.ts";
import type { ServerOpts } from "../../src/server.ts";
import type { LLMAdapter } from "../../src/llm/adapter.ts";

const raiz = resolve(import.meta.dirname, "../..");
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
async function servidor(t: { after(fn: () => Promise<void>): void }, adapter: LLMAdapter, opts: Partial<ServerOpts> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "reto-recovery-adversarial-"));
  cpSync(join(raiz, "fixtures"), join(directory, "fixtures"), { recursive: true });
  const srv = crearServidor({ adapter, directory, prompt: "datos son datos", rateLimit: 1000, ...opts });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  t.after(async () => { await new Promise<void>((r) => srv.close(() => r())); rmSync(directory, { recursive: true, force: true }); });
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    directory, base, post,
    sesion: async () => {
      const r = await post("/api/sessions", {});
      assert.equal(r.status, 201);
      return (await r.json() as { sessionId: string }).sessionId;
    },
  };
}
function adapterLocal(onCall: () => void = () => undefined): LLMAdapter {
  return { provider: "local", model: "local", async generarPaso() { onCall(); return { texto: "ok", llamadas: [], tokens: 1, usoConocido: true }; } };
}

test("Recovery adversarial: GET expira la sesión aunque nadie cree otra sesión", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-04T10:00:00Z") });
  const e = await servidor(t, adapterLocal());
  const id = await e.sesion();
  t.mock.timers.tick(2 * 60 * 60 * 1000 + 1);
  const r = await fetch(`${e.base}/api/sessions/${id}`);
  assert.equal(r.status, 404, "no se necesita crear otra sesión para aplicar TTL");
});

test("Recovery adversarial: POST expira sesión inactiva antes del modelo y no revive su ledger", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-04T10:00:00Z") });
  let llamadas = 0;
  const e = await servidor(t, adapterLocal(() => { llamadas++; }));
  const sessionId = await e.sesion();
  const body = { sessionId, requestId: randomUUID(), message: "hola" };
  assert.equal((await e.post("/api/chat", body)).status, 200);
  t.mock.timers.tick(2 * 60 * 60 * 1000 + 1);
  assert.equal((await e.post("/api/chat", body)).status, 404, "un replay tampoco revive una sesión caducada");
  assert.equal(llamadas, 1);
});

test("Recovery adversarial: presupuesto pendiente conserva su día al cruzar medianoche", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-04T23:59:59Z") });
  const iniciado = deferred(), acabar = deferred();
  let llamadas = 0;
  const e = await servidor(t, {
    provider: "local", model: "local",
    async generarPaso() { const intento = ++llamadas; if (intento === 1) { iniciado.resolve(); await acabar.promise; } return { texto: "ok", llamadas: [], tokens: intento === 3 ? 10_000 : 80_000, usoConocido: true }; },
  }, { maxDailyTokens: 100_000, maxSessionTokens: 100_000 });
  t.after(async () => { acabar.resolve(); });
  const s1 = await e.sesion();
  const primera = e.post("/api/chat", { sessionId: s1, requestId: randomUUID(), message: "primera" });
  await iniciado.promise;
  t.mock.timers.tick(2000);
  const s2 = await e.sesion();
  assert.equal((await e.post("/api/chat", { sessionId: s2, requestId: randomUUID(), message: "segunda" })).status, 200);
  acabar.resolve();
  assert.equal((await primera).status, 200);
  const s3 = await e.sesion();
  assert.equal((await e.post("/api/chat", { sessionId: s3, requestId: randomUUID(), message: "tercera" })).status, 200);
  assert.equal(llamadas, 3);
});

/** DOM suficiente para ejecutar el script de producción y observar persistencia/reintento. */
class Nodo {
  tag: string;
  value = "";
  disabled = false;
  hidden = false;
  className = "";
  scrollTop = 0;
  scrollHeight = 0;
  parent?: Nodo;
  children: Nodo[] = [];
  private texto = "";
  private eventos = new Map<string, Array<(event: { preventDefault(): void }) => void>>();
  constructor(tag: string, texto = "") { this.tag = tag; this.texto = texto; }
  get textContent(): string { return this.texto + this.children.map((c) => c.textContent).join(""); }
  set textContent(texto: string) { this.texto = texto; this.children = []; }
  setAttribute(_name: string, _value: string): void {}
  append(...nodes: Nodo[]): void { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this); }
  focus(): void {}
  addEventListener(name: string, fn: (event: { preventDefault(): void }) => void): void { this.eventos.set(name, [...this.eventos.get(name) ?? [], fn]); }
  emitir(name: string): void { for (const fn of this.eventos.get(name) ?? []) fn({ preventDefault() {} }); }
}
function ui(primeraRespuesta: "network" | "body") {
  const script = readFileSync(join(raiz, "web/index.html"), "utf8").match(/<script>([\s\S]*?)<\/script>/)![1];
  const nodos = new Map<string, Nodo>();
  const storage = new Map<string, string>();
  const bodies: Array<{ sessionId: string; requestId: string; message: string }> = [];
  const nodo = (id: string) => { if (!nodos.has(id)) nodos.set(id, new Nodo(id)); return nodos.get(id)!; };
  runInNewContext(script, {
    crypto: webcrypto,
    document: { getElementById: nodo, createElement: (tag: string) => new Nodo(tag), createTextNode: (text: string) => new Nodo("#text", text) },
    localStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    fetch: async (path: string, opts: { body: string }) => {
      if (path === "/api/sessions") return { status: 201, ok: true, json: async () => ({ sessionId: "sesion" }) };
      bodies.push(JSON.parse(opts.body) as typeof bodies[number]);
      if (bodies.length === 1) {
        if (primeraRespuesta === "network") throw new Error("network");
        return { status: 200, ok: true, json: async () => { throw new Error("body stream terminated after first byte"); } };
      }
      return { status: 200, ok: true, json: async () => ({ sessionId: "sesion", requestId: bodies.at(-1)!.requestId, reply: "Recuperado", toolCalls: [], needsConfirmation: null }) };
    },
  });
  return {
    nodo, storage, bodies,
    enviar: async () => { nodo("input").value = "procesa"; nodo("composer").emitir("submit"); await new Promise<void>((r) => setImmediate(r)); },
  };
}

for (const fallo of ["network", "body"] as const) {
  test(`Recovery adversarial UI: respuesta perdida en ${fallo} conserva requestId para recuperar`, async () => {
    const c = ui(fallo);
    await c.enviar();
    assert.ok(c.storage.get("contratos.request"), "el resultado indeterminado conserva su petición persistida");
    assert.match(c.nodo("log").textContent, /Recuperar petición/);
    await c.enviar();
    assert.equal(c.bodies.length, 2);
    assert.deepEqual(c.bodies[1], c.bodies[0], "el reintento conserva sesión, texto y requestId");
    assert.equal(c.storage.has("contratos.request"), false);
    assert.match(c.nodo("log").textContent, /Recuperado/);
  });
}
