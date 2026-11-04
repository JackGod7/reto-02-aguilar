import "../llm/sin-trazas.ts"; // primero: fuerza tracing externo apagado
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt } from "@langchain/langgraph";
import { traceable } from "langsmith/traceable";
import { z } from "zod";
import type { LlamadaLLM, MensajePaso, PasoLLM } from "../llm/adapter.ts";
import { escribirLog } from "../infra/registros.ts";
import { construirHerramientas, ejecutarTool } from "./registry.ts";
import { resumir } from "./run.ts";
import type { RunOpts, RunResult } from "./run.ts";
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
interface Flujo {
  history: MensajePaso[];
  queue: Pedido[];
  review: Revision | null;
  decision: DecisionHumana | null;
  last: { pedido: Pedido; respuesta: RespuestaTool } | null;
  toolCalls: ToolCallInfo[];
  steps: number;
  tokens: number;
  usageKnown: boolean;
  reply: string;
  stop: string;
  /** El stop proviene de un tope (pasos, tokens, tiempo o herramientas): la respuesta lista lo que falta. */
  limite: boolean;
  /** Cota (entrada + salida máxima) de llamadas que fallaron antes de devolver respuesta. */
  incierto: number;
  /** El proveedor respondió sin informar uso: no hay cota y el servidor retiene la reserva. */
  usoSinInformar: boolean;
}
const Estado = Annotation.Root({ flow: Annotation<Flujo>() });

// Alcance A: checkpoints del proceso ligados a la vida de Session. No sobreviven a reinicios.
const savers = new WeakMap<Session, MemorySaver>();
const ocupadas = new WeakSet<Session>();
function saverDe(s: Session): MemorySaver {
  let saver = savers.get(s);
  if (!saver) { saver = new MemorySaver(); savers.set(s, saver); }
  return saver;
}
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

/** Un modelo por nodo, una herramienta por nodo, revisión y pausa en nodos independientes. */
export async function ejecutarTurnoGrafo(o: RunOpts): Promise<RunResult> {
  if (!o.adapter.generarPaso) throw new Error("El motor LangGraph requiere un proveedor generarPaso");
  if (ocupadas.has(o.session)) throw new Error("La sesión está procesando otra petición");
  ocupadas.add(o.session);
  try { return await turno(o); }
  finally { ocupadas.delete(o.session); }
}
async function turno(o: RunOpts): Promise<RunResult> {
  const generar = o.adapter.generarPaso!.bind(o.adapter);
  const maxSteps = positivo(process.env.MAX_STEPS, 25, 1000);
  const maxTools = positivo(process.env.MAX_TOOL_CALLS, 100, 1000);
  const timeout = positivo(process.env.LLM_TIMEOUT_MS, 60_000, 600_000);
  const deadline = Date.now() + timeout;
  const maxOutput = positivo(process.env.LLM_MAX_OUTPUT_TOKENS, 4096, 32_768);
  let actual: Flujo;
  const guardar = (f: Flujo): { flow: Flujo } => { actual = f; return { flow: f }; };
  const herramientas = construirHerramientas(async () => { throw new Error("Solo el nodo herramienta puede ejecutar herramientas"); });
  const run = o.runTool ?? ejecutarTool;
  async function ejecutar(f: Flujo, pedido: Pedido, autorizado = false): Promise<Flujo> {
    const args = objeto(pedido.args);
    let salida: string;
    const veto = pedido.name === "contratos_registrar" && !autorizado && (args.confirmado === true || Object.keys(objeto(args.contrato)).length > 0);
    if (veto) {
      salida = JSON.stringify({ ok: false, error: "registro vetado: confirmado y correcciones requieren aprobación humana del snapshot; el modelo no autoriza" });
      escribirLog(o.directory, { herramienta: "registrar", mensaje_id: typeof args.mensaje_id === "string" ? args.mensaje_id : null, ok: false, resumen: "registro vetado: falta aprobación humana del snapshot", sessionId: o.session.id, callId: pedido.id });
    } else {
      try { salida = await run(pedido.name, pedido.args, { directory: o.directory, sessionId: o.session.id, callId: pedido.id }); }
      catch {
        salida = JSON.stringify({ ok: false, error: "error interno de la herramienta" });
        escribirLog(o.directory, { herramienta: pedido.name.replace(/^contratos_/, ""), mensaje_id: typeof args.mensaje_id === "string" ? args.mensaje_id : null, ok: false, resumen: "error interno de la herramienta", sessionId: o.session.id, callId: pedido.id });
      }
    }
    const respuesta = parse(salida);
    const call: ToolCallInfo = { id: pedido.id, name: pedido.name, args: structuredClone(pedido.args), ok: respuesta.ok, resumen: resumir(pedido.name, respuesta, pedido.args) };
    return { ...f, last: { pedido, respuesta }, toolCalls: [...f.toolCalls, call], history: [...f.history, { role: "tool", content: salida, toolCallId: pedido.id }] };
  }
  function cancelarPedidos(f: Flujo, pedidos: Pedido[], motivo: string): Flujo {
    const calls = pedidos.map((p): ToolCallInfo => {
      escribirLog(o.directory, { herramienta: p.name.replace(/^contratos_/, ""), mensaje_id: typeof objeto(p.args).mensaje_id === "string" ? String(objeto(p.args).mensaje_id) : null, ok: false, resumen: motivo, sessionId: o.session.id, callId: p.id });
      return { id: p.id, name: p.name, args: structuredClone(p.args), ok: false, resumen: motivo };
    });
    return { ...f, queue: [], toolCalls: [...f.toolCalls, ...calls], history: [...f.history, ...pedidos.map((p): MensajePaso => ({ role: "tool", toolCallId: p.id, content: JSON.stringify({ ok: false, error: motivo }) }))] };
  }
  /** Tras un registro aprobado, los registrar en cola del mismo mensaje no se ejecutan ni vuelven a pedir revisión. */
  function omitirRegistrados(f: Flujo, mensajeId: string): Flujo {
    // Solo llamadas simples: un intento del modelo de autorizar (confirmado/contrato) sigue pasando por el veto auditado.
    const omitidos = f.queue.filter((p) => { const a = objeto(p.args); return p.name === "contratos_registrar" && a.mensaje_id === mensajeId && a.confirmado === undefined && a.contrato === undefined; });
    if (!omitidos.length) return f;
    const motivo = `omitido: ${mensajeId} ya quedó registrado con la aprobación de la persona`;
    return { ...f, queue: f.queue.filter((p) => !omitidos.includes(p)),
      toolCalls: [...f.toolCalls, ...omitidos.map((p): ToolCallInfo => ({ id: p.id, name: p.name, args: structuredClone(p.args), ok: true, resumen: motivo }))],
      history: [...f.history, ...omitidos.map((p): MensajePaso => ({ role: "tool", toolCallId: p.id, content: JSON.stringify({ ok: true, data: { mensaje_id: mensajeId, accion: "omitido", motivo } }) }))] };
  }
  const builder = new StateGraph(Estado)
    .addNode("inicio", ({ flow }) => guardar(flow))
    .addNode("modelo", async ({ flow }) => {
      const tope = flow.steps >= maxSteps ? `Alcancé el tope de ${maxSteps} pasos.`
        : o.session.tokens + flow.tokens >= o.maxTokens ? "Alcancé el tope de tokens del turno."
        : Date.now() >= deadline ? "Alcancé el tope de tiempo del turno." : "";
      if (tope) return guardar({ ...flow, stop: tope, limite: true });
      const history = historialProveedor(flow.history);
      // Para el transporte textual, los bytes UTF-8 más margen de framing son una
      // cota conservadora de entrada; no se presenta como consumo medido.
      const inputBytes = Buffer.byteLength(JSON.stringify({ system: o.prompt, history, tools: herramientas.map((h) => ({ name: h.name, description: h.description, schema: z.toJSONSchema(h.inputSchema) })) }));
      const inputBound = inputBytes + 2048 + history.length * 64 + herramientas.length * 512;
      const remaining = o.maxTokens - o.session.tokens - flow.tokens;
      const outputLimit = Math.min(maxOutput, remaining - inputBound);
      if (inputBytes > positivo(process.env.LLM_MAX_INPUT_BYTES, 200_000, 1_000_000) || outputLimit < 1) return guardar({ ...flow, stop: "El contexto excede la entrada permitida o el presupuesto restante. No envié otra llamada al modelo." });
      const intentado = { ...flow, steps: flow.steps + 1, usageKnown: false, incierto: flow.incierto + inputBound + outputLimit };
      guardar(intentado); // Cuenta también el intento que termina con error de proveedor.
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let paso: PasoLLM;
      try {
        paso = await Promise.race([
          generar(history, herramientas, { system: o.prompt, signal: controller.signal, maxOutputTokens: outputLimit }),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("tiempo del modelo agotado")); }, Math.max(1, deadline - Date.now())); }),
        ]);
      } catch (error) {
        // Sin clave no hubo transporte: el intento no consume tokens.
        if (error instanceof Error && error.message.startsWith("LLM no configurado")) guardar({ ...intentado, incierto: flow.incierto });
        throw error;
      } finally { if (timer) clearTimeout(timer); }
      const tokens = intentado.tokens + (Number.isFinite(paso.tokens) && paso.tokens >= 0 ? paso.tokens : 0);
      const actualizado = { ...intentado, tokens, incierto: flow.incierto, usoSinInformar: flow.usoSinInformar || !paso.usoConocido, usageKnown: flow.usageKnown && paso.usoConocido && Number.isFinite(paso.tokens) && paso.tokens >= 0 };
      guardar(actualizado);
      if (!paso.usoConocido) throw new Error("El proveedor no informó uso de tokens; turno detenido");
      if (tokens > o.maxTokens - o.session.tokens) return guardar({ ...actualizado, stop: "El proveedor informó un uso superior al presupuesto; no ejecuté sus herramientas." });
      if (paso.llamadas.length > maxTools || canonico(paso.llamadas).length > 200_000 || paso.texto.length > 100_000) {
        const limitado = { ...actualizado, history: [...flow.history, { role: "assistant" as const, content: "", toolCalls: paso.llamadas }] };
        return guardar({ ...cancelarPedidos(limitado, paso.llamadas, "Solicitud cancelada: la salida del modelo excedió el límite permitido."), stop: "La salida del modelo excedió el límite permitido." });
      }
      const calls = structuredClone(paso.llamadas);
      const siguienteHistory: MensajePaso[] = [...flow.history, { role: "assistant", content: paso.texto, ...(calls.length ? { toolCalls: calls } : {}) }];
      // Sin llamadas, el texto es la respuesta final del modelo y se muestra (sobre el resumen de tools).
      return guardar({ ...actualizado, history: siguienteHistory, queue: calls, reply: calls.length ? "" : paso.texto, last: null });
    })
    .addNode("herramienta", async ({ flow }) => {
      if (flow.toolCalls.length >= maxTools || Date.now() >= deadline) {
        const tope = flow.toolCalls.length >= maxTools ? `Alcancé el tope de ${maxTools} herramientas.` : "Alcancé el tope de tiempo del turno.";
        return guardar({ ...cancelarPedidos(flow, flow.queue, `Solicitud cancelada: ${tope.replace(/^Alcancé el /, "").replace(/\.$/, "")}.`), stop: tope, limite: true });
      }
      const pedido = flow.queue[0];
      if (!pedido) return guardar(flow);
      return guardar(await ejecutar({ ...flow, queue: flow.queue.slice(1) }, pedido));
    })
    .addNode("detectar_revision", ({ flow }) => {
      const ultimo = flow.last;
      if (!ultimo) return guardar(flow);
      const { pedido, respuesta } = ultimo;
      if (pedido.name === "contratos_registrar") {
        const campos = camposRevision(respuesta);
        if (campos) return guardar({ ...flow, review: crearRevision(pedido, campos, o.directory), reply: "", last: null });
      }
      const d = objeto(respuesta.data);
      const a = objeto(pedido.args);
      if (pedido.name === "contratos_validar" && respuesta.ok && typeof a.mensaje_id === "string" && Array.isArray(d.requiere_revision) && d.requiere_revision.length > 0 && (d.clasificacion === "nuevo" || d.clasificacion === "actualizacion" || (d.clasificacion === "duplicado" && Object.keys(objeto(d.motivos_revision)).length > 0))) {
        // El hoy aprobado sale del registrar que el modelo dejó en cola para ese mensaje, si existe.
        const hoy = flow.queue.filter((p) => p.name === "contratos_registrar").map((p) => objeto(p.args)).find((x) => x.mensaje_id === a.mensaje_id && typeof x.hoy === "string")?.hoy;
        const sonda: Pedido = { id: `sonda-${randomUUID()}`, name: "contratos_registrar", args: { mensaje_id: a.mensaje_id, ...(typeof hoy === "string" ? { hoy } : {}) }, sonda: true };
        // La sonda es una llamada visible; también conserva historial assistant/tool bien formado.
        return guardar({ ...flow, queue: [sonda, ...flow.queue], last: null, history: [...flow.history, { role: "assistant", content: "Sonda del servidor para obtener la revisión humana.", toolCalls: [sonda] }] });
      }
      return guardar({ ...flow, last: null });
    })
    .addNode("pausa", ({ flow }) => {
      // Este nodo se reejecuta al reanudar: interrupt es su primera operación, sin efectos previos.
      const decision = interrupt<Revision | null, DecisionHumana>(flow.review);
      return guardar({ ...flow, decision, history: [...flow.history, { role: "user", content: decision.message }] });
    })
    .addNode("decision", ({ flow }) => {
      const r = flow.review;
      const d = flow.decision;
      if (!r || !d || d.reviewId !== r.reviewId || d.operationHash !== r.operationHash || decisionHumana(r, d.message)?.approved !== d.approved) throw new Error("La decisión no corresponde a la revisión pendiente");
      if (!d.approved) return guardar({ ...flow, review: null, decision: null, reply: `Registro de ${r.mensaje_id} cancelado.`, history: [...flow.history, { role: "assistant", content: `La persona rechazó registrar ${r.mensaje_id}.` }] });
      return guardar(flow);
    })
    .addNode("registro_aprobado", async ({ flow }) => {
      const r = flow.review!;
      if (fingerprint(o.directory, r.mensaje_id) !== r.sourceFingerprint) {
        return guardar({ ...flow, review: null, decision: null, queue: [], stop: "El documento o maestro cambió desde la revisión. No registré la operación; vuelve a procesar el mensaje para una nueva revisión." });
      }
      const contrato = Object.fromEntries(r.campos.map((c) => [c.campo, structuredClone(c.valor_propuesto)]));
      const pedido: Pedido = { id: `aprobacion-${r.reviewId}`, name: r.operacion.name, args: { ...structuredClone(r.operacion.args), contrato, confirmado: true } };
      const conPedido = { ...flow, history: [...flow.history, { role: "assistant" as const, content: "Registro autorizado por la persona para el snapshot mostrado.", toolCalls: [pedido] }] };
      const hecho = await ejecutar(conPedido, pedido, true);
      return guardar({ ...(hecho.last?.respuesta.ok ? omitirRegistrados(hecho, r.mensaje_id) : hecho), review: null, decision: null });
    })
    .addEdge(START, "inicio")
    .addConditionalEdges("inicio", ({ flow }) => flow.queue.length ? "herramienta" : "modelo", ["herramienta", "modelo"])
    .addConditionalEdges("modelo", ({ flow }) => flow.stop || !flow.queue.length ? END : "herramienta", [END, "herramienta"])
    .addConditionalEdges("herramienta", ({ flow }) => flow.stop ? END : "detectar_revision", [END, "detectar_revision"])
    .addConditionalEdges("detectar_revision", ({ flow }) => flow.stop ? END : flow.review ? "pausa" : flow.queue.length ? "herramienta" : "modelo", [END, "pausa", "herramienta", "modelo"])
    .addEdge("pausa", "decision")
    .addConditionalEdges("decision", ({ flow }) => flow.review ? "registro_aprobado" : flow.queue.length ? "herramienta" : "modelo", ["registro_aprobado", "herramienta", "modelo"])
    .addEdge("registro_aprobado", "detectar_revision");
  const graph = builder.compile({ checkpointer: saverDe(o.session) });
  const config = { configurable: { thread_id: o.session.id }, recursionLimit: maxSteps * 5 + maxTools * 4 + 20 };
  const previo = await graph.getState(config);
  const anterior = previo.values.flow as Flujo | undefined;
  const history = anterior?.history ?? o.session.messages.map((m): MensajePaso => ({ role: m.role, content: m.text }));
  const reinicio: Flujo = { history, queue: anterior?.queue ?? [], review: anterior?.review ?? null, decision: null, last: null, toolCalls: [], steps: 0, tokens: 0, usageKnown: true, reply: "", stop: "", limite: false, incierto: 0, usoSinInformar: false };
  actual = reinicio;
  o.session.messages.push({ role: "user", text: o.message, ts: new Date().toISOString() });
  let fallo: unknown;
  try {
    let input: Parameters<typeof graph.invoke>[0];
    if (reinicio.review && previo.next.includes("pausa")) {
      const decision = decisionHumana(reinicio.review, o.message);
      if (!decision) return finalizar({ ...reinicio, reply: `No registré nada: tu mensaje no es una decisión sobre ${reinicio.review.mensaje_id} y la revisión sigue pendiente. Usa el botón Aprobar o Rechazar, o envía solo una de las frases aceptadas. ${frasesAceptadas(reinicio.review)}` });
      input = new Command<DecisionHumana, { flow: Flujo }, never>({ resume: decision, update: { flow: reinicio } });
    } else input = { flow: { ...reinicio, history: [...reinicio.history, { role: "user", content: o.message }] } };
    const invocar = traceable(async () => graph.invoke(input, config), { name: "turno-contratos-local", tracingEnabled: false });
    await invocar();
  } catch (error) {
    fallo = error;
    // El nodo de modelo puede fallar antes de emitir update; guarda uso/intento y cola previos.
    await graph.updateState(config, { flow: actual }).catch(() => undefined);
  }
  if (fallo) actual = { ...actual, stop: "El proveedor falló. Conservé las herramientas ejecutadas y la revisión pendiente; puedes reintentar.", reply: "" };
  const resultado = finalizar(actual);
  if (fallo) throw new ErrorTurnoGrafo(fallo, resultado);
  return resultado;

  function finalizar(f: Flujo): RunResult {
    o.session.tokens += f.tokens;
    // Expone solo el snapshot para presentación. La operación autorizable vive en el checkpoint.
    const pending: NeedsConfirmation | null = f.review ? { mensaje_id: f.review.mensaje_id, campos: structuredClone(f.review.campos), pregunta: f.review.pregunta, reviewId: f.review.reviewId, operationHash: f.review.operationHash } : null;
    o.session.pending = pending;
    // Texto final del modelo arriba; debajo, los datos respaldados por tools. Topes y fallos: solo determinista.
    const herramientas = pending && !f.toolCalls.length && !f.limite ? "" : resumenDeterminista(f);
    const baseReply = f.reply && !f.stop ? [f.reply, herramientas].filter(Boolean).join("\n\n") : herramientas;
    const reply = pending ? [baseReply, pending.pregunta].filter(Boolean).join("\n") : baseReply;
    o.session.messages.push({ role: "assistant", text: reply, toolCalls: structuredClone(f.toolCalls), ts: new Date().toISOString() });
    return { reply, toolCalls: f.toolCalls, needsConfirmation: pending, usage: { steps: f.steps, tokens: f.tokens, known: f.usageKnown, ...(!f.usageKnown && !f.usoSinInformar ? { uncertain: f.incierto } : {}) } };
  }
}
