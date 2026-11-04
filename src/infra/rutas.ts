import { resolve, sep } from "node:path";

export const FIXTURES = "fixtures/reto-02";

export function dirs(directory: string): { raiz: string; buzon: string; out: string; sharepoint: string } {
  const raiz = resolve(directory);
  return {
    raiz,
    buzon: resolve(raiz, FIXTURES, "buzon"),
    out: resolve(raiz, "out"),
    sharepoint: resolve(raiz, "out", "sharepoint"),
  };
}

export function dentroDe(base: string, ruta: string): boolean {
  const r = resolve(ruta);
  return r === base || r.startsWith(base + sep);
}
