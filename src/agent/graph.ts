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
  return { mensaje_id: String(a.mensaje_id), campos, reviewId: randomUUID(), operationHash: hash(operacion, campos, sourceFingerprint), sourceFingerprint, operacion,
    pregunta: `El mensaje ${String(a.mensaje_id)} requiere revisión: ${valores}. ¿Confirmas el registro con estos valores?` };
}

/** Gramática cerrada: se compara el mensaje completo, nunca se buscan palabras de autorización.
 * El ID elige el snapshot, que incluye operación/valores/fuente/maestro. El único atajo
 * sin ID es la frase literal del PRD, construida con los dos valores mostrados.
 */
function decisionHumana(r: Revision, message: string): DecisionHumana | null {
  if (hash(r.operacion, r.campos, r.sourceFingerprint) !== r.operationHash) return null;
  const texto = message.trim().normalize("NFC").toLowerCase();
  const aprobaciones = [
    `confirmo revisión ${r.reviewId}`,
    `confirmo ${r.mensaje_id} (revisión ${r.reviewId})`,
  ];
  const valor = r.campos.find((c) => c.campo === "valor")?.valor_propuesto;
  const fin = r.campos.find((c) => c.campo === "fecha_fin")?.valor_propuesto;
  if (r.campos.length === 2 && typeof valor === "number" && Number.isFinite(valor) &&
      typeof fin === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fin)) {
    aprobaciones.push(`confirmo el valor ${valor} y la fecha fin ${fin}`);
  }
  const rechazos = [
    `rechazo revisión ${r.reviewId}`,
    `rechazo el registro de ${r.mensaje_id}`,
    `no confirmo, cancela ${r.mensaje_id}`,
  ];
  const approved = aprobaciones.includes(texto);
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
function resumenDeterminista(f: Flujo): string {
  const hechos = f.toolCalls.filter((t) => t.ok).map((t) => `${t.name.replace(/^contratos_/, "")} (${t.resumen})`).join("; ");
  const fallos = f.toolCalls.filter((t) => !t.ok).map((t) => `${t.name.replace(/^contratos_/, "")} (${t.resumen})`).join("; ");
  return `${f.stop || (f.toolCalls.length ? "Resultados de las herramientas." : "El modelo no devolvió texto.")} Hecho: ${hechos || "nada completado"}.${fallos ? ` Pendiente: ${fallos}.` : ""}${f.queue.length ? " Hay herramientas pendientes; escribe 'continúa' para seguir." : ""}`;
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
  const builder = new StateGraph(Estado)
    .addNode("inicio", ({ flow }) => guardar(flow))
    .addNode("modelo", async ({ flow }) => {
      if (flow.steps >= maxSteps || o.session.tokens + flow.tokens >= o.maxTokens || Date.now() >= deadline) {
        return guardar({ ...flow, stop: `Alcancé el tope de ${maxSteps} pasos, tokens o tiempo.` });
      }
      const history = historialProveedor(flow.history);
      // Para el transporte textual, los bytes UTF-8 más margen de framing son una
      // cota conservadora de entrada; no se presenta como consumo medido.
      const inputBytes = Buffer.byteLength(JSON.stringify({ system: o.prompt, history, tools: herramientas.map((h) => ({ name: h.name, description: h.description, schema: z.toJSONSchema(h.inputSchema) })) }));
      const inputBound = inputBytes + 2048 + history.length * 64 + herramientas.length * 512;
      const remaining = o.maxTokens - o.session.tokens - flow.tokens;
      const outputLimit = Math.min(maxOutput, remaining - inputBound);
      if (inputBytes > positivo(process.env.LLM_MAX_INPUT_BYTES, 200_000, 1_000_000) || outputLimit < 1) return guardar({ ...flow, stop: "El contexto excede la entrada permitida o el presupuesto restante. No envié otra llamada al modelo." });
      const intentado = { ...flow, steps: flow.steps + 1, usageKnown: false };
      guardar(intentado); // Cuenta también el intento que termina con error de proveedor.
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let paso: PasoLLM;
      try {
        paso = await Promise.race([
          generar(history, herramientas, { system: o.prompt, signal: controller.signal, maxOutputTokens: outputLimit }),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("tiempo del modelo agotado")); }, Math.max(1, deadline - Date.now())); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
      const tokens = intentado.tokens + (Number.isFinite(paso.tokens) && paso.tokens >= 0 ? paso.tokens : 0);
      const actualizado = { ...intentado, tokens, usageKnown: flow.usageKnown && paso.usoConocido && Number.isFinite(paso.tokens) && paso.tokens >= 0 };
      guardar(actualizado);
      if (!paso.usoConocido) throw new Error("El proveedor no informó uso de tokens; turno detenido");
      if (tokens > o.maxTokens - o.session.tokens) return guardar({ ...actualizado, stop: "El proveedor informó un uso superior al presupuesto; no ejecuté sus herramientas." });
      if (paso.llamadas.length > maxTools || canonico(paso.llamadas).length > 200_000 || paso.texto.length > 100_000) {
        const limitado = { ...actualizado, history: [...flow.history, { role: "assistant" as const, content: "", toolCalls: paso.llamadas }] };
        return guardar({ ...cancelarPedidos(limitado, paso.llamadas, "Solicitud cancelada: la salida del modelo excedió el límite permitido."), stop: "La salida del modelo excedió el límite permitido." });
      }
      const calls = structuredClone(paso.llamadas);
      const siguienteHistory: MensajePaso[] = [...flow.history, { role: "assistant", content: paso.texto, ...(calls.length ? { toolCalls: calls } : {}) }];
      return guardar({ ...actualizado, history: siguienteHistory, queue: calls, reply: "", last: null });
    })
    .addNode("herramienta", async ({ flow }) => {
      if (flow.toolCalls.length >= maxTools || Date.now() >= deadline) return guardar({ ...cancelarPedidos(flow, flow.queue, "Solicitud cancelada: tope de herramientas o tiempo."), stop: "Alcancé el tope de herramientas o tiempo." });
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
      if (pedido.name === "contratos_validar" && respuesta.ok && typeof a.mensaje_id === "string" && Array.isArray(d.requiere_revision) && d.requiere_revision.length > 0 && (d.clasificacion === "nuevo" || d.clasificacion === "actualizacion" || d.clasificacion === "duplicado")) {
        const sonda: Pedido = { id: `sonda-${randomUUID()}`, name: "contratos_registrar", args: { mensaje_id: a.mensaje_id }, sonda: true };
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
      return guardar({ ...await ejecutar(conPedido, pedido, true), review: null, decision: null });
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
  const reinicio: Flujo = { history, queue: anterior?.queue ?? [], review: anterior?.review ?? null, decision: null, last: null, toolCalls: [], steps: 0, tokens: 0, usageKnown: true, reply: "", stop: "" };
  actual = reinicio;
  o.session.messages.push({ role: "user", text: o.message, ts: new Date().toISOString() });
  let fallo: unknown;
  try {
    let input: Parameters<typeof graph.invoke>[0];
    if (reinicio.review && previo.next.includes("pausa")) {
      const decision = decisionHumana(reinicio.review, o.message);
      if (!decision) return finalizar({ ...reinicio, reply: "La respuesta no coincide con una decisión completa. Usa el botón Aprobar o Rechazar, o envía únicamente la confirmación indicada." });
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
    const baseReply = f.toolCalls.length ? resumenDeterminista(f) : f.stop || !f.reply ? resumenDeterminista(f) : f.reply;
    const reply = pending ? `${f.toolCalls.length || f.reply ? `${baseReply}\n` : ""}${pending.pregunta}` : baseReply;
    o.session.messages.push({ role: "assistant", text: reply, toolCalls: structuredClone(f.toolCalls), ts: new Date().toISOString() });
    return { reply, toolCalls: f.toolCalls, needsConfirmation: pending, usage: { steps: f.steps, tokens: f.tokens, known: f.usageKnown } };
  }
}
