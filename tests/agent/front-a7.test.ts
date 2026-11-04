import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";

/** A7: sesión, idempotencia, caducidad, errores, aprobación y render seguro del chat real. */
class Elemento {
  tag: string;
  className = "";
  value = "";
  disabled = false;
  hidden = false;
  scrollTop = 0;
  scrollHeight = 0;
  attrs = new Map<string, string>();
  children: Elemento[] = [];
  parent?: Elemento;
  private texto = "";
  private eventos = new Map<string, ((event: { preventDefault(): void }) => void)[]>();
  constructor(tag: string, texto = "") { this.tag = tag; this.texto = texto; }
  get textContent(): string { return this.texto + this.children.map((c) => c.textContent).join(""); }
  set textContent(texto: string) { this.texto = texto; this.children = []; }
  set innerHTML(_html: string) { throw new Error("innerHTML prohibido"); }
  setAttribute(nombre: string, valor: string): void { this.attrs.set(nombre, valor); }
  append(...nodes: Elemento[]): void { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this); }
  focus(): void {}
  requestSubmit(): void { this.emitir("submit"); }
  addEventListener(nombre: string, fn: (event: { preventDefault(): void }) => void): void {
    this.eventos.set(nombre, [...this.eventos.get(nombre) ?? [], fn]);
  }
  // Como el DOM real: un botón deshabilitado no despacha click.
  emitir(nombre: string): void { if (nombre === "click" && this.disabled) return; for (const fn of this.eventos.get(nombre) ?? []) fn({ preventDefault() {} }); }
}

const script = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8").match(/<script>([\s\S]*?)<\/script>/)![1];

type Llamada = { path: string; method: string; body: string; storage: Record<string, string> };
type Respuesta = { status: number; data: unknown } | "red";
type Cuerpo = { message: string; sessionId: string; requestId: string };

const SESION = "11111111-2222-4333-8444-555555555555";
const REVIEW = "ed040f41-4c9b-437e-91bb-c89fd1e8e69f";

function chat(chatResp: Respuesta[], inicial: Record<string, string> = {}, extra: Record<string, Respuesta[]> = {}) {
  const nodos = new Map<string, Elemento>();
  const guardado = new Map<string, string>(Object.entries(inicial));
  const llamadas: Llamada[] = [];
  const nodo = (id: string) => {
    if (!nodos.has(id)) nodos.set(id, new Elemento(id));
    return nodos.get(id)!;
  };
  const responder = (r: Respuesta | undefined, eco?: Cuerpo) => {
    assert.ok(r, "respuesta HTTP simulada disponible");
    if (r === "red") throw new TypeError("Failed to fetch");
    const data = r.status < 400 && eco && r.data && typeof r.data === "object"
      ? { sessionId: eco.sessionId, requestId: eco.requestId, ...r.data } : r.data;
    return { status: r.status, ok: r.status < 400, json: async () => data };
  };
  runInNewContext(script, {
    crypto: webcrypto,
    document: { getElementById: nodo, createElement: (tag: string) => new Elemento(tag), createTextNode: (s: string) => new Elemento("#text", s) },
    localStorage: { getItem: (k: string) => guardado.get(k) ?? null, setItem: (k: string, v: string) => guardado.set(k, v), removeItem: (k: string) => guardado.delete(k) },
    fetch: async (path: string, opts: { method?: string; body?: string } = {}) => {
      llamadas.push({ path, method: opts.method ?? "GET", body: opts.body ?? "", storage: Object.fromEntries(guardado) });
      if (path === "/api/sessions") return responder(extra[path]?.shift() ?? { status: 201, data: { sessionId: SESION } });
      if (path === "/api/chat") return responder(chatResp.shift(), JSON.parse(opts.body!) as Cuerpo);
      return responder(extra[path]?.shift());
    },
  });
  const todos = (n: Elemento): Elemento[] => [n, ...n.children.flatMap(todos)];
  const espera = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    nodo, guardado, llamadas,
    chats: () => llamadas.filter((l) => l.path === "/api/chat").map((l) => JSON.parse(l.body) as Cuerpo),
    elementos: () => todos(nodo("log")),
    boton: (texto: string) => todos(nodo("log")).filter((n) => n.tag === "button" && n.textContent === texto),
    errores: () => todos(nodo("log")).filter((n) => n.className === "msg error").map((n) => n.textContent),
    espera,
    async enviar(texto: string) {
      nodo("input").value = texto;
      nodo("composer").emitir("submit");
      await espera();
    },
    async click(b: Elemento) { b.emitir("click"); await espera(); },
  };
}

const revision = { mensaje_id: "msg-006", reviewId: REVIEW, pregunta: "¿Confirmas?", campos: [{ campo: "valor", valor_propuesto: 0, confianza: 0.5 }] };

test("(a) crea la sesión y persiste sessionId y requestId antes del primer POST con efectos", async () => {
  const c = chat([{ status: 200, data: { reply: "Hecho", toolCalls: [] } }]);
  await c.enviar("Procesa el buzón");
  assert.deepEqual(c.llamadas.map((l) => `${l.method} ${l.path}`), ["POST /api/sessions", "POST /api/chat"]);
  const envio = c.llamadas[1];
  const body = JSON.parse(envio.body) as Cuerpo;
  assert.equal(body.sessionId, SESION);
  assert.match(body.requestId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
  assert.equal(envio.storage["contratos.sessionId"], SESION);
  assert.deepEqual(JSON.parse(envio.storage["contratos.request"]), body);
  // Tras la respuesta la petición pendiente se libera; la sesión se conserva.
  assert.equal(c.guardado.get("contratos.request"), undefined);
  assert.equal(c.guardado.get("contratos.sessionId"), SESION);
});

test("(a) reutiliza la sesión guardada sin crear otra", async () => {
  const c = chat([{ status: 200, data: { reply: "Hecho", toolCalls: [] } }], { "contratos.sessionId": SESION },
    { [`/api/sessions/${SESION}`]: [{ status: 200, data: { sessionId: SESION, messages: [], pending: null, requests: [] } }] });
  await c.espera();
  await c.enviar("Hola");
  assert.ok(!c.llamadas.some((l) => l.path === "/api/sessions"));
  assert.equal(c.chats()[0].sessionId, SESION);
});

test("(a) si no puede crear la sesión no envía el mensaje con efectos", async () => {
  const c = chat([], {}, { "/api/sessions": ["red"] });
  await c.enviar("Procesa");
  assert.equal(c.chats().length, 0);
  assert.deepEqual(c.errores(), ["No se pudo conectar con el servidor. Revisa tu conexión."]);
});

test("(b) un POST perdido por red se recupera con el mismo requestId y sin duplicar", async () => {
  const c = chat(["red", { status: 200, data: { reply: "Registrado una vez", toolCalls: [] } }]);
  await c.enviar("Procesa el buzón");
  const pendiente = JSON.parse(c.guardado.get("contratos.request")!) as Cuerpo;
  assert.equal(c.errores().length, 1);
  // Otro mensaje distinto no se envía mientras haya una petición sin resolver.
  await c.enviar("Otra cosa");
  assert.equal(c.chats().length, 1);
  const [recuperar] = c.boton("Recuperar petición");
  assert.ok(recuperar);
  await c.click(recuperar);
  const [primero, segundo] = c.chats();
  assert.deepEqual(segundo, primero);
  assert.deepEqual(segundo, pendiente);
  assert.match(c.nodo("log").textContent, /Registrado una vez/);
  assert.equal(c.guardado.get("contratos.request"), undefined);
  // Botones de recuperación viejos ya no envían nada (ni con requestId nuevo).
  for (const b of c.boton("Recuperar petición")) await c.click(b);
  assert.equal(c.chats().length, 2);
});

test("(b) reescribir el mismo texto tras un corte reusa el requestId", async () => {
  const c = chat(["red", { status: 200, data: { reply: "Ok", toolCalls: [] } }]);
  await c.enviar("Procesa el buzón");
  await c.enviar("Procesa el buzón");
  const [a, b] = c.chats();
  assert.equal(b.requestId, a.requestId);
  assert.equal(b.sessionId, a.sessionId);
});

test("(b) la petición pendiente sobrevive a recargar y se recupera con el mismo requestId", async () => {
  const pendiente = { message: "Procesa", sessionId: SESION, requestId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" };
  const c = chat([{ status: 200, data: { reply: "Ok", toolCalls: [] } }],
    { "contratos.sessionId": SESION, "contratos.request": JSON.stringify(pendiente) },
    { [`/api/sessions/${SESION}`]: [{ status: 200, data: { sessionId: SESION, messages: [], pending: null, requests: [] } }] });
  await c.espera();
  const [recuperar] = c.boton("Recuperar petición");
  assert.ok(recuperar);
  await c.click(recuperar);
  assert.deepEqual(c.chats(), [pendiente]);
});

test("(c) con la sesión caducada no reenvía una aprobación a otra sesión", async () => {
  const c = chat([
    { status: 200, data: { reply: "Revisa", toolCalls: [], needsConfirmation: revision } },
    { status: 404, data: { error: { code: "session_not_found", message: "Sesión no encontrada" } } },
  ]);
  await c.enviar("Procesa");
  const [aprobar] = c.boton("Aprobar");
  await c.click(aprobar);
  assert.equal(c.chats().length, 2);
  assert.equal(c.chats()[1].message, `confirmo revisión ${REVIEW}`);
  // Caducada: limpia sesión y petición, avisa una sola vez, no crea sesión ni reenvía.
  assert.equal(c.guardado.get("contratos.sessionId"), undefined);
  assert.equal(c.guardado.get("contratos.request"), undefined);
  assert.equal(c.nodo("log").textContent.split("La sesión expiró").length - 1, 1);
  assert.equal(c.llamadas.filter((l) => l.path === "/api/sessions").length, 1);
  assert.equal(c.boton("Recuperar petición").length, 0);
  await c.click(aprobar);
  assert.equal(c.chats().length, 2);
});

test("(c) una revisión que quedó en pantalla no se aprueba en la sesión nueva", async () => {
  const c = chat([
    { status: 200, data: { reply: "Revisa", toolCalls: [], needsConfirmation: revision } },
    { status: 404, data: { error: { code: "session_not_found", message: "Sesión no encontrada" } } },
  ]);
  await c.enviar("Procesa");
  await c.enviar("¿Cómo va?");
  assert.equal(c.guardado.get("contratos.sessionId"), undefined);
  const [aprobar] = c.boton("Aprobar");
  assert.equal(aprobar.disabled, false);
  await c.click(aprobar);
  assert.equal(c.chats().length, 2);
  assert.equal(c.llamadas.filter((l) => l.path === "/api/sessions").length, 1);
  assert.match(c.nodo("log").textContent, /pertenecía a una sesión que ya no existe/);
});

test("(c) al restaurar una sesión caducada descarta la petición pendiente sin enviarla", async () => {
  const pendiente = { message: `confirmo revisión ${REVIEW}`, sessionId: SESION, requestId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" };
  const c = chat([], { "contratos.sessionId": SESION, "contratos.request": JSON.stringify(pendiente) },
    { [`/api/sessions/${SESION}`]: [{ status: 404, data: { error: { code: "session_not_found", message: "Sesión no encontrada" } } }] });
  await c.espera();
  assert.equal(c.chats().length, 0);
  assert.equal(c.guardado.get("contratos.request"), undefined);
  assert.equal(c.boton("Recuperar petición").length, 0);
  assert.equal(c.nodo("log").textContent.split("La sesión expiró").length - 1, 1);
});

for (const [status, code, message, esperado] of [
  [502, "llm_error", "El proveedor del modelo falló o expiró; la sesión sigue activa, reintenta", "El proveedor del modelo falló o expiró; la sesión sigue activa, reintenta"],
  [429, "rate_limited", "Demasiadas peticiones, intenta en un minuto", "Demasiadas solicitudes seguidas. Espera un minuto y vuelve a intentarlo."],
  [429, "token_limit", "La sesión alcanzó su tope de tokens; inicia una nueva", "Esta conversación alcanzó su límite. Pulsa «Nueva conversación» para seguir."],
  [409, "busy", "La sesión está procesando otra petición", "Todavía estoy procesando el mensaje anterior. Espera un momento."],
  [409, "request_in_progress", "La petición sigue procesando; recupera su resultado con el mismo requestId", "Tu petición anterior sigue en proceso. Espera un momento y pulsa «Recuperar petición»."],
] as const) {
  test(`(d) ${status} ${code} se muestra una sola vez y legible`, async () => {
    const c = chat([{ status, data: { error: { code, message } } }]);
    await c.enviar("Procesa");
    assert.deepEqual(c.errores(), [esperado]);
    assert.ok(!/requestId|http_|\{/.test(esperado));
    assert.equal(c.nodo("send").disabled, false);
  });
}

test("(d) 502 llm_error libera la petición: reintentar usa requestId nuevo", async () => {
  const c = chat([
    { status: 502, data: { error: { code: "llm_error", message: "El proveedor falló" } } },
    { status: 200, data: { reply: "Ok", toolCalls: [] } },
  ]);
  await c.enviar("Procesa");
  assert.equal(c.guardado.get("contratos.request"), undefined);
  await c.enviar("Procesa");
  const [a, b] = c.chats();
  assert.notEqual(b.requestId, a.requestId);
  assert.equal(b.sessionId, a.sessionId);
});

test("(d) 409 request_in_progress conserva la petición y recupera con el mismo requestId", async () => {
  const c = chat([
    { status: 409, data: { error: { code: "request_in_progress", message: "x" } } },
    { status: 200, data: { reply: "Ok", toolCalls: [] } },
  ]);
  await c.enviar("Procesa");
  const [recuperar] = c.boton("Recuperar petición");
  await c.click(recuperar);
  const [a, b] = c.chats();
  assert.deepEqual(b, a);
});

for (const [boton, verbo] of [["Aprobar", "confirmo"], ["Rechazar", "rechazo"]] as const) {
  test(`(e) ${boton} envía exactamente la revisión presentada, una sola vez`, async () => {
    const c = chat([
      { status: 200, data: { reply: "Revisa", toolCalls: [], needsConfirmation: revision } },
      { status: 200, data: { reply: "Listo", toolCalls: [], needsConfirmation: null } },
    ]);
    await c.enviar("Procesa");
    const [b] = c.boton(boton);
    await c.click(b);
    await c.click(b);
    const chats = c.chats();
    assert.equal(chats.length, 2);
    assert.equal(chats[1].message, `${verbo} revisión ${REVIEW}`);
    assert.equal(chats[1].sessionId, SESION);
    assert.ok(c.boton("Aprobar").every((n) => n.disabled) && c.boton("Rechazar").every((n) => n.disabled));
  });
}

test("(e) sin reviewId no se envía ninguna aprobación", async () => {
  const c = chat([{ status: 200, data: { reply: "Revisa", toolCalls: [], needsConfirmation: { ...revision, reviewId: undefined } } }]);
  await c.enviar("Procesa");
  await c.click(c.boton("Aprobar")[0]);
  assert.equal(c.chats().length, 1);
});

test("(f) tabla del mensaje y panel de revisión renderizan datos como texto", async () => {
  const xss = "<img src=x onerror=alert(1)>";
  const reply = `| Contrato | Cliente |\n|---|---|\n| C-1 | ${xss} |\n\n**${xss}** y \`<script>alert(2)</script>\``;
  const c = chat([{ status: 200, data: {
    reply,
    toolCalls: [{ name: `tool${xss}`, args: { html: xss }, ok: true, resumen: xss }],
    needsConfirmation: { mensaje_id: `msg${xss}`, reviewId: REVIEW, pregunta: `¿${xss}?`,
      campos: [{ campo: xss, valor_propuesto: { v: xss }, confianza: 0.9, motivo: xss }] },
  } }]);
  await c.enviar("Procesa");
  const els = c.elementos();
  const tags = new Set(els.map((n) => n.tag));
  assert.ok(!tags.has("img") && !tags.has("script"));
  assert.ok(tags.has("table") && tags.has("td"));
  // Cada dato peligroso llega como nodo de texto literal.
  const textos = els.filter((n) => n.tag === "#text").map((n) => n.textContent);
  assert.ok(textos.filter((t) => t.includes(xss)).length >= 8);
  assert.ok(textos.includes("<script>alert(2)</script>"));
  for (const n of els) for (const v of n.attrs.values()) assert.ok(!v.includes("<"));
});

test("(f) el script del chat no usa APIs que interpreten HTML", () => {
  assert.ok(!/\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/.test(script));
});
