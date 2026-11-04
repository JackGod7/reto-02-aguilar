import "../llm/sin-trazas.ts"; // primero: fuerza tracing externo apagado
import { randomUUID } from "node:crypto";
import { MemorySaver } from "@langchain/langgraph";

export interface CampoRevision {
  campo: string;
  valor_propuesto: unknown;
  confianza: number;
  motivo: string;
}

export interface NeedsConfirmation {
  reviewId?: string;
  operationHash?: string;
  mensaje_id: string;
  campos: CampoRevision[];
  pregunta: string;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  args: unknown;
  ok: boolean;
  resumen: string;
}

interface StoredMessage {
  role: "user" | "assistant";
  text: string;
  toolCalls?: ToolCallInfo[];
  ts: string;
}

export interface Session {
  id: string;
  messages: StoredMessage[];
  pending: NeedsConfirmation | null;
  tokens: number;
  unreconciledTokens: number;
}

const sesiones = new Map<string, Session>();
/** Único checkpointer del grafo (hilo = id de sesión); su vida sigue a la de la sesión. Alcance A: no sobrevive a reinicios. */
export const checkpointer = new MemorySaver();

export function crearSesion(): Session {
  const s: Session = { id: randomUUID(), messages: [], pending: null, tokens: 0, unreconciledTokens: 0 };
  sesiones.set(s.id, s);
  return s;
}

export function obtenerSesion(id: string): Session | undefined {
  return sesiones.get(id);
}

export function olvidarSesion(id: string): void {
  sesiones.delete(id);
  void checkpointer.deleteThread(id);
}

export function limpiarSesiones(): void {
  for (const id of sesiones.keys()) olvidarSesion(id);
}
