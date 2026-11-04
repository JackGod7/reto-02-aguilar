import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { crearAnthropicAdapter } from "./llm/anthropic.ts";
import type { LLMAdapter } from "./llm/adapter.ts";
import { crearSesion, obtenerSesion } from "./agent/session.ts";
import type { ejecutarTool } from "./agent/registry.ts";
import { cargarPrompt, ejecutarTurno, MAX_MENSAJE } from "./agent/run.ts";

export interface ServerOpts {
  adapter: LLMAdapter;
  prompt?: string;
  accessKey?: string;
  maxSessionTokens?: number;
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

function enviar(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
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
  const prompt = o.prompt ?? cargarPrompt();
  const maxTokens = o.maxSessionTokens ?? 200_000;
  const limite = o.rateLimit ?? 30;
  const webDir = resolve(o.webDir ?? "web");
  const directory = o.directory ?? process.cwd();
  const hits = new Map<string, { n: number; t: number }>();
  const ocupadas = new Set<string>();

  function limitado(ip: string): boolean {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now - h.t > 60_000) {
      hits.set(ip, { n: 1, t: now });
      return false;
    }
    h.n++;
    return h.n > limite;
  }

  async function estatico(path: string, res: ServerResponse): Promise<void> {
    const rel = path === "/" ? "/index.html" : path;
    const abs = normalize(join(webDir, decodeURIComponent(rel)));
    if (!abs.startsWith(webDir)) return err(res, 404, "not_found", "No encontrado");
    try {
      const data = await readFile(abs);
      res.writeHead(200, { "content-type": MIME[extname(abs)] ?? "application/octet-stream" });
      res.end(data);
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
      if (limitado(req.socket.remoteAddress ?? "?")) return err(res, 429, "rate_limited", "Demasiadas peticiones, intenta en un minuto");
      if (o.accessKey && req.headers["x-access-key"] !== o.accessKey) return err(res, 401, "unauthorized", "Clave de acceso requerida");
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
      } else {
        session = crearSesion();
      }
      if (session.tokens >= maxTokens) return err(res, 429, "token_limit", "La sesión alcanzó su tope de tokens; inicia una nueva");
      if (ocupadas.has(session.id)) return err(res, 409, "busy", "La sesión está procesando otra petición");
      ocupadas.add(session.id);
      try {
        const r = await ejecutarTurno({ adapter: o.adapter, session, message: body.message, directory, prompt, maxTokens, runTool: o.runTool });
        return enviar(res, 200, { sessionId: session.id, ...r });
      } catch (e) {
        const msg = e instanceof Error && e.message.startsWith("LLM no configurado") ? e.message : "El proveedor del modelo falló o expiró; la sesión sigue activa, reintenta";
        return err(res, 502, "llm_error", msg);
      } finally {
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
    if (req.method === "GET") return estatico(path, res);
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
  });
  srv.listen(port, () => console.log(`Servidor en :${port}`));
}
