// Normalización de montos: "265.000.000", "120,000.00", "1.234,56", "1,5".
export function parseDinero(texto: string): number | null {
  const s = texto.trim().replace(/[^\d.,]/g, "");
  if (!/\d/.test(s)) return null;
  const puntos = (s.match(/\./g) ?? []).length;
  const comas = (s.match(/,/g) ?? []).length;
  let normal: string;
  if (puntos > 0 && comas > 0) {
    // el último separador es el decimal
    const decimal = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    const miles = decimal === "." ? "," : ".";
    normal = s.split(miles).join("").replace(decimal, ".");
  } else if (puntos > 0 || comas > 0) {
    const sep = puntos > 0 ? "." : ",";
    const n = puntos > 0 ? puntos : comas;
    const partes = s.split(sep);
    const ultimo = partes[partes.length - 1] ?? "";
    const gruposDe3 = partes.slice(1).every((p) => p.length === 3);
    if (n > 1 && !gruposDe3) return null;
    if (gruposDe3 && (partes[0] ?? "").length <= 3 && (partes[0] ?? "").length > 0) {
      normal = partes.join("");
    } else if (n === 1 && ultimo.length !== 3) {
      normal = partes.join(".");
    } else {
      normal = partes.join("");
    }
  } else {
    normal = s;
  }
  const v = Number(normal);
  return Number.isFinite(v) ? v : null;
}

const MONEDAS = ["COP", "USD", "PEN", "PAB", "HNL"] as const;
export type Moneda = (typeof MONEDAS)[number];

// "(COP $265.000.000)" | "(USD 120,000.00)" → {moneda, valor}
export function extraerDinero(texto: string): { moneda: Moneda; valor: number } | null {
  const m = /\(\s*(COP|USD|PEN|PAB|HNL)\s*\$?\s*([\d.,]+)\s*\)/.exec(texto);
  if (!m) return null;
  const valor = parseDinero(m[2] ?? "");
  if (valor === null) return null;
  return { moneda: m[1] as Moneda, valor };
}
