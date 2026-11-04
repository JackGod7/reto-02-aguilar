import "../llm/sin-trazas.ts"; // primero: fuerza tracing externo apagado
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Annotation, Command, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { z } from "zod";
import type { LLMAdapter, LlamadaLLM, MensajePaso, PasoLLM } from "../llm/adapter.ts";
import { escribirLog } from "../infra/registros.ts";
import { herramientas, ejecutarTool } from "./registry.ts";
import { checkpointer } from "./session.ts";
import type { CampoRevision, NeedsConfirmation, Session, ToolCallInfo } from "./session.ts";

interface RespuestaTool { ok: boolean; error?: string; data?: unknown; revision?: unknown }
interface Pedido extends LlamadaLLM { sonda?: boolean }
interface Revision extends NeedsConfirmation {
  reviewId: string;
  operationHash: string;
  sourceFingerprint: string;
  operacion: { name: "contratos_registrar"; args: Record<string, unknown> };
}
interface DecisionHumana { reviewId: string; operationHash: string; approved: boolean; message: string }

/** Estado del grafo, un canal por campo para que `getState` sea legible. */
const Estado = Annotation.Root({
  history: Annotation<MensajePaso[]>(),
  queue: Annotation<Pedido[]>(),
  review: Annotation<Revision | null>(),
  respuestaHumana: Annotation<DecisionHumana | null>(),
  last: Annotation<{ pedido: Pedido; respuesta: RespuestaTool } | null>(),
  toolCalls: Annotation<ToolCallInfo[]>(),
  steps: Annotation<number>(),
  tokens: Annotation<number>(),
  usageKnown: Annotation<boolean>(),
  reply: Annotation<string>(),
  stop: Annotation<string>(),
  /** El stop proviene de un tope (pasos, tokens, tiempo o herramientas): la respuesta lista lo que falta. */
  limite: Annotation<boolean>(),
  /** Cota (entrada + salida máxima) de llamadas que fallaron antes de devolver respuesta. */
  incierto: Annotation<number>(),
  /** El proveedor respondió sin informar uso: no hay cota y el servidor retiene la reserva. */
  usoSinInformar: Annotation<boolean>(),
});
type Flujo = typeof Estado.State;
type Cambio = Partial<Flujo>;

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
  /** uncertain: cota de tokens de llamadas que fallaron antes de devolver respuesta (solo si known es false). */
  usage: { steps: number; tokens: number; known?: boolean; uncertain?: number };
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "?");
/** Resumen legible de una tool call: específico por herramienta si ok; el error si no. */
export function resumir(name: string, r: RespuestaTool, args?: unknown): string {
  if (!r.ok) return String(r.error ?? "error").slice(0, 200);
  const d = objeto(r.data);
  switch (name.replace(/^contratos_/, "")) {
    case "leer_buzon":
      return `${arr(d.mensajes).length} mensajes`;
    case "extraer": {
      if (d.tiene_contrato === false) return `sin contrato: ${str(d.motivo)}`.slice(0, 160);
      const conf = Object.values(objeto(d.confianza)).filter((x): x is number => typeof x === "number");
      const min = conf.length > 0 ? Math.min(...conf).toFixed(2) : "n/d";
      return `${str(objeto(args).mensaje_id)}: ${conf.length} campos, confianza mínima ${min}`;
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

// Alcance A: un único checkpointer en memoria (session.ts), hilo = sesión. No sobrevive a reinicios.
const ocupadas = new WeakSet<Session>();
function positivo(valor: string | undefined, defecto: number, maximo = 1_000_000): number {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? Math.min(n, maximo) : defecto;
}
function objeto(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}
function parse(texto: string): RespuestaTool {
  try { const r = objeto(JSON.parse(texto)); return { ...r, ok: r.ok === true } as RespuestaTool; }
  catch { return { ok: false, error: "respuesta de herramienta no válida" }; }
}
function canonico(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonico).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonico(x)}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
function hash(operacion: Revision["operacion"], campos: CampoRevision[], sourceFingerprint: string): string {
  return createHash("sha256").update(canonico({ operacion, campos, sourceFingerprint })).digest("hex");
}
function fingerprint(directory: string, mensajeId: string): string {
  const contenido: Record<string, string> = {};
  const carpeta = join(directory, "fixtures/reto-02/buzon", mensajeId);
  if (/^msg-\d{3}$/.test(mensajeId) && existsSync(carpeta)) {
    for (const e of readdirSync(carpeta, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isFile() || e.isSymbolicLink()) contenido[`mensaje/${e.name}`] = createHash("sha256").update(readFileSync(join(carpeta, e.name))).digest("hex");
    }
  }
  const maestro = existsSync(join(directory, "out/sharepoint/maestro-contratos.csv")) ? "out/sharepoint/maestro-contratos.csv" : "fixtures/reto-02/maestro-contratos.csv";
  for (const p of [maestro, "fixtures/reto-02/comerciales.json"]) contenido[p] = existsSync(join(directory, p)) ? createHash("sha256").update(readFileSync(join(directory, p))).digest("hex") : "ausente";
  return createHash("sha256").update(canonico(contenido)).digest("hex");
}
function camposRevision(r: RespuestaTool): CampoRevision[] | null {
  if (r.ok || !Array.isArray(r.revision) || r.revision.length === 0) return null;
  if (!r.revision.every((v: unknown) => {
    const c = objeto(v);
    return typeof c.campo === "string" && typeof c.confianza === "number" && typeof c.motivo === "string" && Object.hasOwn(c, "valor_propuesto");
  })) return null;
  return structuredClone(r.revision) as CampoRevision[];
}
function crearRevision(pedido: Pedido, campos: CampoRevision[], directory: string): Revision {
  const a = objeto(pedido.args);
  const args: Record<string, unknown> = { mensaje_id: a.mensaje_id };
  if (typeof a.hoy === "string") args.hoy = a.hoy;
  const operacion: Revision["operacion"] = { name: "contratos_registrar", args };
  const sourceFingerprint = fingerprint(directory, String(a.mensaje_id));
  const valores = campos.map((c) => `${c.campo}=${JSON.stringify(c.valor_propuesto)}`).join(", ");
  const fecha = typeof args.hoy === "string" ? `Fecha de registro (hoy): ${args.hoy}.` : "Fecha de registro: la predeterminada del servidor.";
  const reviewId = randomUUID();
  const revision = { mensaje_id: String(a.mensaje_id), campos, reviewId, operationHash: hash(operacion, campos, sourceFingerprint), sourceFingerprint, operacion, pregunta: "" };
  revision.pregunta = `El mensaje ${revision.mensaje_id} requiere revisión: ${valores}. ${fecha} ¿Confirmas el registro con estos valores? ${frasesAceptadas(revision)}`;
  return revision;
}
/** Frase del PRD, solo si la revisión es exactamente valor + fecha_fin con valores bien formados. */
function frasePRD(r: Pick<Revision, "campos">): { valor: number; fin: string } | null {
  const valor = r.campos.find((c) => c.campo === "valor")?.valor_propuesto;
  const fin = r.campos.find((c) => c.campo === "fecha_fin")?.valor_propuesto;
  return r.campos.length === 2 && typeof valor === "number" && Number.isFinite(valor) && typeof fin === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fin) ? { valor, fin } : null;
}
function frasesAceptadas(r: Pick<Revision, "campos" | "reviewId" | "mensaje_id">): string {
  const prd = frasePRD(r);
  const aprobar = [...(prd ? [`"confirmo el valor ${prd.valor} y la fecha fin ${prd.fin}"`] : []), `"confirmo revisión ${r.reviewId}"`];
  return `Para aprobar responde ${aprobar.join(" o ")}; para rechazar, "rechazo el registro de ${r.mensaje_id}".`;
}

/** Gramática cerrada: se compara el mensaje completo, nunca se buscan palabras de autorización.
 * El ID elige el snapshot, que incluye operación/valores/fuente/maestro. El único atajo
 * sin ID es la frase literal del PRD, construida con los dos valores mostrados.
 */
function decisionHumana(r: Revision, message: string): DecisionHumana | null {
  if (hash(r.operacion, r.campos, r.sourceFingerprint) !== r.operationHash) return null;
  // Normaliza solo forma (mayúsculas, espacios, punto/exclamación final); cualquier palabra extra sigue sin autorizar.
  const texto = message.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!]+$/u, "").trim();
  const aprobaciones = [
    `confirmo revisión ${r.reviewId}`,
    `confirmo ${r.mensaje_id} (revisión ${r.reviewId})`,
  ];
  const prd = frasePRD(r);
  const escapar = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const variantePRD = prd ? new RegExp(`^confirmo:? (?:el )?valor ${escapar(String(prd.valor))},? y (?:la )?fecha (?:de )?fin ${escapar(prd.fin)}$`, "u") : null;
  const rechazos = [
    `rechazo revisión ${r.reviewId}`,
    `rechazo el registro de ${r.mensaje_id}`,
    `no confirmo, cancela ${r.mensaje_id}`,
  ];
  const approved = aprobaciones.includes(texto) || (variantePRD?.test(texto) ?? false);
  if (!approved && !rechazos.includes(texto)) return null;
  return { reviewId: r.reviewId, operationHash: r.operationHash, approved, message };
}
/** El proveedor recibe pares completos, en el orden real de ejecución, incluso tras una pausa. */
function historialProveedor(history: MensajePaso[]): MensajePaso[] {
  const pedidos = new Map(history.flatMap((m) => (m.toolCalls ?? []).map((p) => [p.id, p] as const)));
  const salida: MensajePaso[] = [];
  for (const m of history) {
    if (m.role === "tool") {
      const pedido = m.toolCallId ? pedidos.get(m.toolCallId) : undefined;
      if (pedido) salida.push({ role: "assistant", content: "", toolCalls: [structuredClone(pedido)] }, structuredClone(m));
    } else if (m.role === "user" || m.content) salida.push({ role: m.role, content: m.content });
  }
  return salida;
}
const corto = (t: { name: string; resumen?: string }): string => `${t.name.replace(/^contratos_/, "")}${t.resumen ? ` (${t.resumen})` : ""}`;
/** Datos visibles respaldados por herramientas (CA2); el texto libre del modelo va encima. */
function resumenDeterminista(f: Flujo): string {
  const hechos = f.toolCalls.filter((t) => t.ok).map(corto).join("; ");
  const fallos = f.toolCalls.filter((t) => !t.ok).map(corto);
  if (f.limite) {
    // CA1: como replyDeterminista de e735094, siempre dice qué falta y cómo seguir.
    const falta = [...fallos, ...f.queue.map(corto), ...(f.review ? [`confirmación de ${f.review.mensaje_id}`] : [])];
    return `${f.stop} Hecho: ${hechos || "nada completado"}. Falta: ${falta.join("; ") || "el resto del lote"}. Escribe 'continúa' para seguir.`;
  }
  if (!f.toolCalls.length) return `${f.stop ? `${f.stop} ` : ""}Sin datos verificados: no se ejecutó ninguna herramienta en este turno.`;
  return `${f.stop || "Resultados de las herramientas."} Hecho: ${hechos || "nada completado"}.${fallos.length ? ` Pendiente: ${fallos.join("; ")}.` : ""}${f.queue.length && !f.review ? " Hay herramientas pendientes; escribe 'continúa' para seguir." : ""}`;
}
export class ErrorTurnoGrafo extends Error {
  readonly partial: RunResult;
  constructor(cause: unknown, partial: RunResult) {
    super(cause instanceof Error && cause.message.startsWith("LLM no configurado") ? cause.message : "El proveedor del modelo falló o expiró; la sesión sigue activa", { cause });
    this.name = "ErrorTurnoGrafo";
    this.partial = partial;
  }
}

/** Contexto de un turno en curso (no serializable): los nodos lo obtienen por thread_id. */
interface Turno {
  o: RunOpts;
  maxSteps: number;
  maxTools: number;
  maxOutput: number;
  deadline: number;
  /** Último estado completo: si un nodo lanza, se persiste para conservar uso, intentos y cola. */
  actual: Flujo;
}
const turnos = new Map<string, Turno>();
function turnoDe(config: LangGraphRunnableConfig): Turno {
  const t = turnos.get(String(config.configurable?.thread_id));
  if (!t) throw new Error("No hay un turno activo para este hilo");
  return t;
}
function guardar(t: Turno, cambio: Cambio): Cambio {
  t.actual = { ...t.actual, ...cambio };
  return cambio;
}
const mid = (args: unknown): string | null => typeof objeto(args).mensaje_id === "string" ? String(objeto(args).mensaje_id) : null;

async function ejecutar(t: Turno, f: Flujo, pedido: Pedido, autorizado = false): Promise<Cambio> {
  const { o } = t;
  const args = objeto(pedido.args);
  let salida: string;
  const veto = pedido.name === "contratos_registrar" && !autorizado && (args.confirmado === true || Object.keys(objeto(args.contrato)).length > 0);
  if (veto) {
    salida = JSON.stringify({ ok: false, error: "registro vetado: confirmado y correcciones requieren aprobación humana del snapshot; el modelo no autoriza" });
    escribirLog(o.directory, { herramienta: "registrar", mensaje_id: mid(args), ok: false, resumen: "registro vetado: falta aprobación humana del snapshot", sessionId: o.session.id, callId: pedido.id });
  } else {
    try { salida = await (o.runTool ?? ejecutarTool)(pedido.name, pedido.args, { directory: o.directory, sessionId: o.session.id, callId: pedido.id }); }
    catch {
      salida = JSON.stringify({ ok: false, error: "error interno de la herramienta" });
      escribirLog(o.directory, { herramienta: pedido.name.replace(/^contratos_/, ""), mensaje_id: mid(args), ok: false, resumen: "error interno de la herramienta", sessionId: o.session.id, callId: pedido.id });
    }
  }
  const respuesta = parse(salida);
  const call: ToolCallInfo = { id: pedido.id, name: pedido.name, args: structuredClone(pedido.args), ok: respuesta.ok, resumen: resumir(pedido.name, respuesta, pedido.args) };
  return { last: { pedido, respuesta }, toolCalls: [...f.toolCalls, call], history: [...f.history, { role: "tool", content: salida, toolCallId: pedido.id }] };
}
function cancelarPedidos(t: Turno, f: Flujo, pedidos: Pedido[], motivo: string): Cambio {
  const calls = pedidos.map((p): ToolCallInfo => {
    escribirLog(t.o.directory, { herramienta: p.name.replace(/^contratos_/, ""), mensaje_id: mid(p.args), ok: false, resumen: motivo, sessionId: t.o.session.id, callId: p.id });
    return { id: p.id, name: p.name, args: structuredClone(p.args), ok: false, resumen: motivo };
  });
  return { queue: [], toolCalls: [...f.toolCalls, ...calls], history: [...f.history, ...pedidos.map((p): MensajePaso => ({ role: "tool", toolCallId: p.id, content: JSON.stringify({ ok: false, error: motivo }) }))] };
}
/** Tras un registro aprobado, los registrar en cola del mismo mensaje no se ejecutan ni vuelven a pedir revisión. */
function omitirRegistrados(f: Flujo, mensajeId: string): Cambio {
  // Solo llamadas simples: un intento del modelo de autorizar (confirmado/contrato) sigue pasando por el veto auditado.
  const omitidos = f.queue.filter((p) => { const a = objeto(p.args); return p.name === "contratos_registrar" && a.mensaje_id === mensajeId && a.confirmado === undefined && a.contrato === undefined; });
  if (!omitidos.length) return {};
  const motivo = `omitido: ${mensajeId} ya quedó registrado con la aprobación de la persona`;
  return { queue: f.queue.filter((p) => !omitidos.includes(p)),
    toolCalls: [...f.toolCalls, ...omitidos.map((p): ToolCallInfo => ({ id: p.id, name: p.name, args: structuredClone(p.args), ok: true, resumen: motivo }))],
    history: [...f.history, ...omitidos.map((p): MensajePaso => ({ role: "tool", toolCallId: p.id, content: JSON.stringify({ ok: true, data: { mensaje_id: mensajeId, accion: "omitido", motivo } }) }))] };
}

// ── Nodos ───────────────────────────────────────────────────────────────────────────────
async function nodoModelo(s: Flujo, config: LangGraphRunnableConfig): Promise<Cambio> {
  const t = turnoDe(config);
  const { o } = t;
  const tope = s.steps >= t.maxSteps ? `Alcancé el tope de ${t.maxSteps} pasos.`
    : o.session.tokens + s.tokens >= o.maxTokens ? "Alcancé el tope de tokens del turno."
    : Date.now() >= t.deadline ? "Alcancé el tope de tiempo del turno." : "";
  if (tope) return guardar(t, { stop: tope, limite: true });
  const history = historialProveedor(s.history);
  // Para el transporte textual, los bytes UTF-8 más margen de framing son una
  // cota conservadora de entrada; no se presenta como consumo medido.
  const inputBytes = Buffer.byteLength(JSON.stringify({ system: o.prompt, history, tools: herramientas.map((h) => ({ name: h.name, description: h.description, schema: z.toJSONSchema(h.inputSchema) })) }));
  const inputBound = inputBytes + 2048 + history.length * 64 + herramientas.length * 512;
  const outputLimit = Math.min(t.maxOutput, o.maxTokens - o.session.tokens - s.tokens - inputBound);
  if (inputBytes > positivo(process.env.LLM_MAX_INPUT_BYTES, 200_000, 1_000_000) || outputLimit < 1) return guardar(t, { stop: "El contexto excede la entrada permitida o el presupuesto restante. No envié otra llamada al modelo." });
  // Cuenta también el intento que termina con error de proveedor.
  guardar(t, { steps: s.steps + 1, usageKnown: false, incierto: s.incierto + inputBound + outputLimit });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let paso: PasoLLM;
  try {
    paso = await Promise.race([
      o.adapter.generarPaso(history, herramientas, { system: o.prompt, signal: controller.signal, maxOutputTokens: outputLimit }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("tiempo del modelo agotado")); }, Math.max(1, t.deadline - Date.now())); }),
    ]);
  } catch (error) {
    // Sin clave no hubo transporte: el intento no consume tokens.
    if (error instanceof Error && error.message.startsWith("LLM no configurado")) guardar(t, { incierto: s.incierto });
    throw error;
  } finally { if (timer) clearTimeout(timer); }
  const valido = Number.isFinite(paso.tokens) && paso.tokens >= 0;
  const tokens = s.tokens + (valido ? paso.tokens : 0);
  const uso: Cambio = { steps: s.steps + 1, tokens, incierto: s.incierto, usoSinInformar: s.usoSinInformar || !paso.usoConocido, usageKnown: s.usageKnown && paso.usoConocido && valido };
  guardar(t, uso);
  if (!paso.usoConocido) throw new Error("El proveedor no informó uso de tokens; turno detenido");
  if (tokens > o.maxTokens - o.session.tokens) return guardar(t, { ...uso, stop: "El proveedor informó un uso superior al presupuesto; no ejecuté sus herramientas." });
  if (paso.llamadas.length > t.maxTools || canonico(paso.llamadas).length > 200_000 || paso.texto.length > 100_000) {
    const limitado = { ...s, history: [...s.history, { role: "assistant" as const, content: "", toolCalls: paso.llamadas }] };
    return guardar(t, { ...uso, ...cancelarPedidos(t, limitado, paso.llamadas, "Solicitud cancelada: la salida del modelo excedió el límite permitido."), stop: "La salida del modelo excedió el límite permitido." });
  }
  const calls = structuredClone(paso.llamadas);
  // Sin llamadas, el texto es la respuesta final del modelo y se muestra (sobre el resumen de tools).
  return guardar(t, { ...uso, history: [...s.history, { role: "assistant", content: paso.texto, ...(calls.length ? { toolCalls: calls } : {}) }], queue: calls, reply: calls.length ? "" : paso.texto, last: null });
}

async function nodoHerramienta(s: Flujo, config: LangGraphRunnableConfig): Promise<Cambio> {
  const t = turnoDe(config);
  if (s.toolCalls.length >= t.maxTools || Date.now() >= t.deadline) {
    const tope = s.toolCalls.length >= t.maxTools ? `Alcancé el tope de ${t.maxTools} herramientas.` : "Alcancé el tope de tiempo del turno.";
    return guardar(t, { ...cancelarPedidos(t, s, s.queue, `Solicitud cancelada: ${tope.replace(/^Alcancé el /, "").replace(/\.$/, "")}.`), stop: tope, limite: true });
  }
  const [pedido, ...resto] = s.queue;
  if (!pedido) return guardar(t, { last: null });
  return guardar(t, { queue: resto, ...await ejecutar(t, s, pedido) });
}

function nodoDetectarRevision(s: Flujo, config: LangGraphRunnableConfig): Cambio {
  const t = turnoDe(config);
  if (!s.last) return guardar(t, { last: null });
  const { pedido, respuesta } = s.last;
  if (pedido.name === "contratos_registrar") {
    const campos = camposRevision(respuesta);
    if (campos) return guardar(t, { review: crearRevision(pedido, campos, t.o.directory), reply: "", last: null });
  }
  const d = objeto(respuesta.data);
  const a = objeto(pedido.args);
  if (pedido.name === "contratos_validar" && respuesta.ok && typeof a.mensaje_id === "string" && Array.isArray(d.requiere_revision) && d.requiere_revision.length > 0 && (d.clasificacion === "nuevo" || d.clasificacion === "actualizacion" || (d.clasificacion === "duplicado" && Object.keys(objeto(d.motivos_revision)).length > 0))) {
    // El hoy aprobado sale del registrar que el modelo dejó en cola para ese mensaje, si existe.
    const hoy = s.queue.filter((p) => p.name === "contratos_registrar").map((p) => objeto(p.args)).find((x) => x.mensaje_id === a.mensaje_id && typeof x.hoy === "string")?.hoy;
    const sonda: Pedido = { id: `sonda-${randomUUID()}`, name: "contratos_registrar", args: { mensaje_id: a.mensaje_id, ...(typeof hoy === "string" ? { hoy } : {}) }, sonda: true };
    // La sonda es una llamada visible; también conserva historial assistant/tool bien formado.
    return guardar(t, { queue: [sonda, ...s.queue], last: null, history: [...s.history, { role: "assistant", content: "Sonda del servidor para obtener la revisión humana.", toolCalls: [sonda] }] });
  }
  return guardar(t, { last: null });
}

function nodoPausa(s: Flujo, config: LangGraphRunnableConfig): Cambio {
  // Este nodo se reejecuta al reanudar: interrupt es su primera operación, sin efectos previos.
  const respuesta = interrupt<Revision | null, DecisionHumana>(s.review);
  return guardar(turnoDe(config), { respuestaHumana: respuesta, history: [...s.history, { role: "user", content: respuesta.message }] });
}

function nodoDecision(s: Flujo, config: LangGraphRunnableConfig): Cambio {
  const t = turnoDe(config);
  const r = s.review;
  const d = s.respuestaHumana;
  if (!r || !d || d.reviewId !== r.reviewId || d.operationHash !== r.operationHash || decisionHumana(r, d.message)?.approved !== d.approved) throw new Error("La decisión no corresponde a la revisión pendiente");
  if (d.approved) return guardar(t, { respuestaHumana: d });
  return guardar(t, { review: null, respuestaHumana: null, reply: `Registro de ${r.mensaje_id} cancelado.`, history: [...s.history, { role: "assistant", content: `La persona rechazó registrar ${r.mensaje_id}.` }] });
}

async function nodoRegistroAprobado(s: Flujo, config: LangGraphRunnableConfig): Promise<Cambio> {
  const t = turnoDe(config);
  const r = s.review!;
  if (fingerprint(t.o.directory, r.mensaje_id) !== r.sourceFingerprint) {
    return guardar(t, { review: null, respuestaHumana: null, queue: [], stop: "El documento o maestro cambió desde la revisión. No registré la operación; vuelve a procesar el mensaje para una nueva revisión." });
  }
  const contrato = Object.fromEntries(r.campos.map((c) => [c.campo, structuredClone(c.valor_propuesto)]));
  const pedido: Pedido = { id: `aprobacion-${r.reviewId}`, name: r.operacion.name, args: { ...structuredClone(r.operacion.args), contrato, confirmado: true } };
  const conPedido: Flujo = { ...s, history: [...s.history, { role: "assistant", content: "Registro autorizado por la persona para el snapshot mostrado.", toolCalls: [pedido] }] };
  const hecho = await ejecutar(t, conPedido, pedido, true);
  const omitidos = hecho.last?.respuesta.ok ? omitirRegistrados({ ...conPedido, ...hecho }, r.mensaje_id) : {};
  return guardar(t, { ...hecho, ...omitidos, review: null, respuestaHumana: null });
}

// ── Rutas ───────────────────────────────────────────────────────────────────────────────
const rutaInicio = (s: Flujo) => s.queue.length ? "herramienta" : "modelo";
const rutaDesdeModelo = (s: Flujo) => s.stop || !s.queue.length ? END : "herramienta";
const rutaDesdeHerramienta = (s: Flujo) => s.stop ? END : "detectar_revision";
const rutaDesdeRevision = (s: Flujo) => s.stop ? END : s.review ? "pausa" : s.queue.length ? "herramienta" : "modelo";
const rutaDesdeDecision = (s: Flujo) => s.review ? "registro_aprobado" : s.queue.length ? "herramienta" : "modelo";

/** Un modelo por nodo, una herramienta por nodo, revisión y pausa en nodos independientes. Se compila una vez. */
const grafo = new StateGraph(Estado)
  .addNode("modelo", nodoModelo)
  .addNode("herramienta", nodoHerramienta)
  .addNode("detectar_revision", nodoDetectarRevision)
  .addNode("pausa", nodoPausa)
  .addNode("decision", nodoDecision)
  .addNode("registro_aprobado", nodoRegistroAprobado)
  .addConditionalEdges(START, rutaInicio, ["herramienta", "modelo"])
  .addConditionalEdges("modelo", rutaDesdeModelo, [END, "herramienta"])
  .addConditionalEdges("herramienta", rutaDesdeHerramienta, [END, "detectar_revision"])
  .addConditionalEdges("detectar_revision", rutaDesdeRevision, [END, "pausa", "herramienta", "modelo"])
  .addEdge("pausa", "decision")
  .addConditionalEdges("decision", rutaDesdeDecision, ["registro_aprobado", "herramienta", "modelo"])
  .addEdge("registro_aprobado", "detectar_revision")
  .compile({ checkpointer });

export async function ejecutarTurnoGrafo(o: RunOpts): Promise<RunResult> {
  if (ocupadas.has(o.session)) throw new Error("La sesión está procesando otra petición");
  ocupadas.add(o.session);
  try { return await turno(o); }
  finally { ocupadas.delete(o.session); turnos.delete(o.session.id); }
}
async function turno(o: RunOpts): Promise<RunResult> {
  const maxSteps = positivo(process.env.MAX_STEPS, 25, 1000);
  const maxTools = positivo(process.env.MAX_TOOL_CALLS, 100, 1000);
  const config = { configurable: { thread_id: o.session.id }, recursionLimit: maxSteps * 5 + maxTools * 4 + 20 };
  const previo = await grafo.getState(config);
  const anterior = previo.values as Partial<Flujo>;
  const history = anterior.history ?? o.session.messages.map((m): MensajePaso => ({ role: m.role, content: m.text }));
  const reinicio: Flujo = { history, queue: anterior.queue ?? [], review: anterior.review ?? null, respuestaHumana: null, last: null, toolCalls: [], steps: 0, tokens: 0, usageKnown: true, reply: "", stop: "", limite: false, incierto: 0, usoSinInformar: false };
  const t: Turno = { o, maxSteps, maxTools, maxOutput: positivo(process.env.LLM_MAX_OUTPUT_TOKENS, 4096, 32_768), deadline: Date.now() + positivo(process.env.LLM_TIMEOUT_MS, 60_000, 600_000), actual: reinicio };
  turnos.set(o.session.id, t);
  o.session.messages.push({ role: "user", text: o.message, ts: new Date().toISOString() });
  let fallo: unknown;
  try {
    if (reinicio.review && previo.next.includes("pausa")) {
      const decision = decisionHumana(reinicio.review, o.message);
      if (!decision) return finalizar(o, { ...reinicio, reply: `No registré nada: tu mensaje no es una decisión sobre ${reinicio.review.mensaje_id} y la revisión sigue pendiente. Usa el botón Aprobar o Rechazar, o envía solo una de las frases aceptadas. ${frasesAceptadas(reinicio.review)}` });
      await grafo.invoke(new Command({ resume: decision, update: reinicio }), config);
    } else await grafo.invoke({ ...reinicio, history: [...reinicio.history, { role: "user", content: o.message }] }, config);
  } catch (error) {
    fallo = error;
    // El nodo de modelo puede fallar antes de emitir update; guarda uso/intento y cola previos.
    await grafo.updateState(config, t.actual).catch(() => undefined);
  }
  if (!fallo) return finalizar(o, t.actual);
  throw new ErrorTurnoGrafo(fallo, finalizar(o, { ...t.actual, stop: "El proveedor falló. Conservé las herramientas ejecutadas y la revisión pendiente; puedes reintentar.", reply: "" }));
}

function finalizar(o: RunOpts, f: Flujo): RunResult {
  o.session.tokens += f.tokens;
  // Expone solo el snapshot para presentación. La operación autorizable vive en el checkpoint.
  const pending: NeedsConfirmation | null = f.review ? { mensaje_id: f.review.mensaje_id, campos: structuredClone(f.review.campos), pregunta: f.review.pregunta, reviewId: f.review.reviewId, operationHash: f.review.operationHash } : null;
  o.session.pending = pending;
  // Texto final del modelo arriba; debajo, los datos respaldados por tools. Topes y fallos: solo determinista.
  const resumen = pending && !f.toolCalls.length && !f.limite ? "" : resumenDeterminista(f);
  const baseReply = f.reply && !f.stop ? [f.reply, resumen].filter(Boolean).join("\n\n") : resumen;
  const reply = pending ? [baseReply, pending.pregunta].filter(Boolean).join("\n") : baseReply;
  o.session.messages.push({ role: "assistant", text: reply, toolCalls: structuredClone(f.toolCalls), ts: new Date().toISOString() });
  return { reply, toolCalls: f.toolCalls, needsConfirmation: pending, usage: { steps: f.steps, tokens: f.tokens, known: f.usageKnown, ...(!f.usageKnown && !f.usoSinInformar ? { uncertain: f.incierto } : {}) } };
}
