import { z } from "zod";
import * as contratos from "../tools/contratos.ts";
import type { Herramienta } from "../llm/adapter.ts";

export interface ToolContext {
  directory: string;
  sessionId: string;
}

interface ToolLike {
  description: string;
  args: z.ZodType;
  execute(args: never, ctx: ToolContext): Promise<string>;
}

export type Ejecutor = (name: string, args: unknown) => Promise<string>;

/** Construye las herramientas `contratos_*` para el modelo; `ejecutor` decide cómo se ejecuta cada llamada (gate, registro). */
export function construirHerramientas(ejecutor: Ejecutor): Herramienta[] {
  const out: Herramienta[] = [];
  for (const [nombre, def] of Object.entries(contratos)) {
    const t = def as unknown as ToolLike;
    if (!t || typeof t !== "object" || typeof t.execute !== "function" || !t.args) continue;
    const name = `contratos_${nombre}`;
    out.push({ name, description: t.description, inputSchema: t.args, execute: (args) => ejecutor(name, args) });
  }
  return out;
}

export async function ejecutarTool(nombre: string, args: unknown, ctx: ToolContext): Promise<string> {
  try {
    const def = (contratos as Record<string, unknown>)[nombre.replace(/^contratos_/, "")] as ToolLike | undefined;
    if (!def || typeof def.execute !== "function") return JSON.stringify({ ok: false, error: `herramienta desconocida: ${nombre}` });
    const parsed = def.args.safeParse(args);
    if (!parsed.success) return JSON.stringify({ ok: false, error: `argumentos inválidos: ${parsed.error.message.slice(0, 300)}` });
    return await def.execute(parsed.data as never, ctx);
  } catch {
    return JSON.stringify({ ok: false, error: "error interno de la herramienta" });
  }
}
