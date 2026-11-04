import type { Contrato, FilaMaestro } from "./contrato.ts";
import { filaAContrato, revisionPorConfianza } from "./contrato.ts";
import { extraerDinero } from "./dinero.ts";
import type { Moneda } from "./dinero.ts";
import { addMonths, esFechaIso, parseFechaEs, todasLasFechasEs } from "./fechas.ts";

const NIT_PERIFERIA = "900123456";

export interface Correo {
  id: string;
  de: string;
  asunto: string;
  fecha: string;
  adjuntos: string[];
}
export interface Comercial { email: string; nombre: string; region?: string }

export interface Extraccion {
  tiene_contrato: boolean;
  tipo: "contrato" | "otrosi" | null;
  motivo?: string;
  rechazo?: string;
  error?: string;
  referencia?: string;
  contrato?: Contrato;
  requiere_revision: string[];
  motivos: Record<string, string>;
}

interface Parte { nombre: string; tipoId: "NIT" | "RUC"; id: string; rol: string; segmento: string }

const PAIS_POR_CIUDAD: Array<[RegExp, Contrato["pais"]]> = [
  [/bogot[aá]|medell[ií]n|barranquilla|cali\b|cartagena|colombia/i, "CO"],
  [/quito|guayaquil|ecuador/i, "EC"],
  [/lima\b|per[uú]\b|arequipa/i, "PE"],
  [/panam[aá]/i, "PA"],
  [/tegucigalpa|san pedro sula|honduras/i, "HN"],
];
const MONEDA_POR_PAIS: Record<string, Moneda> = { CO: "COP", EC: "USD", PE: "PEN", PA: "USD", HN: "USD" };

function tituloEs(nombre: string): string {
  const minusculas = new Set(["de", "del", "la", "los", "las", "y", "e"]);
  return nombre
    .trim()
    .split(/\s+/)
    .map((w, i) => {
      if (/^(S\.A\.S\.|S\.A\.C\.|S\.A\.|S\.|R\.L\.|IT|SAS|SA)$/.test(w)) return w;
      const l = w.toLowerCase();
      if (i > 0 && minusculas.has(l)) return l;
      return l.charAt(0).toUpperCase() + l.slice(1);
    })
    .join(" ")
    .replace(/ S\. De R\.L\./, " S. de R.L.");
}

function parrafos(texto: string): string[] {
  return texto.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function clausula(ps: string[], nombre: string): string | undefined {
  return ps.find((p) => new RegExp(`\\b${nombre}\\.`).test(p));
}

function parsearPartes(p: string): Parte[] {
  const re = /([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9 .&]+?),\s*(?:identificada con\s+)?(NIT|RUC)\s+([\d.\-]+)/g;
  const ms = [...p.matchAll(re)];
  return ms.map((m, i) => {
    const fin = ms[i + 1]?.index ?? p.length;
    const segmento = p.slice((m.index ?? 0) + m[0].length, fin);
    const rol = /CONTRATANTE/.test(segmento) && !/CONTRATISTA/.test(segmento.split("CONTRATANTE")[0] ?? "")
      ? "CONTRATANTE"
      : /CONTRATISTA/.test(segmento) ? "CONTRATISTA" : "";
    return { nombre: (m[1] ?? "").trim(), tipoId: m[2] as "NIT" | "RUC", id: m[3] ?? "", rol, segmento };
  });
}

function limpiarNit(parte: Parte): string {
  if (parte.tipoId === "RUC") return parte.id.replace(/\D/g, "");
  const sinDv = parte.id.replace(/-\d$/, "");
  return sinDv.replace(/\D/g, "");
}

function ymd(isoFecha: string): string {
  return isoFecha.slice(0, 10);
}

function errorDeContenido(texto: string): string | null {
  for (const m of texto.matchAll(/(?:\(\d{1,2}\)|\b\d{1,2})\s+de\s+[a-záéíóú]+\s+de\s+\d{4}|\b\d{4}-\d{2}-\d{2}\b/gi)) {
    const valida = /^\d{4}-/.test(m[0]) ? esFechaIso(m[0]) : parseFechaEs(m[0]) !== null;
    if (!valida) return "Fecha inválida en el contrato";
  }
  // Buscar códigos en la cláusula monetaria evita interpretar identificadores
  // tributarios de las partes como monedas. Incluye importes sin paréntesis.
  const valor = parrafos(texto).filter((p) => /\bVALOR\b/i.test(p)).join("\n");
  for (const m of valor.matchAll(/\b([A-Z]{3})\s*\$?\s*[\d.,]+\b/gi)) {
    const codigo = (m[1] ?? "").toUpperCase();
    if (["NIT", "RUC"].includes(codigo)) continue;
    if (!["COP", "USD", "PEN", "PAB", "HNL"].includes(codigo)) return `Moneda desconocida: ${codigo}`;
  }
  return null;
}

function recortar(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…";
}

export function extraerContrato(
  texto: string,
  correo: Correo,
  comerciales: Comercial[],
  maestro: FilaMaestro[],
): Extraccion {
  const sinContrato = (motivo: string): Extraccion => ({
    tiene_contrato: false, tipo: null, motivo, requiere_revision: [], motivos: {},
  });
  if (!texto.trim()) return { ...sinContrato("Texto vacío"), error: "El adjunto de contrato tiene texto vacío" };
  const primera = texto.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  const tipo = /^CONTRATO\b/.test(primera) ? "contrato" : /^OTROS[ÍI]/i.test(primera) ? "otrosi" : null;
  if (!tipo) {
    return sinContrato(`El documento no es un contrato ni un otrosí (${recortar(primera, 40) || "vacío"})`);
  }
  const error = errorDeContenido(texto);
  if (error) return { ...sinContrato(error), tipo, tiene_contrato: true, error };
  const ps = parrafos(texto);
  const advertencias: string[] = [];
  const motivos: Record<string, string> = {};
  const extras: string[] = [];
  const conf: Record<string, number> = {};

  const idContrato = /\b([A-Z]{2}-\d{4}-\d{1,3})\b/.exec(primera)?.[1] ?? "";
  conf.id_contrato = idContrato ? 1 : 0;

  // Comercial por remitente
  const email = correo.de.trim().toLowerCase();
  const comercial = comerciales.find((c) => c.email.toLowerCase() === email)?.nombre ?? "";
  if (!comercial) advertencias.push(`Remitente no registrado como comercial (${email}); comercial queda vacío`);

  // Partes
  const entre = ps.find((p) => /^Entre\b/.test(p)) ?? "";
  const partes = parsearPartes(entre);
  const propia = partes.find((p) => limpiarNit(p) === NIT_PERIFERIA);
  const cliente = partes.find((p) => p !== propia);
  if (!propia || propia.rol === "CONTRATANTE") {
    extras.push("rol_de_partes");
    motivos.rol_de_partes = propia ? "Periferia figura como CONTRATANTE" : "No se identificó a Periferia entre las partes";
  }

  if (tipo === "otrosi") {
    const fila = maestro.find((f) => f.id_contrato === idContrato);
    if (!idContrato || !fila) {
      return {
        tiene_contrato: true, tipo, referencia: idContrato || undefined,
        rechazo: `El otrosí referencia un contrato inexistente en el maestro (${idContrato || "sin id"})`,
        requiere_revision: [], motivos,
      };
    }
    const base = filaAContrato(fila);
    const c: Contrato = { ...base, comercial: comercial || base.comercial, advertencias };
    if (cliente && limpiarNit(cliente) !== fila.nit_cliente) {
      c.confianza.nit_cliente = 0.5;
      motivos.nit_cliente = `El NIT/RUC del otrosí no coincide con el maestro`;
    }
    for (const m of texto.matchAll(/cl[aá]usula\s+\w+\s+\((PLAZO|VALOR)\)[^"“]*["“]([^"”]+)["”]/g)) {
      if (m[1] === "PLAZO") {
        const f = parseFechaEs(m[2] ?? "");
        if (f) { c.fecha_fin = f; c.confianza.fecha_fin = 1; }
      } else {
        const d = extraerDinero(m[2] ?? "");
        if (d) { c.valor = d.valor; c.moneda = d.moneda; c.confianza.valor = 1; c.confianza.moneda = 1; }
      }
    }
    if (/deber[aá]n ampliarse|ampliarse/i.test(texto) && c.requiere_poliza) c.estado_poliza = "pendiente";
    return {
      tiene_contrato: true, tipo, referencia: idContrato, contrato: c,
      requiere_revision: [...revisionPorConfianza(c), ...extras], motivos,
    };
  }

  // --- Contrato nuevo ---
  const nitCliente = cliente ? limpiarNit(cliente) : "";
  conf.cliente = cliente ? 1 : 0;
  conf.nit_cliente = nitCliente ? 1 : 0;
  let pais: Contrato["pais"] = "";
  if (cliente) {
    if (cliente.tipoId === "RUC" && nitCliente.length === 13) pais = "EC";
    else if (cliente.tipoId === "RUC" && nitCliente.length === 11) pais = "PE";
    else pais = PAIS_POR_CIUDAD.find(([re]) => re.test(cliente.segmento))?.[1] ?? "";
  }
  conf.pais = pais ? 1 : 0;

  const objetoP = clausula(ps, "OBJETO");
  const objeto = objetoP ? recortar(objetoP.replace(/^.*?\bOBJETO\.\s*/, "").replace(/^El objeto es:\s*/i, "").replace(/^EL\s+CONTRATISTA\s+se\s+obliga\s+a\s+/i, ""), 200) : "";
  conf.objeto = objeto ? 1 : 0;

  if (!cliente && !objeto) {
    return { tiene_contrato: true, tipo, rechazo: "No se identificaron partes ni objeto", requiere_revision: [], motivos };
  }

  // Valor
  const valorP = clausula(ps, "VALOR") ?? "";
  let valor = 0;
  let valorIndeterminado = false;
  let moneda: Moneda = pais ? (MONEDA_POR_PAIS[pais] ?? "COP") : "COP";
  const dinero = extraerDinero(valorP);
  conf.moneda = 0;
  if (dinero) {
    valor = dinero.valor; moneda = dinero.moneda; conf.valor = 1; conf.moneda = 1;
  } else if (/no tiene un valor determinado|valor indeterminado/i.test(valorP)) {
    valorIndeterminado = true; conf.valor = 0.5;
    motivos.valor = "El contrato no tiene valor determinado (se propone 0)";
    const mon = /\b(COP|USD|PEN|PAB|HNL)\b/.exec(texto)?.[1];
    if (mon) { moneda = mon as Moneda; conf.moneda = 0.8; }
  } else {
    conf.valor = 0;
    motivos.valor = "No se encontró el valor entre paréntesis en la cláusula VALOR";
  }

  // Plazo
  const plazoP = clausula(ps, "PLAZO") ?? "";
  const fechas = todasLasFechasEs(plazoP);
  let inicio = "";
  let fin = "";
  if (fechas.length >= 2) {
    inicio = fechas[0] ?? ""; fin = fechas[1] ?? "";
    conf.fecha_inicio = 1; conf.fecha_fin = 1;
  } else {
    const meses = /\((\d{1,3})\)\s+meses/.exec(plazoP)?.[1];
    inicio = ymd(correo.fecha);
    if (!esFechaIso(inicio)) return { ...sinContrato("Fecha del correo inválida"), tipo, tiene_contrato: true, error: "Fecha del correo inválida para inferir el inicio" };
    conf.fecha_inicio = 0.8;
    motivos.fecha_inicio = "Inferida de la fecha del correo (el contrato no trae fechas explícitas)";
    if (meses) {
      fin = addMonths(inicio, Number(meses));
      conf.fecha_fin = 0.6;
      motivos.fecha_fin = `Calculada: inicio + ${meses} meses`;
    } else {
      conf.fecha_fin = 0;
      motivos.fecha_fin = "No se encontró fecha de fin ni plazo en meses";
    }
  }

  if (inicio && fin && fin < inicio) return { ...sinContrato("Plazo inválido"), tipo, tiene_contrato: true, error: "Fecha fin anterior a fecha inicio" };

  // Póliza
  const garP = clausula(ps, "GARANT[ÍI]AS");
  const tipos = garP
    ? [...garP.matchAll(/p[oó]liza de ([a-záéíóúñ ]+?)(?: por | con |,|\.|;| y )/gi)].map((m) =>
        (m[1] ?? "").trim().toLowerCase().replaceAll(" ", "_"))
    : [];
  const requierePoliza = tipos.length > 0;
  conf.requiere_poliza = 1;
  if (requierePoliza && /para cada orden|cuyo valor supere/i.test(garP ?? "")) {
    conf.requiere_poliza = 0.8;
    advertencias.push("Póliza condicional a órdenes de servicio de alto valor; se asume requerida (cumplimiento)");
  }

  // PRD 7.2: sin id en el documento → AUTO-<año>-<secuencia> (confianza 0: lo revisa la persona).
  const anio = (inicio || "").slice(0, 4) || String(new Date().getUTCFullYear());
  const seq = maestro.filter((f) => f.id_contrato.startsWith(`AUTO-${anio}-`)).length + 1;
  const contrato: Contrato = {
    id_contrato: idContrato || `AUTO-${anio}-${String(seq).padStart(3, "0")}`,
    cliente: cliente ? tituloEs(cliente.nombre) : "",
    nit_cliente: nitCliente,
    pais,
    objeto,
    valor,
    valor_indeterminado: valorIndeterminado,
    moneda,
    fecha_inicio: inicio,
    fecha_fin: fin,
    requiere_poliza: requierePoliza,
    tipo_poliza: [...new Set(tipos)].join(";"),
    estado_poliza: requierePoliza ? "pendiente" : "no_aplica",
    comercial,
    confianza: conf,
    advertencias,
  };
  for (const campo of revisionPorConfianza(contrato)) {
    motivos[campo] ??= `Confianza ${conf[campo] ?? 0} por debajo del umbral 0.8`;
  }
  return {
    tiene_contrato: true, tipo, contrato,
    requiere_revision: [...revisionPorConfianza(contrato), ...extras], motivos,
  };
}
