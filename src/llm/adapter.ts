import type { z } from "zod";

export interface Mensaje {
  role: "user" | "assistant";
  content: string;
}

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

export interface Herramienta {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  execute(args: unknown): Promise<string>;
}

export interface PasoLLM {
  texto: string;
  llamadas: LlamadaLLM[];
  tokens: number;
  usoConocido: boolean;
}

export interface OpcionesPasoLLM {
  system?: string;
  signal?: AbortSignal;
  maxOutputTokens?: number;
}

export interface RespuestaLLM {
  texto: string;
  pasos: number;
  tokens: number;
}

export interface OpcionesLLM {
  system?: string;
  /** Compatibilidad con adapters anteriores. El grafo controla el bucle de producción. */
  maxPasos: number;
}

export interface LLMAdapter {
  readonly provider: string;
  readonly model: string;
  /** false si falta configuración (p. ej. la clave): el servidor rechaza antes de reservar presupuesto. */
  readonly configurado?: boolean;
  /** Una llamada al modelo; nunca ejecuta herramientas ni decide autorización. */
  generarPaso?(mensajes: MensajePaso[], herramientas: Herramienta[], opciones: OpcionesPasoLLM): Promise<PasoLLM>;
  /** Contrato anterior conservado para adapters de pruebas y clientes existentes. */
  enviar(mensajes: Mensaje[], herramientas: Herramienta[], opciones: OpcionesLLM): Promise<RespuestaLLM>;
}
