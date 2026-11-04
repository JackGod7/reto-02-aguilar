import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { calcularAlertas, renderAlertasMd } from "../domain/alertas.ts";
import { aplicarOverride, overrideSchema } from "../domain/contrato.ts";
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

export interface ToolDef<A extends z.ZodType> {
  description: string;
  args: A;
  execute(args: z.infer<A>, ctx: ToolContext): Promise<string>;
}

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
    escribirLog(ctx.directory, { herramienta, mensaje_id: mensajeId, ok: false, resumen: `error: ${m.slice(0, 120)}` });
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

export const leer_buzon: ToolDef<z.ZodObject<{}, z.core.$strict>> = {
  description: "Lista los mensajes del buzón pendientes de procesar (excluye los ya procesados).",
  args: z.object({}).strict(),
  async execute(_args, ctx) {
    return envolver("leer_buzon", ctx, null, () => {
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

export const extraer: ToolDef<z.ZodObject<{ mensaje_id: typeof mensajeId }, z.core.$strict>> = {
  description: "Extrae los datos de contrato de un mensaje, con confianza por campo.",
  args: z.object({ mensaje_id: mensajeId }).strict(),
  async execute(args, ctx) {
    return envolver("extraer", ctx, null, () => {
      const p = extraer.args.parse(args);
      const { ext } = analizar(ctx.directory, p.mensaje_id);
      if (!ext.tiene_contrato || !ext.contrato) {
        return { respuesta: ok({ tiene_contrato: false, motivo: ext.motivo ?? ext.rechazo }), resumen: "sin contrato", ok: true, mid: p.mensaje_id };
      }
      const data = { tiene_contrato: true, tipo_documento: ext.tipo, ...ext.contrato, requiere_revision: ext.requiere_revision, motivos: ext.motivos, rechazo: ext.rechazo };
      return { respuesta: ok(data), resumen: `extraído ${ext.contrato.id_contrato} (${ext.tipo})`, ok: true, mid: p.mensaje_id };
    });
  },
};

export const validar: ToolDef<z.ZodObject<{ mensaje_id: typeof mensajeId }, z.core.$strict>> = {
  description: "Clasifica el mensaje (nuevo, actualizacion, duplicado, rechazado) y lista campos a revisar.",
  args: z.object({ mensaje_id: mensajeId }).strict(),
  async execute(args, ctx) {
    return envolver("validar", ctx, null, () => {
      const p = validar.args.parse(args);
      const { val } = analizar(ctx.directory, p.mensaje_id);
      return { respuesta: ok(val), resumen: `clasificación=${val.clasificacion}`, ok: true, mid: p.mensaje_id };
    });
  },
};

export const registrar: ToolDef<
  z.ZodObject<
    {
      mensaje_id: typeof mensajeId;
      contrato: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      confirmado: z.ZodOptional<z.ZodBoolean>;
      hoy: z.ZodOptional<z.ZodString>;
    },
    z.core.$strict
  >
> = {
  description: "Registra el contrato en el maestro. Requiere confirmado:true si hay campos a revisar.",
  args: z
    .object({
      mensaje_id: mensajeId,
      contrato: overrideArg,
      confirmado: z.boolean().optional().describe("true solo tras confirmación explícita del usuario"),
      hoy: hoyArg.optional().describe("Fecha de registro YYYY-MM-DD; por defecto la fecha de referencia"),
    })
    .strict(),
  async execute(args, ctx) {
    const mid = typeof (args as { mensaje_id?: unknown }).mensaje_id === "string" ? (args as { mensaje_id: string }).mensaje_id : null;
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
function validarOverride(p: z.infer<typeof registrar.args>, ctx: ToolContext): Resultado | null {
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
    valor_propuesto: (c as Record<string, unknown>)[campo] ?? null,
    confianza: c.confianza[campo] ?? 0,
    motivo: a.ext.motivos[campo] ?? "Requiere revisión",
  }));
  return rechazo(`requiere revisión: ${campos.join(", ")}`, `requiere revisión: ${campos.join(", ")}`, { revision });
}

const datosCompletos = (c: Contrato): boolean =>
  /^[A-Z]{2}-\d{4}-\d{1,3}$/.test(c.id_contrato) && Boolean(c.cliente) && esFechaIso(c.fecha_inicio) && esFechaIso(c.fecha_fin);

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

function registrarActualizacion(ctx: ToolContext, a: Analisis, c: Contrato, idx: number, mensajeId: string, origen: string | null): string {
  const previa = a.maestro[idx] as FilaMaestro;
  const ruta = archivarActualizacion(ctx, a, previa, origen);
  a.maestro[idx] = {
    ...previa,
    cliente: c.cliente || previa.cliente,
    nit_cliente: c.nit_cliente, pais: c.pais, objeto: a.ext.tipo === "otrosi" ? previa.objeto : c.objeto,
    valor: String(c.valor), moneda: c.moneda, fecha_inicio: c.fecha_inicio, fecha_fin: c.fecha_fin,
    requiere_poliza: String(c.requiere_poliza), tipo_poliza: c.tipo_poliza, estado_poliza: c.estado_poliza,
    comercial: c.comercial || previa.comercial, ruta_sharepoint: ruta,
  };
  agregarHistorial(ctx.directory, { id_contrato: c.id_contrato, accion: "actualizacion", cambios: a.val.diferencias ?? {}, mensaje_id: mensajeId });
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
  const p = registrar.args.parse(args);
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
  if (val.clasificacion === "duplicado") {
    marcarProcesado(ctx.directory, p.mensaje_id);
    return {
      respuesta: ok({ id_contrato: c.id_contrato, accion: "duplicado", ruta_archivo: null }),
      resumen: `duplicado ${c.id_contrato}, sin escritura`, ok: true,
    };
  }
  if (val.requiere_revision.length > 0 && p.confirmado !== true) return resultadoRevision(a, c);
  if (!datosCompletos(c)) return rechazo("datos incompletos: id_contrato, cliente y fechas son obligatorios", "datos incompletos");

  const origen = a.adjunto ? rutaAdjunto(ctx.directory, p.mensaje_id, a.adjunto) : null;
  const idx = val.id_contrato_existente ? maestro.findIndex((f) => f.id_contrato === val.id_contrato_existente) : -1;
  const esActualizacion = val.clasificacion === "actualizacion" && idx >= 0;
  const ruta = esActualizacion
    ? registrarActualizacion(ctx, a, c, idx, p.mensaje_id, origen)
    : registrarNuevo(ctx, a, c, p.mensaje_id, hoy, origen);
  if (ruta === null) return rechazo(`ya existe ${c.id_contrato} con otro NIT/objeto; revisión manual`, "conflicto de id");

  escribirMaestro(ctx.directory, maestro);
  marcarProcesado(ctx.directory, p.mensaje_id);
  const accion = esActualizacion ? "actualizacion" : "nuevo";
  return {
    respuesta: ok({ id_contrato: c.id_contrato, accion, ruta_archivo: `out/sharepoint/${ruta}` }),
    resumen: `${accion} ${c.id_contrato}`, ok: true,
  };
}

export const alertas: ToolDef<z.ZodObject<{ hoy: z.ZodString }, z.core.$strict>> = {
  description: "Genera out/alertas.md: vencimientos, pólizas pendientes y registros recientes.",
  args: z.object({ hoy: hoyArg }).strict(),
  async execute(args, ctx) {
    return envolver("alertas", ctx, null, () => {
      const p = alertas.args.parse(args);
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

