import { z } from "zod";

export const COLUMNAS = [
  "id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda",
  "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza", "estado_poliza",
  "comercial", "ruta_sharepoint", "fecha_registro", "fuente",
] as const;

export type FilaMaestro = Record<(typeof COLUMNAS)[number], string>;

export const contratoSchema = z.object({
  id_contrato: z.string(),
  cliente: z.string(),
  nit_cliente: z.string(),
  pais: z.enum(["CO", "EC", "PE", "PA", "HN"]).or(z.literal("")),
  objeto: z.string().max(200),
  valor: z.number(),
  valor_indeterminado: z.boolean(),
  moneda: z.enum(["COP", "USD", "PEN", "PAB", "HNL"]),
  fecha_inicio: z.string(),
  fecha_fin: z.string(),
  requiere_poliza: z.boolean(),
  tipo_poliza: z.string(),
  estado_poliza: z.enum(["vigente", "pendiente", "vencida", "no_aplica"]),
  comercial: z.string(),
  confianza: z.record(z.string(), z.number().min(0).max(1)),
  advertencias: z.array(z.string()),
});
export type Contrato = z.infer<typeof contratoSchema>;

// Overrides permitidos (solo campos de dato; nunca la confianza).
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const idContratoSchema = z.string().regex(/^(?:[A-Z]{2}-\d{4}-\d{1,3}|AUTO-\d{4}-\d{3,})$/);
export const overrideSchema = z
  .object({
    id_contrato: idContratoSchema,
    cliente: z.string().max(200),
    nit_cliente: z.string().regex(/^\d{5,20}$/),
    pais: z.enum(["CO", "EC", "PE", "PA", "HN"]),
    objeto: z.string().max(200),
    valor: z.number().nonnegative(),
    moneda: z.enum(["COP", "USD", "PEN", "PAB", "HNL"]),
    fecha_inicio: fecha,
    fecha_fin: fecha,
    requiere_poliza: z.boolean(),
    tipo_poliza: z.string().max(100),
    estado_poliza: z.enum(["vigente", "pendiente", "vencida", "no_aplica"]),
    comercial: z.string().max(100),
  })
  .partial()
  .strict();
export type Override = z.infer<typeof overrideSchema>;

export const CAMPOS_REVISION = [
  "id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin",
] as const;
export const UMBRAL = 0.8;

export function filaAContrato(f: FilaMaestro): Contrato {
  const confianza: Record<string, number> = {};
  for (const c of COLUMNAS) confianza[c] = 1;
  return {
    id_contrato: f.id_contrato,
    cliente: f.cliente,
    nit_cliente: f.nit_cliente,
    pais: f.pais as Contrato["pais"],
    objeto: f.objeto,
    valor: Number(f.valor),
    valor_indeterminado: false,
    moneda: f.moneda as Contrato["moneda"],
    fecha_inicio: f.fecha_inicio,
    fecha_fin: f.fecha_fin,
    requiere_poliza: f.requiere_poliza === "true",
    tipo_poliza: f.tipo_poliza,
    estado_poliza: f.estado_poliza as Contrato["estado_poliza"],
    comercial: f.comercial,
    confianza,
    advertencias: [],
  };
}

export function revisionPorConfianza(c: Contrato): string[] {
  return CAMPOS_REVISION.filter((k) => (c.confianza[k] ?? 0) < UMBRAL);
}

export function aplicarOverride(c: Contrato, o: Override): Contrato {
  return { ...c, ...o };
}
