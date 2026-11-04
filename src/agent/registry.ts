import { z } from "zod";
import * as contratos from "../tools/contratos.ts";
import type { Herramienta } from "../llm/adapter.ts";
import { conContextoLog, escribirLog } from "../infra/registros.ts";

export interface ToolContext {
  directory: string;
  sessionId: string;
  callId?: string;
}

interface ToolLike {
  description: string;
  args: z.ZodRawShape;
  execute(args: never, ctx: ToolContext): Promise<string>;
}

/** Esquemas `contratos_*` publicados al modelo; la ejecución pasa siempre por `ejecutarTool`. */
export const herramientas: Herramienta[] = Object.entries(contratos).flatMap(([nombre, def]) => {
  const t = def as unknown as ToolLike;
  return t && typeof t === "object" && typeof t.execute === "function" && t.args
    ? [{ name: `contratos_${nombre}`, description: t.description, inputSchema: z.object(t.args).strict() }] : [];
});

export async function ejecutarTool(nombre: string, args: unknown, ctx: ToolContext): Promise<string> {
  const fallo = (error: string): string => {
    const mid = args && typeof args === "object" && "mensaje_id" in args && typeof args.mensaje_id === "string" ? args.mensaje_id : null;
    escribirLog(ctx.directory, { herramienta: nombre, mensaje_id: mid, ok: false, resumen: error, sessionId: ctx.sessionId, callId: ctx.callId });
    return JSON.stringify({ ok: false, error });
  };
  try {
    const clave = nombre.startsWith("contratos_") ? nombre.slice("contratos_".length) : "";
    const def = Object.hasOwn(contratos, clave) ? (contratos as Record<string, unknown>)[clave] as ToolLike | undefined : undefined;
    if (!def || typeof def.execute !== "function") return fallo("herramienta desconocida");
    const parsed = z.object(def.args).strict().safeParse(args);
    if (!parsed.success) return fallo("argumentos inválidos para la herramienta");
    return await conContextoLog(ctx, () => def.execute(parsed.data as never, ctx));
  } catch {
    return fallo("error interno de la herramienta");
  }
}
