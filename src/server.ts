import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readdir, readFile, rm } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { extname, join, normalize, resolve } from "node:path";
import { dentroDe, dirs } from "./infra/rutas.ts";
import { crearAnthropicAdapter } from "./llm/anthropic.ts";
import type { LLMAdapter } from "./llm/adapter.ts";
import { crearSesion, limpiarSesiones, obtenerSesion, olvidarSesion } from "./agent/session.ts";
import type { ejecutarTool } from "./agent/registry.ts";
import { cargarPrompt, ejecutarTurno, MAX_MENSAJE } from "./agent/run.ts";
import { buildSystemPrompt } from "./agent/context.ts";

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
}

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
  const prompt = o.prompt ?? (buildSystemPrompt(resolve(import.meta.dirname, "..")) || cargarPrompt());
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
  let dia = new Date().toISOString().slice(0, 10);
  let tokensDia = 0;

  function tokensHoy(): number {
    const hoy = new Date().toISOString().slice(0, 10);
    if (hoy !== dia) {
      dia = hoy;
      tokensDia = 0;
    }
    return tokensDia;
  }

  function expirarSesiones(now: number): void {
    for (const [id, t] of vivas) {
      if (now - t > TTL_SESION_MS && !ocupadas.has(id)) {
        vivas.delete(id);
        olvidarSesion(id);
      }
    }
  }

  function ipCliente(req: IncomingMessage): string {
    if (confiaProxy) {
      const xff = req.headers["x-forwarded-for"];
      const primera = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
      if (primera) return primera;
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
      return enviar(res, 200, { ok: true, provider: o.adapter.provider, model: o.adapter.model });
    }
    if (path.startsWith("/api/")) {
      if (limitado(ipCliente(req))) return err(res, 429, "rate_limited", "Demasiadas peticiones, intenta en un minuto");
      if (o.accessKey && !claveIgual(req.headers["x-access-key"], o.accessKey)) return err(res, 401, "unauthorized", "Clave de acceso requerida");
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
      return enviar(res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/api/chat") {
      const raw = await leerCuerpo(req);
      if (raw === null) return err(res, 413, "too_large", "Cuerpo demasiado grande");
      let body: { sessionId?: unknown; message?: unknown };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        return err(res, 400, "bad_json", "JSON inválido");
      }
      if (typeof body.message !== "string" || body.message.trim() === "") return err(res, 400, "bad_request", "Falta 'message'");
      if (body.message.length > MAX_MENSAJE) return err(res, 400, "message_too_long", `El mensaje excede ${MAX_MENSAJE} caracteres`);
      let session;
      if (body.sessionId !== undefined && body.sessionId !== null) {
        session = typeof body.sessionId === "string" ? obtenerSesion(body.sessionId) : undefined;
        if (!session) return err(res, 404, "session_not_found", "Sesión no encontrada");
        vivas.set(session.id, Date.now());
      } else {
        const now = Date.now();
        if (vivas.size >= maxSesiones) expirarSesiones(now);
        if (vivas.size >= maxSesiones) return err(res, 503, "too_many_sessions", "Demasiadas sesiones activas; intenta más tarde");
        session = crearSesion();
        vivas.set(session.id, now);
      }
      if (tokensHoy() >= maxDiario) return err(res, 429, "daily_token_limit", "Se alcanzó el tope diario de tokens del servicio");
      if (session.tokens >= maxTokens) return err(res, 429, "token_limit", "La sesión alcanzó su tope de tokens; inicia una nueva");
      if (ocupadas.has(session.id)) return err(res, 409, "busy", "La sesión está procesando otra petición");
      ocupadas.add(session.id);
      const antes = session.tokens;
      try {
        const r = await ejecutarTurno({ adapter: o.adapter, session, message: body.message, directory, prompt, maxTokens, runTool: o.runTool });
        return enviar(res, 200, { sessionId: session.id, ...r });
      } catch (e) {
        const msg = e instanceof Error && e.message.startsWith("LLM no configurado") ? e.message : "El proveedor del modelo falló o expiró; la sesión sigue activa, reintenta";
        return err(res, 502, "llm_error", msg);
      } finally {
        tokensDia += Math.max(0, session.tokens - antes);
        vivas.set(session.id, Date.now());
        ocupadas.delete(session.id);
      }
    }
    const m = /^\/api\/sessions\/([^/]+)$/.exec(path);
    if (req.method === "GET" && m) {
      const s = obtenerSesion(decodeURIComponent(m[1] ?? ""));
      if (!s) return err(res, 404, "session_not_found", "Sesión no encontrada");
      return enviar(res, 200, { sessionId: s.id, messages: s.messages, pending: s.pending });
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
