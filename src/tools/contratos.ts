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

function registrarSync(
  args: unknown,
  ctx: ToolContext,
): { respuesta: string; resumen: string; ok: boolean; mid?: string } {
  const p = registrar.args.parse(args);
  const hoy = p.hoy ?? process.env.HOY ?? HOY_DEFECTO;
  if (!esFechaIso(hoy)) return { respuesta: fail("hoy inválido"), resumen: "hoy inválido", ok: false };
  if (p.contrato && Object.keys(p.contrato).length > 0) {
    // Anti-bypass del gate HITL: el override solo es válido con confirmación y solo sobre campos
    // que el servidor (no el modelo) marca en revisión para ese mensaje.
    if (p.confirmado !== true) {
      return { respuesta: fail("override `contrato` rechazado: requiere confirmado:true tras confirmación de la persona"), resumen: "override sin confirmar", ok: false };
    }
    const base = analizar(ctx.directory, p.mensaje_id);
    const permitidos = new Set(base.val.requiere_revision);
    const fuera = Object.keys(p.contrato).filter((k) => !permitidos.has(k));
    if (fuera.length > 0) {
      return {
        respuesta: fail(`override rechazado: campos fuera de revisión (${fuera.join(", ")}); permitidos: ${[...permitidos].join(", ") || "ninguno"}`),
        resumen: `override fuera de revisión: ${fuera.join(", ")}`, ok: false,
      };
    }
  }
  const { ext, val, maestro, adjunto } = analizar(ctx.directory, p.mensaje_id, p.contrato);
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
  if (val.requiere_revision.length > 0 && p.confirmado !== true) {
    const revision = val.requiere_revision.map((campo) => ({
      campo,
      valor_propuesto: (c as Record<string, unknown>)[campo] ?? null,
      confianza: c.confianza[campo] ?? 0,
      motivo: ext.motivos[campo] ?? "Requiere revisión",
    }));
    return {
      respuesta: fail(`requiere revisión: ${val.requiere_revision.join(", ")}`, { revision }),
      resumen: `requiere revisión: ${val.requiere_revision.join(", ")}`, ok: false,
    };
  }
  // Validación mínima antes de escribir
  if (!/^[A-Z]{2}-\d{4}-\d{1,3}$/.test(c.id_contrato) || !c.cliente || !esFechaIso(c.fecha_inicio) || !esFechaIso(c.fecha_fin)) {
    return { respuesta: fail("datos incompletos: id_contrato, cliente y fechas son obligatorios"), resumen: "datos incompletos", ok: false };
  }
  const origen = adjunto ? rutaAdjunto(ctx.directory, p.mensaje_id, adjunto) : null;
  const { sharepoint } = dirs(ctx.directory);
  const idx = val.id_contrato_existente ? maestro.findIndex((f) => f.id_contrato === val.id_contrato_existente) : -1;
  let ruta = "";
  let accion: string;

  if (val.clasificacion === "actualizacion" && idx >= 0) {
    const previa = maestro[idx] as FilaMaestro;
    ruta = previa.ruta_sharepoint;
    if (origen) {
      const carpeta = ruta.includes("/") ? dirname(ruta) : `Contratos/${previa.fecha_inicio.slice(0, 4)}/${slugCliente(previa.cliente)}`;
      if (ext.tipo === "otrosi") {
        let n = 1;
        while (existsSync(`${sharepoint}/${carpeta}/${previa.id_contrato}-otrosi-${n}${extDe(adjunto ?? "")}`)) n++;
        archivarAdjunto(ctx.directory, origen, carpeta, `${previa.id_contrato}-otrosi-${n}`, extDe(adjunto ?? ""));
        ruta = previa.ruta_sharepoint || `${carpeta}/${previa.id_contrato}-otrosi-${n}${extDe(adjunto ?? "")}`;
      } else {
        archivarAdjunto(ctx.directory, origen, carpeta, previa.id_contrato, extDe(adjunto ?? ""));
      }
    }
    maestro[idx] = {
      ...previa,
      cliente: c.cliente || previa.cliente,
      nit_cliente: c.nit_cliente, pais: c.pais, objeto: ext.tipo === "otrosi" ? previa.objeto : c.objeto,
      valor: String(c.valor), moneda: c.moneda, fecha_inicio: c.fecha_inicio, fecha_fin: c.fecha_fin,
      requiere_poliza: String(c.requiere_poliza), tipo_poliza: c.tipo_poliza, estado_poliza: c.estado_poliza,
      comercial: c.comercial || previa.comercial, ruta_sharepoint: ruta,
    };
    accion = "actualizacion";
    agregarHistorial(ctx.directory, {
      id_contrato: c.id_contrato, accion, cambios: val.diferencias ?? {}, mensaje_id: p.mensaje_id,
    });
  } else {
    if (maestro.some((f) => f.id_contrato === c.id_contrato)) {
      return { respuesta: fail(`ya existe ${c.id_contrato} con otro NIT/objeto; revisión manual`), resumen: "conflicto de id", ok: false };
    }
    const carpeta = `Contratos/${c.fecha_inicio.slice(0, 4)}/${slugCliente(c.cliente)}`;
    const relativa = origen
      ? archivarAdjunto(ctx.directory, origen, carpeta, c.id_contrato, extDe(adjunto ?? ""))
      : `${carpeta}/${c.id_contrato}`;
    ruta = relativa;
    maestro.push({
      id_contrato: c.id_contrato, cliente: c.cliente, nit_cliente: c.nit_cliente, pais: c.pais, objeto: c.objeto,
      valor: String(c.valor), moneda: c.moneda, fecha_inicio: c.fecha_inicio, fecha_fin: c.fecha_fin,
      requiere_poliza: String(c.requiere_poliza), tipo_poliza: c.tipo_poliza, estado_poliza: c.estado_poliza,
      comercial: c.comercial, ruta_sharepoint: ruta, fecha_registro: hoy, fuente: "buzon",
    });
    accion = "nuevo";
    agregarHistorial(ctx.directory, { id_contrato: c.id_contrato, accion, cambios: {}, mensaje_id: p.mensaje_id });
  }
  escribirMaestro(ctx.directory, maestro);
  marcarProcesado(ctx.directory, p.mensaje_id);
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

