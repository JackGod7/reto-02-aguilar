import type { z } from "zod";

export interface Mensaje {
  role: "user" | "assistant";
  content: string;
}

export interface Herramienta {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  execute(args: unknown): Promise<string>;
}

export interface RespuestaLLM {
  texto: string;
  pasos: number;
  tokens: number;
}

export interface OpcionesLLM {
  system?: string;
  /** Tope de pasos modelo<->herramientas. Toda implementación debe honrarlo (run.ts además lo impone en el ejecutor). */
  maxPasos: number;
}

/** Interfaz propia: el adapter ejecuta el bucle modelo<->herramientas y devuelve el texto final. */
export interface LLMAdapter {
  readonly provider: string;
  readonly model: string;
  enviar(mensajes: Mensaje[], herramientas: Herramienta[], opciones: OpcionesLLM): Promise<RespuestaLLM>;
}
