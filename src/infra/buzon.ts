import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { z } from "zod";
import type { Comercial, Correo } from "../domain/extraccion.ts";
import { dentroDe, dirs, FIXTURES } from "./rutas.ts";

const correoSchema = z.object({
  id: z.string(), de: z.string(), asunto: z.string(), fecha: z.string(),
  adjuntos: z.array(z.string()).default([]),
});

interface MensajeLeido {
  correo: Correo;
  adjuntoNombre: string | null;
  texto: string | null;
}

export function listarIds(directory: string): string[] {
  const { buzon } = dirs(directory);
  if (!existsSync(buzon)) return [];
  return readdirSync(buzon).filter((n) => /^msg-\d{3}$/.test(n)).sort();
}

// Lanza Error si el id es inválido o no existe (las tools lo capturan).
export function leerMensaje(directory: string, id: string): MensajeLeido {
  if (!/^msg-\d{3}$/.test(id)) throw new Error("mensaje_id inválido");
  const { buzon } = dirs(directory);
  const carpeta = resolve(buzon, id);
  if (!dentroDe(buzon, carpeta) || !existsSync(carpeta)) throw new Error(`mensaje no encontrado: ${id}`);
  const correo = correoSchema.parse(JSON.parse(readFileSync(resolve(carpeta, "correo.json"), "utf8")));
  const adjuntos = correo.adjuntos.map((a) => basename(a));
  let elegido: { nombre: string; texto: string } | null = null;
  for (const nombre of adjuntos) {
    const ruta = resolve(carpeta, nombre);
    if (!dentroDe(carpeta, ruta) || !existsSync(ruta)) continue;
    const texto = readFileSync(ruta, "utf8");
    const primera = texto.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
    if (/^(CONTRATO\b|OTROS[ÍI])/i.test(primera)) { elegido = { nombre, texto }; break; }
    elegido ??= { nombre, texto };
  }
  return { correo: { ...correo, adjuntos }, adjuntoNombre: elegido?.nombre ?? null, texto: elegido?.texto ?? null };
}

export function rutaAdjunto(directory: string, id: string, nombre: string): string {
  return resolve(dirs(directory).buzon, id, basename(nombre));
}

export function leerComerciales(directory: string): Comercial[] {
  const ruta = resolve(dirs(directory).raiz, FIXTURES, "comerciales.json");
  if (!existsSync(ruta)) return [];
  const data: unknown = JSON.parse(readFileSync(ruta, "utf8"));
  return z.array(z.object({ email: z.string(), nombre: z.string(), region: z.string().optional() })).parse(data);
}
