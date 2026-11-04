import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsearCsv, serializarCsv } from "../domain/csv.ts";
import { COLUMNAS } from "../domain/contrato.ts";
import type { FilaMaestro } from "../domain/contrato.ts";
import { dirs, FIXTURES } from "./rutas.ts";

export function rutaMaestro(directory: string): string {
  return resolve(dirs(directory).sharepoint, "maestro-contratos.csv");
}

export function asegurarMaestro(directory: string): string {
  const destino = rutaMaestro(directory);
  if (!existsSync(destino)) {
    mkdirSync(dirs(directory).sharepoint, { recursive: true });
    copyFileSync(resolve(dirs(directory).raiz, FIXTURES, "maestro-contratos.csv"), destino);
  }
  return destino;
}

export function leerMaestro(directory: string): FilaMaestro[] {
  const filas = parsearCsv(readFileSync(asegurarMaestro(directory), "utf8"));
  const cab = filas[0] ?? [];
  return filas.slice(1).map((celdas) => {
    const f = {} as FilaMaestro;
    for (const col of COLUMNAS) f[col] = celdas[cab.indexOf(col)] ?? "";
    return f;
  });
}

// Escritura atómica: tmp en el mismo directorio + rename.
export function escribirMaestro(directory: string, filas: FilaMaestro[]): void {
  const destino = asegurarMaestro(directory);
  const tmp = `${destino}.${process.pid}.tmp`;
  const contenido = serializarCsv([[...COLUMNAS], ...filas.map((f) => COLUMNAS.map((c) => f[c]))]);
  writeFileSync(tmp, contenido, "utf8");
  renameSync(tmp, destino);
}
