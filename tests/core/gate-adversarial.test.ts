import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registrar, validar } from "../../src/tools/contratos.ts";

const REAL = resolve(import.meta.dirname, "../..");
const HOY = "2026-09-03";
type R = { ok: boolean; error?: string; data?: Record<string, unknown> };
const j = (s: string): R => JSON.parse(s) as R;

function nuevoDir(): { directory: string; sessionId: string } {
  const d = mkdtempSync(join(tmpdir(), "reto02g-"));
  cpSync(join(REAL, "fixtures"), join(d, "fixtures"), { recursive: true });
  return { directory: d, sessionId: "g" };
}
const maestroCrudo = (d: string): string => {
  const f = join(d, "out/sharepoint/maestro-contratos.csv");
  return existsSync(f) ? readFileSync(f, "utf8") : readFileSync(join(d, "fixtures/reto-02/maestro-contratos.csv"), "utf8");
};

test("override sobre msg-001 sin confirmar: ok:false y maestro intacto", async () => {
  const ctx = nuevoDir();
  const antes = maestroCrudo(ctx.directory);
  const r = j(await registrar.execute({ mensaje_id: "msg-001", hoy: HOY, contrato: { valor: 1, cliente: "ATACANTE SAS" } }, ctx));
  assert.equal(r.ok, false);
  assert.equal(maestroCrudo(ctx.directory), antes);
});

test("override con confirmado:true pero clave fuera de revisión: ok:false", async () => {
  const ctx = nuevoDir();
  const antes = maestroCrudo(ctx.directory);
  const r1 = j(await registrar.execute({ mensaje_id: "msg-001", hoy: HOY, confirmado: true, contrato: { valor: 1 } }, ctx));
  assert.equal(r1.ok, false);
  const r6 = j(await registrar.execute({ mensaje_id: "msg-006", hoy: HOY, confirmado: true, contrato: { cliente: "ATACANTE SAS" } }, ctx));
  assert.equal(r6.ok, false);
  assert.match(r6.error ?? "", /fuera de revisión/);
  assert.equal(maestroCrudo(ctx.directory), antes);
});

/** Archivos bajo out/ (salvo el log de auditoría) con su contenido. */
function archivosOut(d: string): Record<string, string> {
  const res: Record<string, string> = {};
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const n of readdirSync(dir)) {
      const f = join(dir, n);
      if (statSync(f).isDirectory()) walk(f);
      else if (n !== "log.jsonl") res[f] = readFileSync(f, "utf8");
    }
  };
  walk(join(d, "out"));
  return res;
}

test("validar con contrato es solo informativo: ok:true, clasificación del servidor, sin escritura", async () => {
  const ctx = nuevoDir();
  const antes = maestroCrudo(ctx.directory);
  const base = j(await validar.execute({ mensaje_id: "msg-001" }, ctx)).data!;
  const instantanea = archivosOut(ctx.directory);
  const r = j(await validar.execute({ mensaje_id: "msg-001", contrato: { valor: 1, cliente: "ATACANTE SAS" } }, ctx));
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(r.data!.clasificacion, base.clasificacion);
  assert.deepEqual(r.data!.requiere_revision, base.requiere_revision);
  assert.ok(r.data!.diferencias_propuesta && typeof r.data!.diferencias_propuesta === "object");
  assert.deepEqual([...(r.data!.campos_fuera_de_revision as string[])].sort(), ["cliente", "valor"]);
  assert.equal(maestroCrudo(ctx.directory), antes);
  assert.deepEqual(archivosOut(ctx.directory), instantanea);
  // y no habilita registrar: sigue rechazando el override fuera de revisión
  const reg = j(await registrar.execute({ mensaje_id: "msg-001", hoy: HOY, confirmado: true, contrato: { valor: 1 } }, ctx));
  assert.equal(reg.ok, false);
  assert.equal(maestroCrudo(ctx.directory), antes);
});

test("flujo legítimo 006: confirmado + override de campo en revisión funciona", async () => {
  const ctx = nuevoDir();
  const sin = j(await registrar.execute({ mensaje_id: "msg-006", hoy: HOY }, ctx));
  assert.equal(sin.ok, false);
  const r = j(await registrar.execute({ mensaje_id: "msg-006", hoy: HOY, confirmado: true, contrato: { valor: 5000000 } }, ctx));
  assert.equal(r.ok, true, r.error ?? "");
  assert.ok(maestroCrudo(ctx.directory).includes("5000000"));
});
