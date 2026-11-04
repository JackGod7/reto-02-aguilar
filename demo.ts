// Demo determinista sin LLM ni clave: procesa 001→006 llamando execute directo.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { alertas, extraer, registrar, validar } from "./src/tools/contratos.ts";

const HOY = "2026-09-03";
const directory = process.cwd();
const ctx = { directory, sessionId: "demo" };
// Conserva el directorio autorizado: el usuario no root del contenedor solo posee out/.
const out = resolve(directory, "out");
mkdirSync(out, { recursive: true });
for (const nombre of readdirSync(out)) rmSync(resolve(out, nombre), { recursive: true, force: true });

type Json = { ok: boolean; data?: Record<string, unknown>; error?: string; revision?: Array<{ campo: string; valor_propuesto: unknown; confianza: number; motivo: string }> };
const parse = (s: string): Json => JSON.parse(s) as Json;

const filas: string[][] = [["mensaje", "clasificación", "id_contrato", "acción", "detalle"]];
let fallos = 0;

for (const n of [1, 2, 3, 4, 5, 6]) {
  const mensaje_id = `msg-00${n}`;
  const ex = parse(await extraer.execute({ mensaje_id }, ctx));
  const va = parse(await validar.execute({ mensaje_id }, ctx));
  if (!ex.ok || !va.ok) { fallos++; filas.push([mensaje_id, "ERROR", "", "", ex.error ?? va.error ?? ""]); continue; }
  const clasificacion = String(va.data?.clasificacion);
  let r = parse(await registrar.execute({ mensaje_id, hoy: HOY }, ctx));
  let detalle = "";
  if (!r.ok && r.revision) {
    detalle = `PENDIENTE confirmación: ${r.revision.map((x) => `${x.campo}=${String(x.valor_propuesto)} (conf ${x.confianza})`).join("; ")}`;
    filas.push([mensaje_id, clasificacion, String(ex.data?.id_contrato ?? ""), "requiere revisión", detalle]);
    r = parse(await registrar.execute({ mensaje_id, hoy: HOY, confirmado: true }, ctx));
    detalle = "confirmado:true tras revisión";
  } else if (!r.ok) {
    fallos++;
  }
  if (va.data?.motivo) detalle = String(va.data.motivo);
  filas.push([mensaje_id, clasificacion, String(r.data?.id_contrato ?? ex.data?.id_contrato ?? "-"), r.ok ? String(r.data?.accion) : `ERROR ${r.error}`, detalle]);
}

const al = parse(await alertas.execute({ hoy: HOY }, ctx));
const d = (al.data ?? {}) as Record<string, Array<{ id_contrato: string }>>;
const ids = (k: string): string => (d[k] ?? []).map((i) => i.id_contrato).join(", ") || "-";

const anchos = (filas[0] ?? []).map((_, i) => Math.max(...filas.map((f) => (f[i] ?? "").length)));
for (const [i, f] of filas.entries()) {
  console.log(f.map((c, j) => c.padEnd(anchos[j] ?? 0)).join(" | "));
  if (i === 0) console.log(anchos.map((a) => "-".repeat(a)).join("-+-"));
}
console.log(`\nAlertas (hoy=${HOY}) → ${String(al.data?.ruta)}`);
console.log(`  vencen ≤60d:         ${ids("vencen")}`);
console.log(`  ya vencidos:         ${ids("vencidos")}`);
console.log(`  pólizas pendientes:  ${ids("polizas_pendientes")}`);
console.log(`  registrados ≥corte:  ${ids("registrados_desde_corte")}`);
process.exit(fallos > 0 || !al.ok ? 1 : 0);
