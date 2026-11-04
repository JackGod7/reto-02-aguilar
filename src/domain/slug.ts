const SUFIJO = /\s+(?:s\.?\s?a\.?\s?s\.?|s\.?\s?a\.?\s?c\.?|s\.?\s+de\s+r\.?\s?l\.?|s\.?\s?a\.?|ltda\.?)$/i;

export function slugCliente(nombre: string): string {
  const base = nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(SUFIJO, "");
  return base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
