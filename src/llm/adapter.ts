import type { z } from "zod";

export interface LlamadaLLM {
  id: string;
  name: string;
  args: unknown;
}

/** Historial de un paso: las salidas de herramientas conservan el ID del pedido. */
export interface MensajePaso {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: LlamadaLLM[];
  toolCallId?: string;
}

/** Esquema publicado al modelo. Solo el nodo herramienta del grafo ejecuta. */
export interface Herramienta {
  name: string;
  description: string;
  inputSchema: z.ZodType;
}

export interface PasoLLM {
  texto: string;
  llamadas: LlamadaLLM[];
  tokens: number;
  usoConocido: boolean;
  /** Desglose de caché de prompt (ya incluido en tokens): escrituras y lecturas del prefijo. */
  cache?: { creacion: number; lectura: number };
}

export interface OpcionesPasoLLM {
  system?: string;
  signal?: AbortSignal;
  maxOutputTokens?: number;
}

export interface LLMAdapter {
  readonly provider: string;
  readonly model: string;
  /** false si falta configuración (p. ej. la clave): el servidor rechaza antes de reservar presupuesto. */
  readonly configurado?: boolean;
  /** Una llamada al modelo; nunca ejecuta herramientas ni decide autorización. */
  generarPaso(mensajes: MensajePaso[], herramientas: Herramienta[], opciones: OpcionesPasoLLM): Promise<PasoLLM>;
}
