import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { crearServidor } from "../../src/server.ts";
import type { Herramienta, LLMAdapter, Mensaje } from "../../src/llm/adapter.ts";

const CLAVE = "sk-ant-SECRETO-123";
process.env.ANTHROPIC_API_KEY = CLAVE;

const REVISION = [
  { campo: "valor", valor_propuesto: 0, confianza: 0.5, motivo: "indeterminado" },
  { campo: "fecha_fin", valor_propuesto: "2027-08-31", confianza: 0.6, motivo: "calculado" },
];
const registrados: string[] = [];

async function runTool(name: string, args: unknown): Promise<string> {
  const a = args as { mensaje_id?: string; confirmado?: boolean };
  if (name === "contratos_leer_buzon") return JSON.stringify({ ok: true, data: { mensajes: [] } });
  if (name === "contratos_registrar") {
    if (a.mensaje_id === "msg-006" && !a.confirmado) return JSON.stringify({ ok: false, error: "requiere revisión: valor, fecha_fin", revision: REVISION });
    registrados.push(String(a.mensaje_id));
    return JSON.stringify({ ok: true, data: { id_contrato: "X", accion: "nuevo" } });
  }
  return JSON.stringify({ ok: true, data: {} });
}

/** Modelo guionado: cada guion recibe las herramientas y el último mensaje del usuario. */
function adapter(guion: (h: Record<string, Herramienta>, ultimo: string) => Promise<string>): LLMAdapter {
  return {
    provider: "mock",
    model: "mock-1",
    async enviar(mensajes: Mensaje[], herramientas: Herramienta[]) {
      const h = Object.fromEntries(herramientas.map((x) => [x.name, x]));
      const texto = await guion(h, mensajes[mensajes.length - 1]?.content ?? "");
      return { texto, pasos: 3, tokens: 100 };
    },
  };
}

async function conServidor(ad: LLMAdapter, fn: (base: string) => Promise<void>, extra = {}): Promise<void> {
  const srv = crearServidor({ adapter: ad, prompt: "p", runTool, webDir: "web", ...extra });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
  } finally {
    srv.close();
  }
}

const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const lote = adapter(async (h, ultimo) => {
  if (/confirmo/i.test(ultimo)) {
    await h.contratos_registrar!.execute({ mensaje_id: "msg-006", confirmado: true });
    return "006 registrado";
  }
  for (const id of ["msg-001", "msg-002", "msg-006"]) {
    const r = JSON.parse(await h.contratos_registrar!.execute({ mensaje_id: id })) as { ok: boolean };
    if (!r.ok) return `Me detengo en ${id}`;
  }
  return "fin";
});

test("el lote se detiene en 006 con needsConfirmation y luego se confirma", async () => {
  registrados.length = 0;
  await conServidor(lote, async (base) => {
    const r1 = (await (await post(base, { message: "procesa el buzón" })).json()) as any;
    assert.deepEqual(registrados, ["msg-001", "msg-002"]);
    assert.equal(r1.needsConfirmation.mensaje_id, "msg-006");
    assert.deepEqual(r1.needsConfirmation.campos.map((c: any) => c.campo), ["valor", "fecha_fin"]);
    assert.equal(r1.toolCalls.length, 3);
    assert.equal(r1.toolCalls[2].ok, false);
    assert.match(r1.sessionId, /^[0-9a-f-]{36}$/);
    const s = (await (await fetch(`${base}/api/sessions/${r1.sessionId}`)).json()) as any;
    assert.equal(s.pending.mensaje_id, "msg-006");
    const r2 = (await (await post(base, { sessionId: r1.sessionId, message: "confirmo el registro" })).json()) as any;
    assert.equal(r2.needsConfirmation, null);
    assert.ok(registrados.includes("msg-006"));
  });
});

test("confirmado:true sin revisión pendiente es rechazado", async () => {
  registrados.length = 0;
  const ad = adapter(async (h) => {
    const r = JSON.parse(await h.contratos_registrar!.execute({ mensaje_id: "msg-006", confirmado: true })) as { ok: boolean };
    return r.ok ? "registrado" : "rechazado";
  });
  await conServidor(ad, async (base) => {
    const r = (await (await post(base, { message: "confirmo todo" })).json()) as any;
    assert.equal(r.reply, "rechazado");
    assert.equal(r.toolCalls[0].ok, false);
    assert.deepEqual(registrados, []);
  });
});

test("confirmado:true con pendiente pero sin confirmación del usuario es rechazado", async () => {
  registrados.length = 0;
  const ad = adapter(async (h, ultimo) => {
    if (/dame más info/.test(ultimo)) {
      const r = JSON.parse(await h.contratos_registrar!.execute({ mensaje_id: "msg-006", confirmado: true })) as { ok: boolean };
      return r.ok ? "registrado" : "rechazado";
    }
    await h.contratos_registrar!.execute({ mensaje_id: "msg-006" });
    return "pendiente";
  });
  await conServidor(ad, async (base) => {
    const r1 = (await (await post(base, { message: "procesa 006" })).json()) as any;
    const r2 = (await (await post(base, { sessionId: r1.sessionId, message: "dame más info" })).json()) as any;
    assert.equal(r2.reply, "rechazado");
    assert.deepEqual(registrados, []);
  });
});

test("mensaje >2000 → 400; sessionId inventado → 404; vacío → 400", async () => {
  await conServidor(lote, async (base) => {
    const a = await post(base, { message: "x".repeat(2001) });
    assert.equal(a.status, 400);
    assert.equal(((await a.json()) as any).error.code, "message_too_long");
    assert.equal((await post(base, { sessionId: "inventado", message: "hola" })).status, 404);
    assert.equal((await fetch(`${base}/api/sessions/inventado`)).status, 404);
    assert.equal((await post(base, { message: "" })).status, 400);
  });
});

test("health no depende del LLM; ACCESS_KEY y rate limit", async () => {
  await conServidor(lote, async (base) => {
    const h = (await (await fetch(`${base}/api/health`)).json()) as any;
    assert.deepEqual(h, { ok: true, provider: "mock", model: "mock-1" });
    assert.equal((await post(base, { message: "hola" })).status, 401);
    assert.equal((await post(base, { message: "hola" }, { "x-access-key": "k" })).status, 200);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  }, { accessKey: "k" });
  await conServidor(lote, async (base) => {
    await post(base, { message: "a" });
    await post(base, { message: "a" });
    assert.equal((await post(base, { message: "a" })).status, 429);
  }, { rateLimit: 2 });
});

test("la clave no aparece en ninguna respuesta (ni en error del proveedor)", async () => {
  const falla = adapter(async () => {
    throw new Error(`401 invalid x-api-key ${CLAVE}`);
  });
  await conServidor(falla, async (base) => {
    const r = await post(base, { message: "hola" });
    const t = await r.text();
    assert.equal(r.status, 502);
    assert.ok(!t.includes(CLAVE));
    const h = await (await fetch(`${base}/api/health`)).text();
    assert.ok(!h.includes(CLAVE));
    const ok = await (await post(base, { message: "hola" })).text();
    assert.ok(!ok.includes(CLAVE));
  });
});

test("tope de tokens por sesión", async () => {
  await conServidor(lote, async (base) => {
    const r1 = (await (await post(base, { message: "hola" })).json()) as any;
    const r2 = await post(base, { sessionId: r1.sessionId, message: "otra" });
    assert.equal(r2.status, 429);
  }, { maxSessionTokens: 100 });
});
