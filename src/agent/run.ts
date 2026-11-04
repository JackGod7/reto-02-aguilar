import type { LLMAdapter, Mensaje } from "../llm/adapter.ts";
import { construirHerramientas, ejecutarTool } from "./registry.ts";
import type { CampoRevision, NeedsConfirmation, Session, ToolCallInfo } from "./session.ts";

export const MAX_MENSAJE = 2000;
export const MAX_PASOS = 25;

// Confirmación explícita: verbo afirmativo, sin forma de pregunta ni condicional; el rechazo siempre gana.
const AFIRMA = /(?<!\p{L})(confirmo|apruebo|acepto|autorizo|adelante|s[ií]|ok|registra(lo)?)(?!\p{L})/iu;
const PREGUNTA = /[?¿]/;
const CONDICIONAL = /(?<!\p{L})si\s+(?!,)\p{L}/iu;
const RECHAZA = /rechaz|cancel|\bno\b/i;

export function usuarioRechaza(texto: string): boolean {
  return RECHAZA.test(texto);
}

export function usuarioConfirma(texto: string): boolean {
  return AFIRMA.test(texto) && !PREGUNTA.test(texto) && !CONDICIONAL.test(texto) && !RECHAZA.test(texto);
}

type Pendientes = Map<string, NeedsConfirmation>;

// Revisiones pendientes por sesión y mensaje_id (session.pending conserva la última para la API/front).
const pendientes = new WeakMap<Session, Pendientes>();

function mapaPend(s: Session): Pendientes {
  let m = pendientes.get(s);
  if (!m) {
    m = new Map();
    pendientes.set(s, m);
  }
  if (s.pending && !m.has(s.pending.mensaje_id)) m.set(s.pending.mensaje_id, s.pending);
  return m;
}

function ultima(m: Pendientes): NeedsConfirmation | null {
  return [...m.values()].pop() ?? null;
}

export function construirPregunta(mensajeId: string, campos: CampoRevision[]): string {
  return `El mensaje ${mensajeId} requiere revisión (${campos.map((c) => c.campo).join(", ")}). ¿Confirmas el registro con estos valores?`;
}

export type Decision = { permitido: true } | { permitido: false; error: string };

const denegar = (error: string): Decision => ({ permitido: false, error });

/**
 * Gate HITL (función pura) para contratos_registrar con confirmado:true. Solo se permite si:
 *  - el mensaje_id corresponde a una revisión que la persona ya vio en un turno previo (`vistas`),
 *  - el texto del usuario es una confirmación explícita y, con varias pendientes, nombra el mensaje_id,
 *  - el override no toca campos fuera de la revisión pendiente.
 */
export function evaluarConfirmacion(
  args: Record<string, unknown>,
  mensaje: string,
  pendientes: ReadonlyMap<string, NeedsConfirmation>,
  vistas: ReadonlySet<string>,
): Decision {
  const mid = typeof args.mensaje_id === "string" ? args.mensaje_id : undefined;
  const pendiente = mid !== undefined && vistas.has(mid) ? pendientes.get(mid) : undefined;
  const ligada = vistas.size === 1 || (pendiente !== undefined && mensaje.includes(pendiente.mensaje_id));
  if (!pendiente || !usuarioConfirma(mensaje) || !ligada) {
    return denegar("confirmado:true rechazado: no hay revisión pendiente para ese mensaje_id o el usuario no ha confirmado explícitamente ese mensaje");
  }
  const claves = args.contrato && typeof args.contrato === "object" ? Object.keys(args.contrato) : [];
  const fuera = claves.filter((k) => !pendiente.campos.some((c) => c.campo === k));
  if (fuera.length > 0) return denegar(`override rechazado: campos fuera de la revisión pendiente (${fuera.join(", ")})`);
  return { permitido: true };
}

interface RespuestaTool {
  ok: boolean;
  error?: string;
  revision?: unknown;
  data?: unknown;
}

function parse(s: string): RespuestaTool {
  try {
    const v: unknown = JSON.parse(s);
    if (v && typeof v === "object") return v as RespuestaTool;
  } catch {
    // ignorado
  }
  return { ok: false, error: "respuesta de herramienta no válida" };
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "?");

/** Resumen legible de una tool call: específico por herramienta si ok; el error si no. */
export function resumir(name: string, r: RespuestaTool, args?: unknown): string {
  if (!r.ok) return String(r.error ?? "error").slice(0, 200);
  const d = (r.data && typeof r.data === "object" ? r.data : {}) as Record<string, unknown>;
  switch (name.replace(/^contratos_/, "")) {
    case "leer_buzon":
      return `${arr(d.mensajes).length} mensajes`;
    case "extraer": {
      if (d.tiene_contrato === false) return `sin contrato: ${str(d.motivo)}`.slice(0, 160);
      const mid = args && typeof args === "object" ? str((args as Record<string, unknown>).mensaje_id) : "?";
      const conf = Object.values((d.confianza ?? {}) as Record<string, unknown>).filter((x): x is number => typeof x === "number");
      const min = conf.length > 0 ? Math.min(...conf).toFixed(2) : "n/d";
      return `${mid}: ${conf.length} campos, confianza mínima ${min}`;
    }
    case "validar": {
      const rev = arr(d.requiere_revision);
      return `${str(d.clasificacion)}; en revisión: ${rev.length > 0 ? rev.join(", ") : "ninguno"}`;
    }
    case "registrar":
      return `${str(d.accion)} ${d.id_contrato ?? "-"}${d.ruta_archivo ? ` → ${str(d.ruta_archivo)}` : ""}`.slice(0, 200);
    case "alertas":
      return `vencen ${arr(d.vencen).length}, vencidos ${arr(d.vencidos).length}, pólizas pendientes ${arr(d.polizas_pendientes).length}, registrados desde corte ${arr(d.registrados_desde_corte).length}`;
    default:
      return JSON.stringify(r.data ?? null).slice(0, 160);
  }
}

function camposDeRevision(r: RespuestaTool): CampoRevision[] | null {
  return !r.ok && Array.isArray(r.revision) && r.revision.length > 0 ? (r.revision as CampoRevision[]) : null;
}

export interface RunOpts {
  adapter: LLMAdapter;
  session: Session;
  message: string;
  directory: string;
  prompt: string;
  maxTokens: number;
  runTool?: typeof ejecutarTool;
}

export interface RunResult {
  reply: string;
  toolCalls: ToolCallInfo[];
  needsConfirmation: NeedsConfirmation | null;
  usage: { steps: number; tokens: number; known?: boolean };
}

/** Estado mutable de un turno; solo lo tocan las funciones de este módulo. */
interface EstadoTurno {
  pend: Pendientes;
  vistas: Set<string>; // revisiones ya mostradas a la persona antes de este turno
  toolCalls: ToolCallInfo[];
  nueva: NeedsConfirmation | null;
  llamadas: number;
}

function fijarPendiente(st: EstadoTurno, mensajeId: string, campos: CampoRevision[]): void {
  st.nueva = { mensaje_id: mensajeId, campos, pregunta: construirPregunta(mensajeId, campos) };
  st.pend.set(mensajeId, st.nueva);
}

function resolverPendiente(st: EstadoTurno, session: Session, mensajeId: string): void {
  st.pend.delete(mensajeId);
  if (st.nueva?.mensaje_id === mensajeId) st.nueva = null;
  session.pending = ultima(st.pend);
}

/**
 * El gate no depende de que el modelo llame registrar: si validar detecta revisión, el servidor
 * sondea registrar (sin confirmado: nunca escribe) para obtener los campos y fijar la pendiente.
 */
async function sondearRevision(o: RunOpts, st: EstadoTurno, validar: RespuestaTool, mensajeId: string): Promise<void> {
  const d = (validar.data ?? {}) as { requiere_revision?: unknown; clasificacion?: unknown; motivos_revision?: unknown };
  // Un duplicado solo se sondea si la clasificación exige una decisión (destino, moneda, conflictos).
  const decision = d.clasificacion === "duplicado" && d.motivos_revision !== null && typeof d.motivos_revision === "object" && Object.keys(d.motivos_revision).length > 0;
  const aplica = Array.isArray(d.requiere_revision) && d.requiere_revision.length > 0 && (d.clasificacion === "nuevo" || d.clasificacion === "actualizacion" || decision);
  if (!aplica) return;
  const run = o.runTool ?? ejecutarTool;
  const sonda = parse(await run("contratos_registrar", { mensaje_id: mensajeId }, { directory: o.directory, sessionId: o.session.id }));
  const campos = camposDeRevision(sonda);
  if (campos) fijarPendiente(st, mensajeId, campos);
}

function crearEjecutor(o: RunOpts, st: EstadoTurno): (name: string, args: unknown) => Promise<string> {
  const run = o.runTool ?? ejecutarTool;
  return async (name, args) => {
    const id = `call-${o.session.messages.length}-${++st.llamadas}`;
    if (st.llamadas > MAX_PASOS) {
      // Defensa independiente del proveedor: el tope se impone aquí aunque el adapter no lo honre.
      st.toolCalls.push({ id, name, args, ok: false, resumen: "tope de pasos" });
      return JSON.stringify({ ok: false, error: "tope de pasos" });
    }
    const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const veto: Decision =
      name === "contratos_registrar" && a.confirmado === true ? evaluarConfirmacion(a, o.message, st.pend, st.vistas) : { permitido: true };
    const salida = veto.permitido
      ? await run(name, args, { directory: o.directory, sessionId: o.session.id })
      : JSON.stringify({ ok: false, error: veto.error });
    const r = parse(salida);
    const mensajeId = typeof a.mensaje_id === "string" ? a.mensaje_id : undefined;
    if (name === "contratos_registrar") {
      const campos = camposDeRevision(r);
      if (campos) fijarPendiente(st, String(a.mensaje_id ?? ""), campos);
      else if (r.ok && mensajeId !== undefined && st.pend.has(mensajeId)) resolverPendiente(st, o.session, mensajeId);
    } else if (name === "contratos_validar" && r.ok && mensajeId !== undefined) {
      await sondearRevision(o, st, r, mensajeId);
    }
    st.toolCalls.push({ id, name, args, ok: r.ok === true, resumen: resumir(name, r, args) });
    return salida;
  };
}

/** Respuesta determinista (sin modelo) armada desde las tool calls cuando se alcanza el tope o no hay texto. */
function replyDeterminista(st: EstadoTurno, pending: NeedsConfirmation | null, tope: boolean): string {
  const corto = (n: string): string => n.replace(/^contratos_/, "");
  const hecho = st.toolCalls.filter((t) => t.ok).map((t) => `${corto(t.name)} (${t.resumen})`);
  const falta = st.toolCalls.filter((t) => !t.ok).map((t) => `${corto(t.name)} (${t.resumen})`);
  if (pending) falta.push(`confirmación de ${pending.mensaje_id}`);
  const cabecera = tope ? `Alcancé el tope de ${MAX_PASOS} pasos.` : "El modelo no devolvió texto.";
  const r = `${cabecera} Hecho: ${hecho.join("; ") || "nada completado"}. Falta: ${falta.join("; ") || "el resto del lote"}. Escribe 'continúa' para seguir.`;
  return pending ? `${r} ${pending.pregunta}` : r;
}

export async function ejecutarTurno(o: RunOpts): Promise<RunResult> {
  if (o.adapter.generarPaso) {
    const { ejecutarTurnoGrafo } = await import("./graph.ts");
    return ejecutarTurnoGrafo(o);
  }
  // Compatibilidad temporal para adaptadores anteriores inyectados en pruebas.
  // El proveedor del servidor implementa generarPaso y usa siempre LangGraph.
  const { session, message } = o;
  const pend = mapaPend(session);
  const st: EstadoTurno = { pend, vistas: new Set(pend.keys()), toolCalls: [], nueva: null, llamadas: 0 };
  if (pend.size > 0 && usuarioRechaza(message)) {
    pend.clear();
    session.pending = null;
  }

  session.messages.push({ role: "user", text: message, ts: new Date().toISOString() });
  const mensajes: Mensaje[] = session.messages.map((m) => ({ role: m.role, content: m.text }));
  const res = await o.adapter.enviar(mensajes, construirHerramientas(crearEjecutor(o, st)), { system: o.prompt, maxPasos: MAX_PASOS });

  session.tokens += res.tokens;
  const pending = st.nueva ?? ultima(pend);
  session.pending = pending;
  const tope = res.pasos >= MAX_PASOS;
  const reply = tope || (!res.texto && !pending) ? replyDeterminista(st, pending, tope) : res.texto || (pending as NeedsConfirmation).pregunta;
  const guardado = pending ? `${reply}\n[pendiente de confirmación: ${pending.mensaje_id}]` : reply;
  session.messages.push({ role: "assistant", text: guardado, toolCalls: st.toolCalls, ts: new Date().toISOString() });
  return { reply, toolCalls: st.toolCalls, needsConfirmation: pending, usage: { steps: res.pasos, tokens: res.tokens } };
}
