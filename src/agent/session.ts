import { randomUUID } from "node:crypto";

export interface CampoRevision {
  campo: string;
  valor_propuesto: unknown;
  confianza: number;
  motivo: string;
}

export interface NeedsConfirmation {
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

export interface StoredMessage {
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
}

const sesiones = new Map<string, Session>();

export function crearSesion(): Session {
  const s: Session = { id: randomUUID(), messages: [], pending: null, tokens: 0 };
  sesiones.set(s.id, s);
  return s;
}

export function obtenerSesion(id: string): Session | undefined {
  return sesiones.get(id);
}

export function olvidarSesion(id: string): void {
  sesiones.delete(id);
}

export function limpiarSesiones(): void {
  sesiones.clear();
}
