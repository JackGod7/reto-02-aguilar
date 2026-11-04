/** Forma mínima de las respuestas de la API que verifican los tests (no el contrato completo). */
export interface RespuestaChat {
  sessionId: string;
  reply: string;
  needsConfirmation: { mensaje_id: string; campos: { campo: string }[] } | null;
  toolCalls: { name: string; ok: boolean }[];
}

export interface RespuestaSesion {
  pending: { mensaje_id: string } | null;
}

export interface RespuestaError {
  error: { code: string };
}
