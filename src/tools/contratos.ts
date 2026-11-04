import { z } from "zod";

// Stubs de M1. Las implementaciones reales llegan en M2/M3.
// Contrato: execute nunca lanza; devuelve string JSON {ok:true,data} | {ok:false,error}.

export interface ToolContext {
  directory: string;
  sessionId: string;
}

export interface ToolDef<A extends z.ZodType> {
  description: string;
  args: A;
  execute(args: z.infer<A>, ctx: ToolContext): Promise<string>;
}

const NO_IMPLEMENTADO = JSON.stringify({ ok: false, error: "no implementado" });

const mensajeId = z
  .string()
  .regex(/^msg-\d{3}$/)
  .describe("Id del mensaje del buzón, formato msg-NNN");

export const leer_buzon: ToolDef<z.ZodObject<{}, z.core.$strict>> = {
  description: "Lista los mensajes del buzón pendientes de procesar (excluye los ya procesados).",
  args: z.object({}).strict(),
  async execute() {
    return NO_IMPLEMENTADO;
  },
};

export const extraer: ToolDef<z.ZodObject<{ mensaje_id: typeof mensajeId }, z.core.$strict>> = {
  description: "Extrae los datos de contrato de un mensaje, con confianza por campo.",
  args: z.object({ mensaje_id: mensajeId }).strict(),
  async execute() {
    return NO_IMPLEMENTADO;
  },
};

export const validar: ToolDef<
  z.ZodObject<{ mensaje_id: typeof mensajeId; contrato: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>> }, z.core.$strict>
> = {
  description: "Clasifica el mensaje (nuevo, actualizacion, duplicado, rechazado) y lista campos a revisar.",
  args: z
    .object({
      mensaje_id: mensajeId,
      contrato: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Override opcional de los datos extraídos"),
    })
    .strict(),
  async execute() {
    return NO_IMPLEMENTADO;
  },
};

export const registrar: ToolDef<
  z.ZodObject<
    {
      mensaje_id: typeof mensajeId;
      contrato: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      confirmado: z.ZodOptional<z.ZodBoolean>;
      hoy: z.ZodOptional<z.ZodString>;
    },
    z.core.$strict
  >
> = {
  description: "Registra el contrato en el maestro. Requiere confirmado:true si hay campos a revisar.",
  args: z
    .object({
      mensaje_id: mensajeId,
      contrato: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Override opcional de los datos extraídos"),
      confirmado: z.boolean().optional().describe("true solo tras confirmación explícita del usuario"),
      hoy: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Fecha de registro YYYY-MM-DD; por defecto la fecha de referencia"),
    })
    .strict(),
  async execute() {
    return NO_IMPLEMENTADO;
  },
};

export const alertas: ToolDef<z.ZodObject<{ hoy: z.ZodString }, z.core.$strict>> = {
  description: "Genera out/alertas.md: vencimientos, pólizas pendientes y registros recientes.",
  args: z
    .object({
      hoy: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("Fecha de referencia YYYY-MM-DD"),
    })
    .strict(),
  async execute() {
    return NO_IMPLEMENTADO;
  },
};
