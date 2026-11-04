import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";

/** DOM mínimo para recorrer el script real del chat con respuestas HTTP simuladas. */
class Elemento {
  tag: string;
  className = "";
  value = "";
  disabled = false;
  hidden = false;
  scrollTop = 0;
  scrollHeight = 0;
  children: Elemento[] = [];
  parent?: Elemento;
  private texto = "";
  private eventos = new Map<string, ((event: { preventDefault(): void }) => void)[]>();
  constructor(tag: string, texto = "") { this.tag = tag; this.texto = texto; }
  get textContent(): string { return this.texto + this.children.map((c) => c.textContent).join(""); }
  set textContent(texto: string) { this.texto = texto; this.children = []; }
  setAttribute(_nombre: string, _valor: string): void {}
  append(...nodes: Elemento[]): void { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this); }
  focus(): void {}
  addEventListener(nombre: string, fn: (event: { preventDefault(): void }) => void): void {
    this.eventos.set(nombre, [...this.eventos.get(nombre) ?? [], fn]);
  }
  emitir(nombre: string): void { for (const fn of this.eventos.get(nombre) ?? []) fn({ preventDefault() {} }); }
}

const script = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8").match(/<script>([\s\S]*?)<\/script>/)![1];

function chat(respuestas: { status: number; data: unknown }[]) {
  const nodos = new Map<string, Elemento>();
  const guardado = new Map<string, string>();
  const solicitudes: { path: string; body: string }[] = [];
  const nodo = (id: string) => {
    if (!nodos.has(id)) nodos.set(id, new Elemento(id));
    return nodos.get(id)!;
  };
  runInNewContext(script, {
    crypto: webcrypto,
    document: { getElementById: nodo, createElement: (tag: string) => new Elemento(tag), createTextNode: (s: string) => new Elemento("#text", s) },
    localStorage: { getItem: (k: string) => guardado.get(k), setItem: (k: string, v: string) => guardado.set(k, v), removeItem: (k: string) => guardado.delete(k) },
    fetch: async (path: string, opts: { body: string }) => {
      if (path === '/api/sessions') return { status: 201, ok: true, json: async () => ({ sessionId: "sesion-precreada" }) };
      solicitudes.push({ path, body: opts.body });
      const r = respuestas.shift();
      assert.ok(r, "respuesta HTTP simulada disponible");
      const body = JSON.parse(opts.body) as { sessionId: string; requestId: string };
      const data = r.status < 400 && r.data && typeof r.data === "object" ? { ...r.data, sessionId: body.sessionId, requestId: body.requestId } : r.data;
      return { status: r.status, ok: r.status < 400, json: async () => data };
    },
  });
  return {
    nodo, guardado, solicitudes,
    async enviar(texto: string) {
      nodo("input").value = texto;
      nodo("composer").emitir("submit");
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

for (const [code, message] of [
  ["llm_error", "El proveedor del modelo falló o expiró; la sesión sigue activa, reintenta"],
  ["daily_token_limit", "Se alcanzó el tope diario de tokens del servicio"],
  ["too_many_sessions", "Demasiadas sesiones activas; intenta más tarde"],
]) {
  test(`front muestra el mensaje del servidor para ${code} y permite reintentar`, async () => {
    const c = chat([
      { status: 502, data: { error: { code, message } } },
      { status: 200, data: { sessionId: "sesion", reply: "Respuesta recuperada", toolCalls: [], needsConfirmation: null } },
    ]);
    await c.enviar("Procesa el buzón");
    assert.equal(c.nodo("log").children.at(-1)?.textContent, message);
    assert.equal(c.nodo("send").disabled, false);
    await c.enviar("Reintenta");
    assert.match(c.nodo("log").textContent, /Respuesta recuperada/);
  });
}

test("front conserva sesión, herramientas y revisión tras fallo parcial sin duplicar el error", async () => {
  const message = "El proveedor falló <img src=x onerror=alert(1)>";
  const c = chat([
    { status: 502, data: { error: { code: "llm_error", message }, sessionId: "sesion-parcial", reply: message,
      toolCalls: [{ name: "contratos_registrar", args: { mensaje_id: "msg-006" }, ok: false, resumen: "requiere revisión" }],
      needsConfirmation: { mensaje_id: "msg-006", campos: [], pregunta: "¿Confirmas el registro?" } } },
    { status: 200, data: { sessionId: "sesion-parcial", reply: "Listo", toolCalls: [] } },
  ]);
  await c.enviar("Procesa el buzón");
  const log = c.nodo("log");
  assert.match(log.textContent, /contratos_registrar/);
  assert.match(log.textContent, /¿Confirmas el registro\?/);
  assert.equal(log.textContent.split(message).length - 1, 1);
  assert.equal(c.guardado.get("contratos.sessionId"), "sesion-parcial");
  const tags = (n: Elemento): string[] => [n.tag, ...n.children.flatMap(tags)];
  assert.ok(!tags(log).includes("img"));
  await c.enviar("Continúa");
  assert.equal(JSON.parse(c.solicitudes[1].body).sessionId, "sesion-parcial");
});

test("front conserva un mensaje claro si el servidor omite el detalle", async () => {
  const c = chat([{ status: 429, data: { error: { code: "daily_token_limit", message: "   " } } }]);
  await c.enviar("Procesa");
  assert.equal(c.nodo("log").children.at(-1)?.textContent, "El servicio alcanzó su límite diario de tokens. Inténtalo mañana.");
});

test("front aprueba la revisión que se presentó, incluyendo su identificador", async () => {
  const reviewId = "ed040f41-4c9b-437e-91bb-c89fd1e8e69f";
  const c = chat([
    { status: 200, data: { sessionId: "s", reply: "Revisa", toolCalls: [], needsConfirmation: {
      mensaje_id: "msg-006", reviewId, pregunta: "¿Confirmas?", campos: [{ campo: "valor", valor_propuesto: 0, confianza: 0.5 }],
    } } },
    { status: 200, data: { sessionId: "s", reply: "Registrado", toolCalls: [], needsConfirmation: null } },
  ]);
  await c.enviar("Procesa");
  const todos = (n: Elemento): Elemento[] => [n, ...n.children.flatMap(todos)];
  const aprobar = todos(c.nodo("log")).find((n) => n.tag === "button" && n.textContent === "Aprobar");
  assert.ok(aprobar);
  aprobar.emitir("click");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const body = JSON.parse(c.solicitudes[1].body) as { message: string; sessionId: string };
  assert.match(body.message, new RegExp(reviewId));
  assert.equal(body.message, `confirmo revisión ${reviewId}`);
  assert.equal(body.sessionId, "sesion-precreada");
});
