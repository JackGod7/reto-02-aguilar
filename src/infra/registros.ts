import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dirs } from "./rutas.ts";
import { AsyncLocalStorage } from "node:async_hooks";

const contextoLog = new AsyncLocalStorage<{ sessionId: string; callId?: string }>();
export function conContextoLog<T>(ctx: { sessionId: string; callId?: string }, fn: () => T): T {
  return contextoLog.run(ctx, fn);
}

interface EntradaHistorial {
  ts: string;
  id_contrato: string;
  accion: string;
  cambios: Record<string, unknown>;
  mensaje_id: string;
}

export function agregarHistorial(directory: string, e: Omit<EntradaHistorial, "ts">): void {
  const { sharepoint } = dirs(directory);
  mkdirSync(sharepoint, { recursive: true });
  appendFileSync(resolve(sharepoint, "historial.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n");
}

export function leerProcesados(directory: string): string[] {
  const ruta = resolve(dirs(directory).out, "procesados.json");
  if (!existsSync(ruta)) return [];
  try {
    const d: unknown = JSON.parse(readFileSync(ruta, "utf8"));
    return Array.isArray(d) ? d.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function marcarProcesado(directory: string, id: string): void {
  const { out } = dirs(directory);
  mkdirSync(out, { recursive: true });
  const lista = leerProcesados(directory);
  if (!lista.includes(id)) lista.push(id);
  const destino = resolve(out, "procesados.json");
  const tmp = `${destino}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(lista, null, 2));
  renameSync(tmp, destino);
}

export function escribirLog(
  directory: string,
  e: { herramienta: string; mensaje_id: string | null; ok: boolean; resumen: string; sessionId?: string; callId?: string },
): void {
  try {
    const { out } = dirs(directory);
    mkdirSync(out, { recursive: true });
    appendFileSync(resolve(out, "log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...contextoLog.getStore(), ...e }) + "\n");
  } catch {
    // el log nunca debe romper una tool
  }
}

export function escribirTextoOut(directory: string, nombre: string, contenido: string): string {
  const { out } = dirs(directory);
  mkdirSync(out, { recursive: true });
  const destino = resolve(out, nombre);
  const tmp = `${destino}.${process.pid}.tmp`;
  writeFileSync(tmp, contenido, "utf8");
  renameSync(tmp, destino);
  return `out/${nombre}`;
}
