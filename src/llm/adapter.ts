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

/** Interfaz propia: el adapter ejecuta el bucle modelo<->herramientas y devuelve el texto final. */
export interface LLMAdapter {
  readonly provider: string;
  readonly model: string;
  enviar(mensajes: Mensaje[], herramientas: Herramienta[], opciones?: { system?: string; maxPasos?: number }): Promise<RespuestaLLM>;
}
