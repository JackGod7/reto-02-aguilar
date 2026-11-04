import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readdir, readFile, rm } from "node:fs/promises";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { extname, join, normalize, resolve } from "node:path";
import { dentroDe, dirs } from "./infra/rutas.ts";
import { crearAnthropicAdapter } from "./llm/anthropic.ts";
import type { LLMAdapter } from "./llm/adapter.ts";
import { crearSesion, limpiarSesiones, obtenerSesion, olvidarSesion } from "./agent/session.ts";
import type { ejecutarTool } from "./agent/registry.ts";
import { ejecutarTurno, MAX_MENSAJE } from "./agent/run.ts";
import { buildSystemPrompt } from "./agent/context.ts";
import { appendFileSync, mkdirSync } from "node:fs";
import type { RunResult } from "./agent/run.ts";

export interface ServerOpts {
  adapter: LLMAdapter;
  prompt?: string;
  accessKey?: string;
  maxSessionTokens?: number;
  maxDailyTokens?: number; // tope global por día UTC (default 2.000.000)
  maxSesiones?: number; // sesiones vivas (default 500)
  trustProxy?: boolean; // usar x-forwarded-for (default: env TRUST_PROXY=1 o RENDER)
  rateLimit?: number; // peticiones/min por IP
  webDir?: string;
  directory?: string;
  runTool?: typeof ejecutarTool;
  buildSha?: string;
}

interface Peticion { fingerprint: string; response?: { status: number; body: unknown } }

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

const SEGURIDAD: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  // web/index.html usa <script> y <style> inline y solo llama a su mismo origen.
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const TTL_SESION_MS = 2 * 60 * 60 * 1000;

function claveIgual(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function enviar(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SEGURIDAD });
  res.end(s);
}

function err(res: ServerResponse, status: number, code: string, message: string): void {
  enviar(res, status, { error: { code, message } });
}

async function leerCuerpo(req: IncomingMessage, max = 16_384): Promise<string | null> {
  const partes: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const b = c as Buffer;
    total += b.length;
    if (total > max) return null;
    partes.push(b);
  }
  return Buffer.concat(partes).toString("utf8");
}

export function crearServidor(o: ServerOpts): Server {
  // Prompt + conocimiento del proceso (src/knowledge) en el contexto del agente; ver docs/adr/003.
  const prompt = o.prompt ?? buildSystemPrompt(resolve(import.meta.dirname, ".."));
  const maxTokens = o.maxSessionTokens ?? 200_000;
  const limite = o.rateLimit ?? 30;
  const webDir = resolve(o.webDir ?? "web");
  const directory = o.directory ?? process.cwd();
  const hits = new Map<string, { n: number; t: number }>();
  const ocupadas = new Set<string>();
  const maxDiario = o.maxDailyTokens ?? 2_000_000;
  const maxSesiones = o.maxSesiones ?? 500;
  const confiaProxy = o.trustProxy ?? (process.env.TRUST_PROXY === "1" || process.env.RENDER !== undefined);
  const vivas = new Map<string, number>(); // sessionId -> último uso
  const dias = new Map<string, { used: number; reserved: number }>();
  const peticiones = new Map<string, Map<string, Peticion>>();
  const sha = o.buildSha ?? process.env.RENDER_GIT_COMMIT ?? process.env.BUILD_SHA;
  const buildSha = sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : "desconocido";
  function presupuestoHoy(): { used: number; reserved: number } {
    const hoy = new Date().toISOString().slice(0, 10);
    for (const [fecha, b] of dias) if (fecha !== hoy && b.reserved === 0) dias.delete(fecha);
    let b = dias.get(hoy);
    if (!b) { b = { used: 0, reserved: 0 }; dias.set(hoy, b); }
    return b;
  }
  function nuevaSesion(): ReturnType<typeof crearSesion> | undefined {
    expirarSesiones(Date.now());
    if (vivas.size >= maxSesiones) return undefined;
    const s = crearSesion();
    vivas.set(s.id, Date.now());
    return s;
  }

  function expirarSesiones(now: number): void {
    for (const [id, t] of vivas) {
      if (now - t > TTL_SESION_MS && !ocupadas.has(id)) {
        vivas.delete(id);
        olvidarSesion(id);
        peticiones.delete(id);
      }
    }
  }

  function ipCliente(req: IncomingMessage): string {
    if (confiaProxy) {
      const xff = req.headers["x-forwarded-for"];
      // El proxy de confianza (Render) AÑADE la IP real al final; las entradas previas las controla el cliente.
      const ultima = (Array.isArray(xff) ? xff[xff.length - 1] : xff)?.split(",").pop()?.trim();
      if (ultima) return ultima;
    }
    return req.socket.remoteAddress ?? "?";
  }

  function limitado(ip: string): boolean {
    const now = Date.now();
    if (hits.size > 5_000) for (const [k, v] of hits) if (now - v.t > 60_000) hits.delete(k);
    const h = hits.get(ip);
    if (!h || now - h.t > 60_000) {
      hits.set(ip, { n: 1, t: now });
      return false;
    }
    h.n++;
    return h.n > limite;
  }

  async function estatico(path: string, res: ServerResponse, head = false): Promise<void> {
    const rel = path === "/" ? "/index.html" : path;
    let abs: string;
    try {
      abs = normalize(join(webDir, decodeURIComponent(rel)));
    } catch {
      return err(res, 400, "bad_request", "Ruta inválida");
    }
    if (!dentroDe(webDir, abs)) return err(res, 404, "not_found", "No encontrado");
    try {
      const data = await readFile(abs);
      res.writeHead(200, { "content-type": MIME[extname(abs)] ?? "application/octet-stream", "content-length": data.length, ...SEGURIDAD });
      res.end(head ? undefined : data);
    } catch {
      err(res, 404, "not_found", "No encontrado");
    }
  }

  async function manejar(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (req.method === "GET" && path === "/api/health") {
      return enviar(res, 200, { ok: true, provider: o.adapter.provider, model: o.adapter.model, buildSha, persistence: "process", tracing: false });
    }
    if (path.startsWith("/api/")) {
      if (limitado(ipCliente(req))) return err(res, 429, "rate_limited", "Demasiadas peticiones, intenta en un minuto");
      if (o.accessKey && !claveIgual(req.headers["x-access-key"], o.accessKey)) return err(res, 401, "unauthorized", "Clave de acceso requerida");
      expirarSesiones(Date.now());
    }
    if (req.method === "POST" && path === "/api/reset") {
      // Reinicia la demo: borra SOLO el contenido de out/ (el maestro se vuelve a copiar
      // desde fixtures en el siguiente uso) y las sesiones en memoria. Sin ACCESS_KEY
      // configurada queda deshabilitado (403) para que un link público no pueda vaciar el estado.
      if (!o.accessKey) return err(res, 403, "forbidden", "Reset deshabilitado: configura ACCESS_KEY");
      if (ocupadas.size > 0) return err(res, 409, "busy", "Hay sesiones procesando; reintenta");
      const out = dirs(directory).out;
      try {
        for (const e of await readdir(out)) await rm(join(out, e), { recursive: true, force: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") return err(res, 500, "reset_failed", "No se pudo limpiar out/");
      }
      limpiarSesiones();
      vivas.clear();
      peticiones.clear();
      return enviar(res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/api/sessions") {
      const session = nuevaSesion();
      if (!session) return err(res, 503, "too_many_sessions", "Demasiadas sesiones activas; intenta más tarde");
      return enviar(res, 201, { sessionId: session.id });
    }
    if (req.method === "POST" && path === "/api/chat") {
      const raw = await leerCuerpo(req);
      if (raw === null) return err(res, 413, "too_large", "Cuerpo demasiado grande");
      let body: { sessionId?: unknown; message?: unknown; requestId?: unknown };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        return err(res, 400, "bad_json", "JSON inválido");
      }
      if (!body || typeof body !== "object" || typeof body.message !== "string" || body.message.trim() === "") return err(res, 400, "bad_request", "Falta 'message'");
      if (body.message.length > MAX_MENSAJE) return err(res, 400, "message_too_long", `El mensaje excede ${MAX_MENSAJE} caracteres`);
      const requestId = body.requestId;
      if (requestId !== undefined && (typeof requestId !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(requestId) || typeof body.sessionId !== "string")) return err(res, 400, "bad_request", "requestId requiere UUID y una sesión creada previamente");
      let session;
      if (body.sessionId !== undefined && body.sessionId !== null) {
        session = typeof body.sessionId === "string" ? obtenerSesion(body.sessionId) : undefined;
        if (!session) return err(res, 404, "session_not_found", "Sesión no encontrada");
        if (!vivas.has(session.id)) return err(res, 404, "session_not_found", "Sesión no encontrada");
      } else {
        const b = presupuestoHoy();
        if (b.used + b.reserved >= maxDiario) return err(res, 429, "daily_token_limit", "Se alcanzó el tope diario de tokens del servicio");
        session = nuevaSesion();
        if (!session) return err(res, 503, "too_many_sessions", "Demasiadas sesiones activas; intenta más tarde");
      }
      let ledger = peticiones.get(session.id);
      if (!ledger) { ledger = new Map(); peticiones.set(session.id, ledger); }
      const fingerprint = createHash("sha256").update(body.message).digest("hex");
      const previa = typeof requestId === "string" ? ledger.get(requestId) : undefined;
      if (previa) {
        if (previa.fingerprint !== fingerprint) return err(res, 409, "request_conflict", "requestId ya pertenece a otro mensaje");
        if (previa.response) return enviar(res, previa.response.status, previa.response.body);
        return err(res, 409, "request_in_progress", "La petición sigue procesando; recupera su resultado con el mismo requestId");
      }
      if (ledger.size >= 1000) return err(res, 429, "request_limit", "La sesión alcanzó su límite de peticiones");
      if (session.tokens + session.unreconciledTokens >= maxTokens) return err(res, 429, "token_limit", "La sesión alcanzó su tope de tokens; inicia una nueva");
      if (ocupadas.has(session.id)) return err(res, 409, "busy", "La sesión está procesando otra petición");
      const budget = presupuestoHoy();
      const reserva = Math.min(maxTokens - session.tokens - session.unreconciledTokens, maxDiario - budget.used - budget.reserved);
      if (reserva <= 0) return err(res, 429, "daily_token_limit", "Se alcanzó el tope diario de tokens del servicio");
      budget.reserved += reserva;
      const peticion: Peticion = { fingerprint };
      if (typeof requestId === "string") ledger.set(requestId, peticion);
      ocupadas.add(session.id);
      const antes = session.tokens;
      const inicio = Date.now();
      let resultado: RunResult | undefined;
      let status = 502;
      function responder(code: number, data: unknown): void {
        status = code;
        peticion.response = { status: code, body: data };
        enviar(res, code, data);
      }
      try {
        resultado = await ejecutarTurno({ adapter: o.adapter, session, message: body.message, directory, prompt, maxTokens: session.tokens + reserva, runTool: o.runTool });
        return responder(200, { sessionId: session.id, requestId, ...resultado });
      } catch (e) {
        const msg = e instanceof Error && e.message.startsWith("LLM no configurado") ? e.message : "El proveedor del modelo falló o expiró; la sesión sigue activa, reintenta";
        const { ErrorTurnoGrafo } = await import("./agent/graph.ts");
        if (e instanceof ErrorTurnoGrafo) {
          resultado = e.partial;
          return responder(502, { error: { code: "llm_error", message: msg }, sessionId: session.id, requestId, ...e.partial });
        }
        return responder(502, { error: { code: "llm_error", message: msg }, sessionId: session.id, requestId });
      } finally {
        const conocidos = Math.max(0, session.tokens - antes);
        const known = resultado !== undefined && resultado.usage.known !== false;
        budget.reserved -= reserva;
        budget.used += known ? conocidos : Math.max(reserva, conocidos);
        if (!known) session.unreconciledTokens += Math.max(0, reserva - conocidos);
        vivas.set(session.id, Date.now());
        ocupadas.delete(session.id);
        // Solo metadatos operativos: sin texto, argumentos, documentos ni errores del SDK.
        try {
          mkdirSync(dirs(directory).out, { recursive: true });
          appendFileSync(join(dirs(directory).out, "turnos.jsonl"), JSON.stringify({ ts: new Date().toISOString(), sessionId: session.id, requestId: requestId ?? randomUUID(), buildSha, provider: o.adapter.provider, model: o.adapter.model, status, latencyMs: Date.now() - inicio, steps: resultado?.usage.steps ?? null, tokens: known ? conocidos : null, knownTokens: conocidos, usageKnown: known, reservedTokens: known ? 0 : Math.max(0, reserva - conocidos), outcome: status >= 500 ? "provider_error" : resultado?.needsConfirmation ? "review" : resultado?.toolCalls.some((c) => !c.ok) ? "tool_error" : "complete" }) + "\n");
        } catch { /* un fallo diagnóstico no repite los efectos */ }
      }
    }
    const m = /^\/api\/sessions\/([^/]+)$/.exec(path);
    if (req.method === "GET" && m) {
      const s = obtenerSesion(decodeURIComponent(m[1] ?? ""));
      if (!s || !vivas.has(s.id)) return err(res, 404, "session_not_found", "Sesión no encontrada");
      return enviar(res, 200, { sessionId: s.id, messages: s.messages, pending: s.pending, requests: [...peticiones.get(s.id) ?? []].map(([id, p]) => ({ requestId: id, status: p.response ? "completed" : "processing" })) });
    }
    if (path.startsWith("/api/")) return err(res, 404, "not_found", "Ruta no encontrada");
    if (req.method === "GET" || req.method === "HEAD") return estatico(path, res, req.method === "HEAD");
    return err(res, 405, "method_not_allowed", "Método no permitido");
  }

  return createServer((req, res) => {
    manejar(req, res).catch(() => {
      if (!res.headersSent) err(res, 500, "internal", "Error interno");
      else res.end();
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 3000;
  const srv = crearServidor({
    adapter: crearAnthropicAdapter(),
    accessKey: process.env.ACCESS_KEY || undefined,
    maxSessionTokens: Number(process.env.MAX_SESSION_TOKENS) || 200_000,
    maxDailyTokens: Number(process.env.MAX_DAILY_TOKENS) || 2_000_000,
  });
  srv.listen(port, () => console.log(`Servidor en :${port}`));
}
