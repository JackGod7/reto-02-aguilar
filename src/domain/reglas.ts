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
  motivos_revision?: Record<string, string>;
  valores_revision?: Record<string, string>;
  bloqueo_registro?: string;
}

const CLAVES = ["valor", "fecha_inicio", "fecha_fin"] as const;
const COMPARADOS = ["cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza", "estado_poliza", "comercial"] as const;

function normalizar(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

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
  for (const k of COMPARADOS) {
    // Un contrato completo propone pendiente por defecto: no acredita un cambio
    // de estado. El otrosí hereda el maestro y solo cambia la póliza por cláusula.
    if (!otrosi && (k === "estado_poliza" || ((k === "requiere_poliza" || k === "tipo_poliza") && !c.requiere_poliza))) continue;
    if ((otrosi && (k === "objeto" || k === "comercial")) || (k === "comercial" && !c.comercial)) continue;
    const antes = f[k];
    const despues = c[k];
    const iguales = k === "valor" ? Number(antes) === despues : String(antes) === String(despues);
    if (!iguales) {
      d[k] = { antes: k === "valor" ? Number(antes) : antes, despues };
    }
  }
  return d;
}

function conflictosIdentidad(c: Contrato, f: FilaMaestro): string[] {
  const conflictos: string[] = [];
  if (c.nit_cliente && f.nit_cliente && c.nit_cliente !== f.nit_cliente) conflictos.push("nit_cliente");
  if (c.cliente && f.cliente && normalizar(c.cliente) !== normalizar(f.cliente)) conflictos.push("cliente");
  // Los resúmenes del maestro y la cláusula completa no son textos iguales.
  // Exigimos palabras relevantes compartidas; las fórmulas contractuales no
  // bastan para declarar compatibles objetos de negocios diferentes.
  const vacias = new Set(["el", "la", "los", "las", "de", "del", "para", "por", "con", "una", "uno", "un", "en", "al", "se", "su", "sus", "que", "y", "a", "o", "contratista", "contratante", "obliga", "prestara", "prestacion", "ejecutar", "servicio", "servicios", "sistema"]);
  const palabras = (s: string): Set<string> => new Set(normalizar(s).split(" ").map((t) => t === "ti" ? "tecnologia" : t === "niveles" ? "nivel" : t).filter((t) => t.length > 1 && !vacias.has(t)));
  const a = palabras(c.objeto);
  const b = palabras(f.objeto);
  const comunes = [...a].filter((t) => b.has(t)).length;
  if (c.objeto && f.objeto && normalizar(c.objeto) !== normalizar(f.objeto) && (a.size === 0 || b.size === 0 || comunes / Math.min(a.size, b.size) < 0.5)) conflictos.push("objeto");
  return conflictos;
}

export function clasificar(ext: Extraccion, maestro: FilaMaestro[]): Validacion {
  const base = { requiere_revision: [...ext.requiere_revision], advertencias: [...(ext.contrato?.advertencias ?? [])] };
  if (!ext.tiene_contrato || !ext.contrato) {
    return { ...base, clasificacion: "rechazado", requiere_revision: [], motivo: ext.motivo ?? ext.rechazo ?? "Sin contrato" };
  }
  if (ext.rechazo) return { ...base, clasificacion: "rechazado", requiere_revision: [], motivo: ext.rechazo };
  const c = ext.contrato;
  const idGenerado = /^AUTO-\d{4}-\d{3,}$/.test(c.id_contrato) && c.confianza.id_contrato === 0;
  const propuestaId = idGenerado ? { valores_revision: { id_contrato: c.id_contrato }, motivos_revision: { id_contrato: `El documento no identifica su contrato; confirma o corrige el identificador propuesto ${c.id_contrato}` } } : {};
  const porId = maestro.filter((f) => f.id_contrato === c.id_contrato && c.id_contrato !== "");
  if (idGenerado && porId.some((f) => f.nit_cliente !== c.nit_cliente || jaccard(f.objeto, c.objeto) < 0.9)) {
    const motivo = `El identificador generado ${c.id_contrato} ya pertenece a otro contrato; corrige el id antes de registrar`;
    return { ...base, ...propuestaId, clasificacion: "nuevo", requiere_revision: [...new Set([...base.requiere_revision, "id_contrato"])], motivos_revision: { id_contrato: motivo }, bloqueo_registro: motivo };
  }
  const candidatos = porId.length ? porId : maestro.filter((f) => f.nit_cliente === c.nit_cliente && c.nit_cliente !== "" && jaccard(f.objeto, c.objeto) >= 0.9);
  if (!candidatos.length) return { ...base, ...propuestaId, clasificacion: "nuevo" };
  if (candidatos.length > 1) {
    const motivo = `Identidad ambigua: hay ${candidatos.length} filas candidatas (${candidatos.map((f) => f.id_contrato).join(", ")}); corrige la identidad antes de registrar`;
    return { ...base, clasificacion: "actualizacion", requiere_revision: [...new Set([...base.requiere_revision, "id_contrato"])], motivos_revision: { id_contrato: motivo }, bloqueo_registro: motivo };
  }
  const fila = candidatos[0]!;
  const conflictos = conflictosIdentidad(c, fila);
  const otroId = c.id_contrato !== fila.id_contrato;
  const motivos_revision: Record<string, string> = {};
  const valores_revision: Record<string, string> = {};
  for (const campo of conflictos) motivos_revision[campo] = `El ${campo} del documento no es compatible con ${fila.id_contrato} en el maestro; verifica el destino antes de actualizar`;
  if (otroId) {
    motivos_revision.id_contrato = `El documento ${c.id_contrato} coincide por NIT y objeto con ${fila.id_contrato}. La propuesta conserva ${fila.id_contrato} como destino; no crea ni adopta ${c.id_contrato}`;
    valores_revision.id_contrato = fila.id_contrato;
  } else if (idGenerado) {
    motivos_revision.id_contrato = `El documento no trae id y coincide con ${fila.id_contrato}; confirma este destino antes de registrar`;
    valores_revision.id_contrato = fila.id_contrato;
  }
  const monedaDistinta = c.moneda !== fila.moneda;
  if (monedaDistinta) {
    motivos_revision.moneda = `La fuente propone ${c.moneda} y el maestro ${fila.id_contrato} tiene ${fila.moneda}. La decisión propuesta conserva ${fila.moneda}; confirma o corrige explícitamente la moneda`;
    valores_revision.moneda = fila.moneda;
  }
  const requiere_revision = [...new Set([...base.requiere_revision, ...conflictos, ...(otroId ? ["id_contrato"] : []), ...(monedaDistinta ? ["moneda"] : [])])];
  const diferencias = diferenciasContraFila(c, fila, ext.tipo === "otrosi");
  const sinCambioClave = CLAVES.every((k) => k === "valor" ? Number(fila[k]) === c[k] : fila[k] === c[k]);
  // RN1 prevalece ante metadatos distintos de un reenvío. En un otrosí,
  // solo las diferencias efectivas originan una actualización con historial.
  const duplicado = conflictos.length === 0 && (ext.tipo === "otrosi"
    ? Object.keys(diferencias).length === 0
    : sinCambioClave);
  return {
    ...base, clasificacion: duplicado ? "duplicado" : "actualizacion", id_contrato_existente: fila.id_contrato,
    requiere_revision, ...(requiere_revision.length ? { motivos_revision } : {}),
    ...(Object.keys(valores_revision).length ? { valores_revision, advertencias: [...base.advertencias, ...Object.values(motivos_revision)] } : {}),
    ...(!duplicado ? { diferencias } : {}),
  };
}
