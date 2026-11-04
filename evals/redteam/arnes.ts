// Arnés de red team: servidor real (crearServidor + adapter Anthropic) sobre una copia temporal de fixtures/.
// La clave se lee del entorno o del .env del checkout principal y nunca se imprime.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { crearServidor } from "../../src/server.ts";
import { crearAnthropicAdapter } from "../../src/llm/anthropic.ts";
import type { ejecutarTool } from "../../src/agent/registry.ts";

const RAIZ = resolve(import.meta.dirname, "../..");

/** Carga ANTHROPIC_API_KEY sin mostrarla: entorno, .env del worktree o .env del checkout principal. */
export function cargarClave(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true;
  const candidatos = [join(RAIZ, ".env"), resolve(RAIZ, "../../../.env")];
  for (const ruta of candidatos) {
    if (!existsSync(ruta)) continue;
    for (const linea of readFileSync(ruta, "utf8").split("\n")) {
      const m = /^ANTHROPIC_API_KEY=(.+)$/.exec(linea.trim());
      if (m?.[1]) { process.env.ANTHROPIC_API_KEY = m[1].replace(/^["']|["']$/g, ""); return true; }
    }
  }
  return false;
}

/** Copia temporal: solo fixtures/ (el prompt sale del repo). Devuelve la carpeta. */
export function copiaTemporal(): string {
  const dir = mkdtempSync(join(tmpdir(), "redteam-"));
  cpSync(join(RAIZ, "fixtures"), join(dir, "fixtures"), { recursive: true });
  return dir;
}

/** Mapa ruta relativa → sha256 de todos los archivos bajo dir. */
export function instantanea(dir: string): Map<string, string> {
  const r = new Map<string, string>();
  const rec = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.isFile()) r.set(relative(dir, p), createHash("sha256").update(readFileSync(p)).digest("hex"));
      else r.set(relative(dir, p), `otro:${statSync(p, { throwIfNoEntry: false })?.mode ?? "?"}`);
    }
  };
  if (existsSync(dir)) rec(dir);
  return r;
}

export function diff(antes: Map<string, string>, despues: Map<string, string>): string[] {
  const cambios: string[] = [];
  for (const [k, v] of despues) if (!antes.has(k)) cambios.push(`+ ${k}`); else if (antes.get(k) !== v) cambios.push(`~ ${k}`);
  for (const k of antes.keys()) if (!despues.has(k)) cambios.push(`- ${k}`);
  return cambios.sort();
}

export interface Respuesta {
  status: number;
  body: {
    sessionId?: string;
    reply?: string;
    toolCalls?: { name: string; args: unknown; ok: boolean; resumen: string }[];
    needsConfirmation?: { mensaje_id: string; reviewId?: string; operationHash?: string; campos: unknown[] } | null;
    usage?: { steps: number; tokens: number };
    error?: { code: string; message: string };
  };
}

export interface Entorno {
  dir: string;
  url: string;
  chat(message: string, sessionId?: string): Promise<Respuesta>;
  cerrar(): Promise<void>;
}

export async function levantar(opts: { modelo: string; maxSessionTokens?: number; dir?: string; runTool?: typeof ejecutarTool }): Promise<Entorno> {
  const dir = opts.dir ?? copiaTemporal();
  const adapter = crearAnthropicAdapter({ ...process.env, LLM_MODEL: opts.modelo });
  const srv = crearServidor({ adapter, directory: dir, maxSessionTokens: opts.maxSessionTokens ?? 200_000, rateLimit: 10_000, runTool: opts.runTool });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return {
    dir,
    url,
    async chat(message, sessionId) {
      const r = await fetch(`${url}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, ...(sessionId ? { sessionId } : {}) }) });
      return { status: r.status, body: await r.json() as Respuesta["body"] };
    },
    cerrar: () => new Promise<void>((ok) => srv.close(() => ok())),
  };
}

/** Filas del maestro en out/ (vacío si aún no se escribió). */
export function maestro(dir: string): Record<string, string>[] {
  const ruta = join(dir, "out/sharepoint/maestro-contratos.csv");
  if (!existsSync(ruta)) return [];
  const [cab, ...filas] = readFileSync(ruta, "utf8").trim().split("\n");
  const cols = (cab ?? "").split(",");
  return filas.map((f) => Object.fromEntries(parseCsv(f).map((v, i) => [cols[i] ?? `c${i}`, v])));
}
function parseCsv(linea: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < linea.length; i++) {
    const ch = linea[i];
    if (q) { if (ch === '"' && linea[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}
