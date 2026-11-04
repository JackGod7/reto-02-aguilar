import type { Contrato, FilaMaestro } from "./contrato.ts";
import type { Extraccion } from "./extraccion.ts";

export type Clasificacion = "nuevo" | "actualizacion" | "duplicado" | "rechazado";
export type Diferencias = Record<string, { antes: string | number | boolean; despues: string | number | boolean }>;

export interface Validacion {
  clasificacion: Clasificacion;
  id_contrato_existente?: string;
  requiere_revision: string[];
  diferencias?: Diferencias;
  advertencias: string[];
  motivo?: string;
}

const COMPARADOS = ["valor", "moneda", "fecha_inicio", "fecha_fin", "nit_cliente", "pais", "estado_poliza"] as const;

export function jaccard(a: string, b: string): number {
  const tok = (s: string): Set<string> =>
    new Set(s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter((t) => t.length > 2));
  const A = tok(a);
  const B = tok(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

function diferenciasContraFila(c: Contrato, f: FilaMaestro, otrosi: boolean): Diferencias {
  const d: Diferencias = {};
  const campos = otrosi ? COMPARADOS : (COMPARADOS.filter((k) => k !== "estado_poliza"));
  for (const k of campos) {
    const antes = f[k];
    const despues = c[k];
    if (String(antes) !== String(despues)) {
      d[k] = { antes: k === "valor" ? Number(antes) : antes, despues };
    }
  }
  return d;
}

export function clasificar(ext: Extraccion, maestro: FilaMaestro[]): Validacion {
  const base = { requiere_revision: ext.requiere_revision, advertencias: ext.contrato?.advertencias ?? [] };
  if (!ext.tiene_contrato || !ext.contrato) {
    return { ...base, clasificacion: "rechazado", requiere_revision: [], motivo: ext.motivo ?? ext.rechazo ?? "Sin contrato" };
  }
  if (ext.rechazo) return { ...base, clasificacion: "rechazado", requiere_revision: [], motivo: ext.rechazo };
  const c = ext.contrato;
  const porId = maestro.find((f) => f.id_contrato === c.id_contrato && c.id_contrato !== "");
  if (porId) {
    const diferencias = diferenciasContraFila(c, porId, ext.tipo === "otrosi");
    if (Object.keys(diferencias).length === 0) {
      return { ...base, clasificacion: "duplicado", id_contrato_existente: porId.id_contrato };
    }
    return { ...base, clasificacion: "actualizacion", id_contrato_existente: porId.id_contrato, diferencias };
  }
  const similar = maestro.find((f) => f.nit_cliente === c.nit_cliente && c.nit_cliente !== "" && jaccard(f.objeto, c.objeto) >= 0.9);
  if (similar) {
    return {
      ...base, clasificacion: "actualizacion", id_contrato_existente: similar.id_contrato,
      diferencias: diferenciasContraFila(c, similar, false),
    };
  }
  return { ...base, clasificacion: "nuevo" };
}
