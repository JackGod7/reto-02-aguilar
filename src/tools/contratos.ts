import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { calcularAlertas, renderAlertasMd } from "../domain/alertas.ts";
import { aplicarOverride, idContratoSchema, overrideSchema } from "../domain/contrato.ts";
import type { FilaMaestro } from "../domain/contrato.ts";
import { extraerContrato } from "../domain/extraccion.ts";
import type { Extraccion } from "../domain/extraccion.ts";
import { esFechaIso } from "../domain/fechas.ts";
import { clasificar } from "../domain/reglas.ts";
import type { Validacion } from "../domain/reglas.ts";
import { slugCliente } from "../domain/slug.ts";
import { archivarAdjunto, extDe } from "../infra/archivo.ts";
import { leerComerciales, leerMensaje, listarIds, rutaAdjunto } from "../infra/buzon.ts";
import { escribirMaestro, leerMaestro } from "../infra/maestro.ts";
import { agregarHistorial, escribirLog, escribirTextoOut, leerProcesados, marcarProcesado } from "../infra/registros.ts";
import { dirs } from "../infra/rutas.ts";

// Contrato de tool: execute nunca lanza; devuelve string JSON {ok:true,data} | {ok:false,error}.

export interface ToolContext {
  directory: string;
  sessionId: string;
}

/** `args` es un objeto plano de esquemas zod (cada campo con .describe()); el esquema estricto se construye con `esquema(args)`. */
export interface ToolDef<A extends z.ZodRawShape> {
  description: string;
  args: A;
  execute(args: z.infer<z.ZodObject<A>>, ctx: ToolContext): Promise<string>;
}

export const esquema = <A extends z.ZodRawShape>(args: A) => z.object(args).strict();

const HOY_DEFECTO = "2026-09-03";
const ok = (data: unknown): string => JSON.stringify({ ok: true, data });
const fail = (error: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ok: false, error, ...extra });

function msgError(e: unknown): string {
  return e instanceof z.ZodError
    ? "argumentos inválidos: " + e.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
    : e instanceof Error ? e.message : "error desconocido";
}

interface Analisis {
  ext: Extraccion;
  val: Validacion;
  maestro: FilaMaestro[];
  adjunto: string | null;
}

function analizar(directory: string, mensajeId: string, override?: Record<string, unknown>): Analisis {
  const msg = leerMensaje(directory, mensajeId);
  const maestro = leerMaestro(directory);
  if (msg.texto === null) {
    const ext: Extraccion = { tiene_contrato: false, tipo: null, motivo: "El mensaje no tiene adjunto", requiere_revision: [], motivos: {} };
    return { ext, val: clasificar(ext, maestro), maestro, adjunto: null };
  }
  let ext = extraerContrato(msg.texto, msg.correo, leerComerciales(directory), maestro);
  if (ext.error) throw new Error(ext.error);
  if (override && ext.contrato) {
    const o = overrideSchema.parse(override);
    ext = { ...ext, contrato: aplicarOverride(ext.contrato, o) };
  }
  return { ext, val: clasificar(ext, maestro), maestro, adjunto: msg.adjuntoNombre };
}

async function envolver(
  herramienta: string,
  ctx: ToolContext,
  mensajeId: string | null,
  fn: () => { respuesta: string; resumen: string; ok: boolean; mid?: string },
): Promise<string> {
  try {
    const r = fn();
    escribirLog(ctx.directory, { herramienta, mensaje_id: r.mid ?? mensajeId, ok: r.ok, resumen: r.resumen });
    return r.respuesta;
  } catch (e) {
    const m = msgError(e);
    try {
      escribirLog(ctx.directory, { herramienta, mensaje_id: mensajeId, ok: false, resumen: `error: ${m.slice(0, 120)}` });
    } catch {
      // el log no debe romper el contrato "execute nunca lanza"
    }
    return fail(m);
  }
}

const mensajeId = z
  .string()
  .regex(/^msg-\d{3}$/)
  .describe("Id del mensaje del buzón, formato msg-NNN");

const hoyArg = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Fecha de referencia YYYY-MM-DD");
const overrideArg = z
  .record(z.string(), z.unknown())
  .optional()
  .describe("Corrección opcional, solo de campos que estén en revisión y solo junto con confirmado:true (el servidor lo verifica)");

const ARGS_LEER_BUZON = {};
export const leer_buzon: ToolDef<typeof ARGS_LEER_BUZON> = {
  description: "Lista los mensajes del buzón pendientes de procesar (excluye los ya procesados).",
  args: ARGS_LEER_BUZON,
  async execute(args, ctx) {
    return envolver("leer_buzon", ctx, null, () => {
      esquema(ARGS_LEER_BUZON).parse(args);
      const procesados = new Set(leerProcesados(ctx.directory));
      const mensajes = listarIds(ctx.directory)
        .filter((id) => !procesados.has(id))
        .map((id) => {
          const m = leerMensaje(ctx.directory, id);
          const primera = m.texto?.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
          return {
            id, de: m.correo.de, asunto: m.correo.asunto, fecha: m.correo.fecha,
            adjuntos: m.correo.adjuntos, tiene_contrato: /^(CONTRATO\b|OTROS[ÍI])/i.test(primera),
          };
        });
      return { respuesta: ok({ mensajes }), resumen: `${mensajes.length} mensajes pendientes`, ok: true };
    });
  },
};

const ARGS_EXTRAER = { mensaje_id: mensajeId };
export const extraer: ToolDef<typeof ARGS_EXTRAER> = {
  description: "Extrae los datos de contrato de un mensaje, con confianza por campo.",
  args: ARGS_EXTRAER,
  async execute(args, ctx) {
    return envolver("extraer", ctx, null, () => {
      const p = esquema(ARGS_EXTRAER).parse(args);
      const { ext } = analizar(ctx.directory, p.mensaje_id);
      if (!ext.tiene_contrato || !ext.contrato) {
        return { respuesta: ok({ tiene_contrato: false, motivo: ext.motivo ?? ext.rechazo }), resumen: "sin contrato", ok: true, mid: p.mensaje_id };
      }
      const campos = Object.fromEntries(Object.entries(ext.contrato).map(([campo, valor]) => [campo, ext.contrato!.confianza[campo] === 0 ? null : valor]));
      const data = { tiene_contrato: true, tipo_documento: ext.tipo, ...campos, requiere_revision: ext.requiere_revision, motivos: ext.motivos, rechazo: ext.rechazo };
      return { respuesta: ok(data), resumen: `extraído ${ext.contrato.id_contrato} (${ext.tipo})`, ok: true, mid: p.mensaje_id };
    });
  },
};

const ARGS_VALIDAR = {
  mensaje_id: mensajeId,
  contrato: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Propuesta opcional de valores; solo informativa: no cambia la clasificación ni los campos en revisión, que el servidor calcula de su propia extracción"),
};
export const validar: ToolDef<typeof ARGS_VALIDAR> = {
  description: "Clasifica el mensaje (nuevo, actualizacion, duplicado, rechazado) y lista campos a revisar, sin escribir nada; un contrato propuesto solo se compara de forma informativa.",
  args: ARGS_VALIDAR,
  async execute(args, ctx) {
    return envolver("validar", ctx, null, () => {
      const p = esquema(ARGS_VALIDAR).parse(args);
      const { ext, val } = analizar(ctx.directory, p.mensaje_id);
      if (!p.contrato) return { respuesta: ok(val), resumen: `clasificación=${val.clasificacion}`, ok: true, mid: p.mensaje_id };
      // Informativo: nada de esto altera `val` (calculado solo con la extracción del servidor) ni habilita registrar.
      const base = (ext.contrato ?? {}) as Record<string, unknown>;
      const diferencias_propuesta = Object.fromEntries(
        Object.entries(p.contrato)
          .filter(([k, v]) => JSON.stringify(base[k] ?? null) !== JSON.stringify(v ?? null))
          .map(([k, v]) => [k, { servidor: base[k] ?? null, propuesto: v }]),
      );
      const campos_fuera_de_revision = Object.keys(p.contrato).filter((k) => !val.requiere_revision.includes(k));
      return {
        respuesta: ok({ ...val, diferencias_propuesta, campos_fuera_de_revision }),
        resumen: `clasificación=${val.clasificacion}`,
        ok: true,
        mid: p.mensaje_id,
      };
    });
  },
};

const ARGS_REGISTRAR = {
  mensaje_id: mensajeId,
  contrato: overrideArg,
  confirmado: z.boolean().optional().describe("true solo tras confirmación explícita del usuario"),
  hoy: hoyArg.optional().describe("Fecha de registro YYYY-MM-DD; por defecto la fecha de referencia"),
};
export const registrar: ToolDef<typeof ARGS_REGISTRAR> = {
  description: "Registra el contrato del mensaje en el maestro y archiva su adjunto, o devuelve los campos en revisión si falta la confirmación explícita de la persona (confirmado:true).",
  args: ARGS_REGISTRAR,
  async execute(args, ctx) {
    const mid = typeof (args as { mensaje_id?: unknown } | null)?.mensaje_id === "string" ? (args as { mensaje_id: string }).mensaje_id : null;
    return envolver("registrar", ctx, mid, () => registrarSync(args, ctx));
  },
};

type Resultado = { respuesta: string; resumen: string; ok: boolean; mid?: string };
type Contrato = NonNullable<Extraccion["contrato"]>;

const rechazo = (error: string, resumen: string, extra: Record<string, unknown> = {}): Resultado => ({
  respuesta: fail(error, extra), resumen, ok: false,
});

/**
 * Anti-bypass del gate HITL: el override solo es válido con confirmación y solo sobre campos
 * que el servidor (no el modelo) marca en revisión para ese mensaje.
 */
function validarOverride(p: z.infer<z.ZodObject<typeof ARGS_REGISTRAR>>, ctx: ToolContext): Resultado | null {
  if (!p.contrato || Object.keys(p.contrato).length === 0) return null;
  if (p.confirmado !== true) {
    return rechazo("override `contrato` rechazado: requiere confirmado:true tras confirmación de la persona", "override sin confirmar");
  }
  const permitidos = new Set(analizar(ctx.directory, p.mensaje_id).val.requiere_revision);
  const fuera = Object.keys(p.contrato).filter((k) => !permitidos.has(k));
  if (fuera.length === 0) return null;
  return rechazo(
    `override rechazado: campos fuera de revisión (${fuera.join(", ")}); permitidos: ${[...permitidos].join(", ") || "ninguno"}`,
    `override fuera de revisión: ${fuera.join(", ")}`,
  );
}

function resultadoRevision(a: Analisis, c: Contrato): Resultado {
  const campos = a.val.requiere_revision;
  const revision = campos.map((campo) => ({
    campo,
    valor_propuesto: a.val.valores_revision?.[campo] ?? (c.confianza[campo] === 0 ? null : (c as Record<string, unknown>)[campo] ?? null),
    confianza: c.confianza[campo] ?? 0,
    motivo: a.val.motivos_revision?.[campo] ?? a.ext.motivos[campo] ?? "Requiere revisión",
  }));
  return rechazo(`requiere revisión: ${campos.join(", ")}`, `requiere revisión: ${campos.join(", ")}`, { revision });
}

const datosCompletos = (c: Contrato): boolean =>
  idContratoSchema.safeParse(c.id_contrato).success && Boolean(c.cliente) && esFechaIso(c.fecha_inicio) && esFechaIso(c.fecha_fin);

/** Archiva el adjunto de una actualización; un otrosí conserva su propio archivo numerado. Devuelve la ruta del maestro. */
function archivarActualizacion(ctx: ToolContext, a: Analisis, previa: FilaMaestro, origen: string | null): string {
  if (!origen) return previa.ruta_sharepoint;
  const ext = extDe(a.adjunto ?? "");
  const carpeta = previa.ruta_sharepoint.includes("/")
    ? dirname(previa.ruta_sharepoint)
    : `Contratos/${previa.fecha_inicio.slice(0, 4)}/${slugCliente(previa.cliente)}`;
  if (a.ext.tipo !== "otrosi") {
    archivarAdjunto(ctx.directory, origen, carpeta, previa.id_contrato, ext);
    return previa.ruta_sharepoint;
  }
  const { sharepoint } = dirs(ctx.directory);
  let n = 1;
  while (existsSync(`${sharepoint}/${carpeta}/${previa.id_contrato}-otrosi-${n}${ext}`)) n++;
  archivarAdjunto(ctx.directory, origen, carpeta, `${previa.id_contrato}-otrosi-${n}`, ext);
  return previa.ruta_sharepoint || `${carpeta}/${previa.id_contrato}-otrosi-${n}${ext}`;
}

function registrarActualizacion(ctx: ToolContext, a: Analisis, idx: number, mensajeId: string, origen: string | null): string {
  const previa = a.maestro[idx] as FilaMaestro;
  const ruta = archivarActualizacion(ctx, a, previa, origen);
  const siguiente = { ...previa, ruta_sharepoint: ruta };
  for (const [campo, cambio] of Object.entries(a.val.diferencias ?? {})) {
    if (campo in previa && campo !== "id_contrato") siguiente[campo as keyof FilaMaestro] = String(cambio.despues);
  }
  a.maestro[idx] = siguiente;
  agregarHistorial(ctx.directory, { id_contrato: previa.id_contrato, accion: "actualizacion", cambios: a.val.diferencias ?? {}, mensaje_id: mensajeId });
  return ruta;
}

/** Devuelve la ruta archivada, o null si el id ya existe en el maestro con otro NIT/objeto (revisión manual). */
function registrarNuevo(ctx: ToolContext, a: Analisis, c: Contrato, mensajeId: string, hoy: string, origen: string | null): string | null {
  if (a.maestro.some((f) => f.id_contrato === c.id_contrato)) return null;
  const carpeta = `Contratos/${c.fecha_inicio.slice(0, 4)}/${slugCliente(c.cliente)}`;
  const ruta = origen
    ? archivarAdjunto(ctx.directory, origen, carpeta, c.id_contrato, extDe(a.adjunto ?? ""))
    : `${carpeta}/${c.id_contrato}`;
  a.maestro.push({
    id_contrato: c.id_contrato, cliente: c.cliente, nit_cliente: c.nit_cliente, pais: c.pais, objeto: c.objeto,
    valor: String(c.valor), moneda: c.moneda, fecha_inicio: c.fecha_inicio, fecha_fin: c.fecha_fin,
    requiere_poliza: String(c.requiere_poliza), tipo_poliza: c.tipo_poliza, estado_poliza: c.estado_poliza,
    comercial: c.comercial, ruta_sharepoint: ruta, fecha_registro: hoy, fuente: "buzon",
  });
  agregarHistorial(ctx.directory, { id_contrato: c.id_contrato, accion: "nuevo", cambios: {}, mensaje_id: mensajeId });
  return ruta;
}

function registrarSync(args: unknown, ctx: ToolContext): Resultado {
  const p = esquema(ARGS_REGISTRAR).parse(args);
  const hoy = p.hoy ?? process.env.HOY ?? HOY_DEFECTO;
  if (!esFechaIso(hoy)) return rechazo("hoy inválido", "hoy inválido");
  const veto = validarOverride(p, ctx);
  if (veto) return veto;

  const a = analizar(ctx.directory, p.mensaje_id, p.contrato);
  const { ext, val, maestro } = a;
  const c = ext.contrato;
  if (val.clasificacion === "rechazado" || !c) {
    marcarProcesado(ctx.directory, p.mensaje_id);
    return {
      respuesta: ok({ id_contrato: null, accion: "rechazado", ruta_archivo: null, motivo: val.motivo }),
      resumen: "rechazado, sin escritura", ok: true,
    };
  }
  const duplicado = (): Resultado => {
    marcarProcesado(ctx.directory, p.mensaje_id);
    return {
      respuesta: ok({ id_contrato: val.id_contrato_existente ?? c.id_contrato, accion: "duplicado", ruta_archivo: null }),
      resumen: `duplicado ${c.id_contrato}, sin escritura`, ok: true,
    };
  };
  // Como e735094: un duplicado ya coincide con el maestro, así que la incertidumbre de extracción no
  // decide nada (un mensaje ya registrado no vuelve a pedir revisión). Solo las decisiones de
  // clasificación (destino, moneda, conflictos: motivos_revision) se muestran antes de descartarlo.
  if (val.clasificacion === "duplicado" && Object.keys(val.motivos_revision ?? {}).length === 0) return duplicado();
  if (val.requiere_revision.length > 0 && (p.confirmado !== true || val.bloqueo_registro)) return resultadoRevision(a, c);
  if (val.clasificacion === "duplicado" || (val.clasificacion === "actualizacion" && Object.keys(val.diferencias ?? {}).length === 0)) return duplicado();
  const ausentes = val.requiere_revision.filter((campo) => c.confianza[campo] === 0 && p.contrato?.[campo] === undefined);
  if (ausentes.length > 0) return rechazo(`datos incompletos: corrige los campos ausentes (${ausentes.join(", ")})`, "campos ausentes sin corregir");
  if (!datosCompletos(c)) return rechazo("datos incompletos: id_contrato, cliente y fechas son obligatorios", "datos incompletos");

  const origen = a.adjunto ? rutaAdjunto(ctx.directory, p.mensaje_id, a.adjunto) : null;
  const idx = val.id_contrato_existente ? maestro.findIndex((f) => f.id_contrato === val.id_contrato_existente) : -1;
  const esActualizacion = val.clasificacion === "actualizacion" && idx >= 0;
  const ruta = esActualizacion
    ? registrarActualizacion(ctx, a, idx, p.mensaje_id, origen)
    : registrarNuevo(ctx, a, c, p.mensaje_id, hoy, origen);
  if (ruta === null) return rechazo(`ya existe ${c.id_contrato} con otro NIT/objeto; revisión manual`, "conflicto de id");

  escribirMaestro(ctx.directory, maestro);
  marcarProcesado(ctx.directory, p.mensaje_id);
  const accion = esActualizacion ? "actualizacion" : "nuevo";
  return {
    respuesta: ok({ id_contrato: val.id_contrato_existente ?? c.id_contrato, accion, ruta_archivo: `out/sharepoint/${ruta}` }),
    resumen: `${accion} ${c.id_contrato}`, ok: true,
  };
}

const ARGS_ALERTAS = { hoy: hoyArg };
export const alertas: ToolDef<typeof ARGS_ALERTAS> = {
  description: "Genera out/alertas.md con vencimientos, pólizas pendientes y registros recientes a la fecha dada.",
  args: ARGS_ALERTAS,
  async execute(args, ctx) {
    return envolver("alertas", ctx, null, () => {
      const p = esquema(ARGS_ALERTAS).parse(args);
      if (!esFechaIso(p.hoy)) return { respuesta: fail("hoy inválido"), resumen: "hoy inválido", ok: false };
      const a = calcularAlertas(leerMaestro(ctx.directory), p.hoy);
      const ruta = escribirTextoOut(ctx.directory, "alertas.md", renderAlertasMd(a, p.hoy));
      return {
        respuesta: ok({ ruta, ...a }),
        resumen: `vencen=${a.vencen.length} vencidos=${a.vencidos.length} polizas=${a.polizas_pendientes.length} recientes=${a.registrados_desde_corte.length}`,
        ok: true,
      };
    });
  },
};

