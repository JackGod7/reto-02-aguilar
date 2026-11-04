import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { alertas, extraer, leer_buzon, registrar, validar } from "../../src/tools/contratos.ts";
import { leerMaestro } from "../../src/infra/maestro.ts";

const HOY = "2026-09-03";
const REAL = resolve(import.meta.dirname, "../..");
const dir = mkdtempSync(join(tmpdir(), "reto02-"));
cpSync(join(REAL, "fixtures"), join(dir, "fixtures"), { recursive: true });
const ctx = { directory: dir, sessionId: "t" };

function hashDir(d: string): string {
  const h = createHash("sha256");
  const walk = (p: string): void => {
    for (const n of readdirSync(p).sort()) {
      const f = join(p, n);
      if (statSync(f).isDirectory()) walk(f);
      else h.update(f.slice(d.length)).update(readFileSync(f));
    }
  };
  walk(d);
  return h.digest("hex");
}

type Obj = Record<string, unknown>;
type R = { ok: boolean; data?: Obj; error?: string; revision?: Obj[] };
const o = (x: unknown): Obj => x as Obj;
const arr = (x: unknown): Obj[] => x as Obj[];
const j = (s: string): R => JSON.parse(s) as R;
const hashRealAntes = hashDir(join(REAL, "fixtures"));
const hashTmpAntes = hashDir(join(dir, "fixtures"));

test("buzón lista 6 mensajes; 005 sin contrato", async () => {
  const r = j(await leer_buzon.execute({}, ctx));
  assert.equal(arr(r.data?.mensajes).length, 6);
  const m5 = arr(r.data?.mensajes).find((m) => m.id === "msg-005");
  assert.equal(m5?.tiene_contrato, false);
});

test("extraer 001: campos exactos", async () => {
  const d = j(await extraer.execute({ mensaje_id: "msg-001" }, ctx)).data!;
  assert.equal(d.id_contrato, "CT-2026-015");
  assert.equal(d.cliente, "Industrias Delta S.A.S.");
  assert.equal(d.nit_cliente, "890900111");
  assert.equal(d.pais, "CO");
  assert.equal(d.valor, 265000000);
  assert.equal(d.moneda, "COP");
  assert.equal(d.fecha_inicio, "2026-08-01");
  assert.equal(d.fecha_fin, "2027-07-31");
  assert.equal(d.tipo_poliza, "cumplimiento");
  assert.equal(d.estado_poliza, "pendiente");
  assert.equal(d.comercial, "Laura Gómez Restrepo");
  assert.deepEqual(d.requiere_revision, []);
});

test("extraer 002: Ecuador, RUC con ceros, sin póliza", async () => {
  const d = j(await extraer.execute({ mensaje_id: "msg-002" }, ctx)).data!;
  assert.equal(d.id_contrato, "CT-2026-016");
  assert.equal(d.cliente, "Corporación Andina de Servicios S.A.");
  assert.equal(d.nit_cliente, "1790012345001");
  assert.equal(d.pais, "EC");
  assert.equal(d.valor, 120000);
  assert.equal(d.moneda, "USD");
  assert.equal(d.fecha_inicio, "2026-08-15");
  assert.equal(d.fecha_fin, "2027-08-14");
  assert.equal(d.estado_poliza, "no_aplica");
  assert.equal(d.comercial, "Carlos Ruiz Medina");
});

test("NIT con DV se limpia (004) y 006 revisión", async () => {
  assert.equal(j(await extraer.execute({ mensaje_id: "msg-004" }, ctx)).data!.nit_cliente, "890903456");
  const d = j(await extraer.execute({ mensaje_id: "msg-006" }, ctx)).data!;
  assert.equal(d.nit_cliente, "800222333");
  assert.equal(d.valor, 0);
  assert.equal(d.valor_indeterminado, true);
  assert.equal(o(d.confianza).valor, 0.5);
  assert.equal(d.fecha_inicio, "2026-08-31");
  assert.equal(o(d.confianza).fecha_inicio, 0.8);
  assert.equal(d.fecha_fin, "2027-08-31");
  assert.equal(o(d.confianza).fecha_fin, 0.6);
  assert.deepEqual(d.requiere_revision, ["valor", "fecha_fin"]);
  assert.equal(d.comercial, "");
  assert.ok((d.advertencias as string[]).some((a) => /no registrado/i.test(a)));
});

test("flujo SPEC §4: 001→006 + alertas", async () => {
  const cls: Record<string, string> = {};
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const id = `msg-00${n}`;
    cls[id] = String(j(await validar.execute({ mensaje_id: id }, ctx)).data?.clasificacion);
  }
  assert.deepEqual(cls, {
    "msg-001": "nuevo", "msg-002": "nuevo", "msg-003": "actualizacion",
    "msg-004": "duplicado", "msg-005": "rechazado", "msg-006": "nuevo",
  });
  const val3 = j(await validar.execute({ mensaje_id: "msg-003" }, ctx)).data!;
  assert.equal(val3.id_contrato_existente, "CT-2026-011");

  const antes = readFileSync(join(dir, "fixtures/reto-02/maestro-contratos.csv"), "utf8");
  for (const n of [1, 2, 3, 4, 5]) {
    const r = j(await registrar.execute({ mensaje_id: `msg-00${n}`, hoy: HOY }, ctx));
    assert.equal(r.ok, true, `msg-00${n}: ${r.error}`);
  }
  // 006 sin confirmar → bloqueado
  const bloq = j(await registrar.execute({ mensaje_id: "msg-006", hoy: HOY }, ctx));
  assert.equal(bloq.ok, false);
  assert.equal(bloq.error, "requiere revisión: valor, fecha_fin");
  assert.deepEqual(bloq.revision?.map((x) => x.campo), ["valor", "fecha_fin"]);
  assert.equal(bloq.revision?.[0]?.valor_propuesto, 0);
  assert.equal(leerMaestro(dir).some((f) => f.id_contrato === "CM-2026-03"), false);
  const ok6 = j(await registrar.execute({ mensaje_id: "msg-006", hoy: HOY, confirmado: true }, ctx));
  assert.equal(ok6.ok, true);

  const m = leerMaestro(dir);
  assert.equal(m.length, 11);
  const f003 = m.find((f) => f.id_contrato === "CT-2026-011")!;
  assert.equal(f003.fecha_fin, "2027-11-01");
  assert.equal(f003.valor, "520000");
  assert.equal(f003.moneda, "PEN");
  assert.equal(f003.estado_poliza, "pendiente");
  assert.equal(f003.fecha_registro, "2026-05-05");
  assert.equal(f003.objeto, "Célula ágil de desarrollo para sistema de operaciones");
  assert.equal(m.filter((f) => f.id_contrato === "CT-2026-012").length, 1);
  assert.equal(m.find((f) => f.id_contrato === "CT-2026-015")?.ruta_sharepoint, "Contratos/2026/industrias-delta/CT-2026-015.txt");
  assert.equal(m.find((f) => f.id_contrato === "CM-2026-03")?.fecha_registro, HOY);
  assert.equal(readFileSync(join(dir, "fixtures/reto-02/maestro-contratos.csv"), "utf8"), antes);

  const hist = readFileSync(join(dir, "out/sharepoint/historial.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Obj);
  const h = hist.find((x) => x.id_contrato === "CT-2026-011") ?? {};
  assert.equal(h.accion, "actualizacion");
  assert.equal(h.mensaje_id, "msg-003");
  assert.ok(existsSync(join(dir, "out/sharepoint/Contratos/2026/minera-los-andes/CT-2026-011-otrosi-1.txt")));

  // reintento 001 es duplicado
  const dup = j(await registrar.execute({ mensaje_id: "msg-001", hoy: HOY }, ctx));
  assert.equal(dup.data?.accion, "duplicado");
  assert.equal(leerMaestro(dir).length, 11);

  const al = j(await alertas.execute({ hoy: HOY }, ctx)).data!;
  const ids = (k: string): string[] => arr(al[k]).map((i) => String(i.id_contrato)).sort();
  assert.deepEqual(ids("vencen"), ["CT-2026-004", "CT-2026-009"]);
  assert.deepEqual(ids("vencidos"), ["CT-2025-018", "CT-2026-002"]);
  assert.deepEqual(ids("polizas_pendientes"), ["CM-2026-03", "CT-2026-004", "CT-2026-011", "CT-2026-015"]);
  assert.deepEqual(ids("registrados_desde_corte"), ["CM-2026-03", "CT-2026-015", "CT-2026-016"]);
  assert.equal(al.ruta, "out/alertas.md");
  const md = readFileSync(join(dir, "out/alertas.md"), "utf8");
  assert.match(md, /Ya vencidos/);

  // 005 y todos procesados → buzón vacío
  assert.equal(arr(j(await leer_buzon.execute({}, ctx)).data?.mensajes).length, 0);
  const log = readFileSync(join(dir, "out/log.jsonl"), "utf8");
  assert.ok(log.includes('"herramienta":"registrar"'));
});

test("seguridad: path traversal, args extra, hoy inválido", async () => {
  for (const f of [extraer, validar, registrar] as const) {
    const r = j(await f.execute({ mensaje_id: "../../.env" } as never, ctx));
    assert.equal(r.ok, false);
  }
  assert.equal(j(await extraer.execute({ mensaje_id: "msg-999" }, ctx)).ok, false);
  assert.equal(j(await extraer.execute({ mensaje_id: "msg-001", extra: 1 } as never, ctx)).ok, false);
  assert.equal(j(await alertas.execute({ hoy: "ayer" }, ctx)).ok, false);
  assert.equal(j(await registrar.execute({ mensaje_id: "msg-001", contrato: { valor: "x" } } as never, ctx)).ok, false);
});

test("seguridad: toda ruta escrita queda dentro de out/ y fixtures intactos", () => {
  const out = join(dir, "out") + sep;
  const walk = (p: string): string[] =>
    readdirSync(p).flatMap((n) => (statSync(join(p, n)).isDirectory() ? walk(join(p, n)) : [join(p, n)]));
  for (const f of walk(join(dir, "out"))) assert.ok(resolve(f).startsWith(out), f);
  const m = leerMaestro(dir);
  for (const f of m) {
    const abs = resolve(dir, "out/sharepoint", f.ruta_sharepoint);
    assert.ok(abs.startsWith(out), abs);
  }
  assert.equal(hashDir(join(dir, "fixtures")), hashTmpAntes);
  assert.equal(hashDir(join(REAL, "fixtures")), hashRealAntes);
});

test("maestro con celda de fórmula se relee igual tras registrar override", async () => {
  const d2 = mkdtempSync(join(tmpdir(), "reto02b-"));
  cpSync(join(REAL, "fixtures"), join(d2, "fixtures"), { recursive: true });
  const c2 = { directory: d2, sessionId: "t2" };
  const r = j(await registrar.execute({ mensaje_id: "msg-001", hoy: HOY, contrato: { comercial: '=HYPERLINK("x","y")', objeto: "a, b" } }, c2));
  assert.equal(r.ok, true, r.error ?? "");
  const crudo = readFileSync(join(d2, "out/sharepoint/maestro-contratos.csv"), "utf8");
  assert.ok(crudo.includes(`'=HYPERLINK`));
  const f = leerMaestro(d2).find((x) => x.id_contrato === "CT-2026-015")!;
  assert.equal(f.comercial, '=HYPERLINK("x","y")');
  assert.equal(f.objeto, "a, b");
});
