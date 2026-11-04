import { copyFileSync, existsSync, mkdirSync, constants } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { dentroDe, dirs } from "./rutas.ts";

// Copia el adjunto bajo out/sharepoint/<rutaRelativa>; nunca pisa un archivo existente.
// Devuelve la ruta relativa a sharepoint realmente usada.
export function archivarAdjunto(
  directory: string,
  origen: string,
  carpetaRel: string,
  baseNombre: string,
  ext: string,
): string {
  const { sharepoint } = dirs(directory);
  const e = /^\.[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : ".bin";
  if (!/^[A-Za-z0-9._-]+$/.test(baseNombre)) throw new Error("nombre de archivo inválido");
  for (let n = 1; n < 100; n++) {
    const nombre = n === 1 ? `${baseNombre}${e}` : `${baseNombre}-v${n}${e}`;
    const rel = `${carpetaRel}/${nombre}`;
    const destino = resolve(sharepoint, rel);
    if (!dentroDe(sharepoint, destino)) throw new Error("ruta fuera de out/sharepoint");
    if (existsSync(destino)) continue;
    mkdirSync(dirname(destino), { recursive: true });
    copyFileSync(origen, destino, constants.COPYFILE_EXCL);
    return rel;
  }
  throw new Error("no se pudo asignar nombre de archivo");
}

export function extDe(nombre: string): string {
  return extname(nombre);
}
