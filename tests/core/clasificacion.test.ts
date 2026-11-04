import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { filaAContrato, idContratoSchema } from "../../src/domain/contrato.ts";
import type { Contrato, FilaMaestro } from "../../src/domain/contrato.ts";
import type { Extraccion } from "../../src/domain/extraccion.ts";
import { clasificar, jaccard } from "../../src/domain/reglas.ts";
import { escribirMaestro, leerMaestro } from "../../src/infra/maestro.ts";
import { extraer, registrar, validar } from "../../src/tools/contratos.ts";

const fila: FilaMaestro = {
  id_contrato: "CT-2026-010", cliente: "Empresa Delta S.A.S.", nit_cliente: "890900111", pais: "CO",
  objeto: "Implementación de plataforma logística regional", valor: "100", moneda: "COP",
  fecha_inicio: "2026-01-01", fecha_fin: "2026-12-31", requiere_poliza: "true", tipo_poliza: "cumplimiento",
  estado_poliza: "vigente", comercial: "Comercial Uno", ruta_sharepoint: "Contratos/2026/delta/CT-2026-010.pdf",
  fecha_registro: "2026-01-02", fuente: "buzon",
};

function extraccion(cambios: Partial<Contrato> = {}, tipo: Extraccion["tipo"] = "contrato"): Extraccion {
  return { tiene_contrato: true, tipo, contrato: { ...filaAContrato(fila), ...cambios }, requiere_revision: [], motivos: {} };
}

test("RN1: id, valor numérico y fechas iguales prevalecen sobre metadatos", () => {
  for (const cambios of [{}, { moneda: "USD" }, { pais: "EC" }, { comercial: "Otra persona" }, { requiere_poliza: false, tipo_poliza: "", estado_poliza: "no_aplica" }] as Partial<Contrato>[]) {
    const r = clasificar(extraccion(cambios), [{ ...fila, valor: "100.00" }]);
    assert.equal(r.clasificacion, "duplicado", JSON.stringify(cambios));
    assert.equal(r.diferencias, undefined);
  }
});

for (const [campo, despues] of [["valor", 120], ["fecha_inicio", "2026-01-02"], ["fecha_fin", "2027-01-01"]] as const) {
  test(`RN2: mismo id y cambio de ${campo} actualiza con evidencia de antes/después`, () => {
    const r = clasificar(extraccion({ [campo]: despues }), [fila]);
    assert.equal(r.clasificacion, "actualizacion");
    assert.deepEqual(r.requiere_revision, []);
    assert.deepEqual(r.diferencias?.[campo], { antes: campo === "valor" ? 100 : fila[campo], despues });
  });
}

test("RN2: otrosí sin diferencias es duplicado; cambio explícito de póliza es actualización", () => {
  assert.equal(clasificar(extraccion({}, "otrosi"), [fila]).clasificacion, "duplicado");
  assert.equal(clasificar(extraccion({ comercial: "Otro remitente" }, "otrosi"), [fila]).clasificacion, "duplicado");
  const r = clasificar(extraccion({ estado_poliza: "pendiente" }, "otrosi"), [fila]);
  assert.equal(r.clasificacion, "actualizacion");
  assert.deepEqual(r.diferencias, { estado_poliza: { antes: "vigente", despues: "pendiente" } });
});

test("RN2: el umbral de similitud incluye 0.9 y excluye valores menores", () => {
  const palabras = ["aaa", "bbb", "ccc", "ddd", "eee", "fff", "ggg", "hhh", "iii", "jjj"];
  const maestro = [{ ...fila, objeto: palabras.join(" ") }];
  for (const [cantidad, clasificacion] of [[9, "duplicado"], [8, "nuevo"]] as const) {
    const objeto = palabras.slice(0, cantidad).join(" ");
    assert.equal(jaccard(maestro[0]!.objeto, objeto), cantidad / 10);
    assert.equal(clasificar(extraccion({ id_contrato: "CT-2026-099", objeto }), maestro).clasificacion, clasificacion);
  }
});

test("HU-3: NIT+objeto exige ≥0.9 y el id alternativo pasa por revisión con destino explícito", () => {
  const igual = extraccion({ id_contrato: "CT-2026-099" });
  const duplicado = clasificar(igual, [fila]);
  assert.equal(duplicado.clasificacion, "duplicado");
  assert.deepEqual(duplicado.requiere_revision, ["id_contrato"]);
  assert.equal(duplicado.valores_revision?.id_contrato, fila.id_contrato);
  assert.match(duplicado.motivos_revision?.id_contrato ?? "", /CT-2026-099.*CT-2026-010/);
  assert.equal(clasificar(extraccion({ id_contrato: "CT-2026-099", valor: 120 }), [fila]).clasificacion, "actualizacion");
  assert.equal(clasificar(extraccion({ id_contrato: "CT-2026-099", moneda: "USD" }), [fila]).clasificacion, "duplicado");
  const diferente = extraccion({ id_contrato: "CT-2026-099", objeto: "Auditoría financiera tributaria" });
  assert.ok(jaccard(fila.objeto, diferente.contrato!.objeto) < 0.9);
  assert.equal(clasificar(diferente, [fila]).clasificacion, "nuevo");
});

for (const [campo, despues] of [["nit_cliente", "123456789"], ["cliente", "Otra Empresa S.A."], ["objeto", "Auditoría financiera tributaria"]] as const) {
  test(`HU-3: mismo id con ${campo} incompatible no obtiene actualización limpia`, () => {
    const r = clasificar(extraccion({ [campo]: despues }), [fila]);
    assert.equal(r.clasificacion, "actualizacion");
    assert.ok(r.requiere_revision.includes(campo));
    assert.match(r.motivos_revision?.[campo] ?? "", /no es compatible/);
  });
}

test("HU-3: coincidencias múltiples nunca seleccionan la primera fila", () => {
  for (const [ext, maestro] of [[extraccion(), [fila, { ...fila }]], [extraccion({ id_contrato: "CT-2026-099" }), [fila, { ...fila, id_contrato: "CT-2026-011" }]]] as const) {
    const r = clasificar(ext, [...maestro]);
    assert.equal(r.id_contrato_existente, undefined);
    assert.deepEqual(r.requiere_revision, ["id_contrato"]);
    assert.match(r.bloqueo_registro ?? "", /Identidad ambigua/);
  }
});

test("RN3/RN4: no coincidencia es nuevo y documento sin contrato se rechaza con motivo", () => {
  assert.equal(clasificar(extraccion(), []).clasificacion, "nuevo");
  const r = clasificar({ tiene_contrato: false, tipo: null, motivo: "Sin adjunto", requiere_revision: [], motivos: {} }, [fila]);
  assert.equal(r.clasificacion, "rechazado");
  assert.equal(r.motivo, "Sin adjunto");
});

const raiz = resolve(import.meta.dirname, "../..");
type Respuesta = { ok: boolean; error?: string; data?: Record<string, unknown>; revision?: Array<{ campo: string; valor_propuesto: unknown; motivo: string }> };
const json = (s: string): Respuesta => JSON.parse(s) as Respuesta;
function escenario() {
  const directory = mkdtempSync(join(tmpdir(), "reto-a2-"));
  cpSync(join(raiz, "fixtures"), join(directory, "fixtures"), { recursive: true });
  return { directory, sessionId: "a2" };
}
const historial = (directory: string): string => {
  const archivo = join(directory, "out/sharepoint/historial.jsonl");
  return existsSync(archivo) ? readFileSync(archivo, "utf8") : "";
};
const maestroCrudo = (directory: string): string => readFileSync(join(directory, "out/sharepoint/maestro-contratos.csv"), "utf8");

test("RN1 real: reenvío con metadatos distintos no cambia maestro ni historial", async (t) => {
  const ctx = escenario();
  t.after(() => rmSync(ctx.directory, { recursive: true, force: true }));
  assert.equal(json(await registrar.execute({ mensaje_id: "msg-001" }, ctx)).ok, true);
  const maestro = leerMaestro(ctx.directory);
  const f = maestro.find((f) => f.id_contrato === "CT-2026-015")!;
  Object.assign(f, { pais: "EC", estado_poliza: "vigente", comercial: "Otra persona" });
  escribirMaestro(ctx.directory, maestro);
  const antes = maestroCrudo(ctx.directory);
  const historia = historial(ctx.directory);
  const r = json(await registrar.execute({ mensaje_id: "msg-001" }, ctx));
  assert.equal(r.data?.accion, "duplicado");
  assert.equal(maestroCrudo(ctx.directory), antes);
  assert.equal(historial(ctx.directory), historia);
});

test("RN2 real: cambio de valor sin nueva evidencia de póliza conserva vigente", async (t) => {
  const ctx = escenario();
  t.after(() => rmSync(ctx.directory, { recursive: true, force: true }));
  await registrar.execute({ mensaje_id: "msg-001" }, ctx);
  const maestro = leerMaestro(ctx.directory);
  Object.assign(maestro.find((f) => f.id_contrato === "CT-2026-015")!, { valor: "200000000", estado_poliza: "vigente" });
  escribirMaestro(ctx.directory, maestro);
  const r = json(await registrar.execute({ mensaje_id: "msg-001" }, ctx));
  assert.equal(r.data?.accion, "actualizacion");
  const f = leerMaestro(ctx.directory).find((f) => f.id_contrato === "CT-2026-015")!;
  assert.equal(f.valor, "265000000");
  assert.equal(f.estado_poliza, "vigente");
  const ultimo = JSON.parse(historial(ctx.directory).trim().split("\n").at(-1)!) as { cambios: Record<string, unknown> };
  assert.deepEqual(Object.keys(ultimo.cambios), ["valor"]);
});

test("RN2 real: repetir otrosí no crea otra fila, archivo ni historial vacío", async (t) => {
  const ctx = escenario();
  t.after(() => rmSync(ctx.directory, { recursive: true, force: true }));
  assert.equal(json(await registrar.execute({ mensaje_id: "msg-003" }, ctx)).data?.accion, "actualizacion");
  const antes = maestroCrudo(ctx.directory);
  const historia = historial(ctx.directory);
  const carpeta = join(ctx.directory, "out/sharepoint/Contratos/2026/minera-los-andes");
  const archivos = readdirSync(carpeta);
  assert.equal(json(await registrar.execute({ mensaje_id: "msg-003" }, ctx)).data?.accion, "duplicado");
  assert.equal(maestroCrudo(ctx.directory), antes);
  assert.equal(historial(ctx.directory), historia);
  assert.deepEqual(readdirSync(carpeta), archivos);
});

async function prepararIdAlternativo(ctx: ReturnType<typeof escenario>, valorNuevo = false): Promise<void> {
  const d = json(await extraer.execute({ mensaje_id: "msg-004" }, ctx)).data!;
  const maestro = leerMaestro(ctx.directory);
  maestro.find((f) => f.id_contrato === "CT-2026-012")!.objeto = String(d.objeto);
  escribirMaestro(ctx.directory, maestro);
  const archivo = join(ctx.directory, "fixtures/reto-02/buzon/msg-004/contrato.txt");
  let texto = readFileSync(archivo, "utf8").replaceAll("CT-2026-012", "CT-2026-099");
  if (valorNuevo) texto = texto.replace("210.000.000", "215.000.000");
  writeFileSync(archivo, texto);
}

for (const valorNuevo of [false, true]) {
  test(`HU-3 real: id alternativo requiere revisión; aprobación exacta ${valorNuevo ? "actualiza" : "descarta duplicado"} en destino mostrado`, async (t) => {
    const ctx = escenario();
    t.after(() => rmSync(ctx.directory, { recursive: true, force: true }));
    await prepararIdAlternativo(ctx, valorNuevo);
    const antes = maestroCrudo(ctx.directory);
    const r = json(await validar.execute({ mensaje_id: "msg-004" }, ctx));
    assert.equal(r.data?.clasificacion, valorNuevo ? "actualizacion" : "duplicado");
    assert.deepEqual(r.data?.requiere_revision, ["id_contrato"]);
    const bloqueado = json(await registrar.execute({ mensaje_id: "msg-004" }, ctx));
    assert.equal(bloqueado.ok, false);
    assert.equal(bloqueado.revision?.[0]?.valor_propuesto, "CT-2026-012");
    assert.match(bloqueado.revision?.[0]?.motivo ?? "", /CT-2026-099.*CT-2026-012/);
    assert.equal(maestroCrudo(ctx.directory), antes);
    assert.equal(historial(ctx.directory), "");
    const aprobado = json(await registrar.execute({ mensaje_id: "msg-004", confirmado: true, contrato: { id_contrato: "CT-2026-012" } }, ctx));
    assert.equal(aprobado.ok, true, aprobado.error ?? "");
    assert.equal(aprobado.data?.id_contrato, "CT-2026-012");
    assert.equal(aprobado.data?.accion, valorNuevo ? "actualizacion" : "duplicado");
    const final = leerMaestro(ctx.directory);
    assert.equal(final.length, 8);
    assert.ok(!final.some((f) => f.id_contrato === "CT-2026-099"));
    if (valorNuevo) {
      assert.equal(final.find((f) => f.id_contrato === "CT-2026-012")!.valor, "215000000");
      assert.match(historial(ctx.directory), /"id_contrato":"CT-2026-012"/);
    } else {
      assert.equal(maestroCrudo(ctx.directory), antes);
      assert.equal(historial(ctx.directory), "");
    }
  });
}

test("RN1 real: id alternativo y solo moneda distinta mantienen duplicado antes y después de aprobar destino", async (t) => {
  const ctx = escenario();
  t.after(() => rmSync(ctx.directory, { recursive: true, force: true }));
  await prepararIdAlternativo(ctx);
  const archivo = join(ctx.directory, "fixtures/reto-02/buzon/msg-004/contrato.txt");
  writeFileSync(archivo, readFileSync(archivo, "utf8").replace("COP $210.000.000", "USD 210.000.000"));
  const antes = maestroCrudo(ctx.directory);
  assert.equal(json(await validar.execute({ mensaje_id: "msg-004" }, ctx)).data?.clasificacion, "duplicado");
  const pendiente = json(await registrar.execute({ mensaje_id: "msg-004" }, ctx));
  assert.equal(pendiente.ok, false);
  assert.equal(pendiente.revision?.[0]?.valor_propuesto, "CT-2026-012");
  const moneda = pendiente.revision?.find((c) => c.campo === "moneda");
  assert.equal(moneda?.valor_propuesto, "COP");
  assert.match(moneda?.motivo ?? "", /fuente propone USD.*maestro.*COP.*conserva COP/);
  const r = json(await registrar.execute({ mensaje_id: "msg-004", confirmado: true, contrato: { id_contrato: "CT-2026-012", moneda: "COP" } }, ctx));
  assert.equal(r.data?.accion, "duplicado");
  assert.equal(maestroCrudo(ctx.directory), antes);
  assert.equal(historial(ctx.directory), "");
});

test("RN1: la discrepancia de moneda por el mismo id también exige decisión de conservar maestro", () => {
  const r = clasificar(extraccion({ moneda: "USD" }), [fila]);
  assert.equal(r.clasificacion, "duplicado");
  assert.deepEqual(r.requiere_revision, ["moneda"]);
  assert.equal(r.valores_revision?.moneda, "COP");
  assert.match(r.motivos_revision?.moneda ?? "", /USD.*COP.*conserva COP/);
});

test("HU-3 real: identidad ambigua sigue en revisión incluso con confirmado:true", async (t) => {
  const ctx = escenario();
  t.after(() => rmSync(ctx.directory, { recursive: true, force: true }));
  await prepararIdAlternativo(ctx);
  const maestro = leerMaestro(ctx.directory);
  maestro.push({ ...maestro.find((f) => f.id_contrato === "CT-2026-012")!, id_contrato: "CT-2026-013" });
  escribirMaestro(ctx.directory, maestro);
  const antes = maestroCrudo(ctx.directory);
  for (const confirmado of [false, true]) {
    const r = json(await registrar.execute({ mensaje_id: "msg-004", confirmado }, ctx));
    assert.equal(r.ok, false);
    assert.match(r.revision?.[0]?.motivo ?? "", /Identidad ambigua/);
    assert.equal(maestroCrudo(ctx.directory), antes);
    assert.equal(historial(ctx.directory), "");
  }
});

test("HU-3 real: colisión de NIT por id no sobrescribe el maestro sin revisión", async (t) => {
  const ctx = escenario();
  t.after(() => rmSync(ctx.directory, { recursive: true, force: true }));
  const archivo = join(ctx.directory, "fixtures/reto-02/buzon/msg-004/contrato.txt");
  writeFileSync(archivo, readFileSync(archivo, "utf8").replace("890.903.456-1", "123.456.789-1"));
  const antes = leerMaestro(ctx.directory);
  const r = json(await registrar.execute({ mensaje_id: "msg-004" }, ctx));
  assert.equal(r.ok, false);
  assert.ok(r.revision?.some((c) => c.campo === "nit_cliente" && c.valor_propuesto === "123456789" && /no es compatible/.test(c.motivo)));
  assert.deepEqual(leerMaestro(ctx.directory), antes);
  assert.equal(historial(ctx.directory), "");
});

test("PRD 7.2: solo IDs contractuales y AUTO-año-secuencia tienen formato registrable", () => {
  for (const id of ["CT-2026-01", "CM-2026-123", "AUTO-2026-001", "AUTO-2026-1000"]) assert.equal(idContratoSchema.safeParse(id).success, true, id);
  for (const id of ["cualquiera", "AUTO-2026-1", "AUTO-x-001", "AUTO-2026-001/../../", "CT-2026-1234"]) assert.equal(idContratoSchema.safeParse(id).success, false, id);
});

function quitarId(ctx: ReturnType<typeof escenario>): void {
  const archivo = join(ctx.directory, "fixtures/reto-02/buzon/msg-001/contrato.txt");
  writeFileSync(archivo, readFileSync(archivo, "utf8").replaceAll("CT-2026-015", "sin número"));
}

test("PRD 7.2 real: documento sin id requiere aprobación exacta del AUTO propuesto y no se duplica al repetir", async (t) => {
  const ctx = escenario();
  t.after(() => rmSync(ctx.directory, { recursive: true, force: true }));
  quitarId(ctx);
  const pendiente = json(await registrar.execute({ mensaje_id: "msg-001" }, ctx));
  assert.equal(pendiente.ok, false);
  const campo = pendiente.revision?.find((c) => c.campo === "id_contrato");
  assert.equal(campo?.valor_propuesto, "AUTO-2026-001");
  assert.equal(json(await registrar.execute({ mensaje_id: "msg-001", confirmado: true }, ctx)).ok, false);
  const aprobado = json(await registrar.execute({ mensaje_id: "msg-001", confirmado: true, contrato: { id_contrato: "AUTO-2026-001" } }, ctx));
  assert.equal(aprobado.ok, true, aprobado.error ?? "");
  assert.equal(aprobado.data?.id_contrato, "AUTO-2026-001");
  const antes = maestroCrudo(ctx.directory);
  const historia = historial(ctx.directory);
  const repetido = json(await registrar.execute({ mensaje_id: "msg-001" }, ctx));
  assert.equal(repetido.ok, false);
  assert.equal(repetido.revision?.find((c) => c.campo === "id_contrato")?.valor_propuesto, "AUTO-2026-001");
  assert.equal(json(await registrar.execute({ mensaje_id: "msg-001", confirmado: true, contrato: { id_contrato: "AUTO-2026-001" } }, ctx)).data?.accion, "duplicado");
  assert.equal(maestroCrudo(ctx.directory), antes);
  assert.equal(historial(ctx.directory), historia);
});

test("PRD 7.2 real: AUTO generado que colisiona no sobrescribe otra identidad ni siquiera confirmado", async (t) => {
  const ctx = escenario();
  t.after(() => rmSync(ctx.directory, { recursive: true, force: true }));
  quitarId(ctx);
  const maestro = leerMaestro(ctx.directory);
  maestro.push({ ...maestro[0]!, id_contrato: "AUTO-2026-001", objeto: "Auditoría tributaria" }, { ...maestro[0]!, id_contrato: "AUTO-2026-003", objeto: "Gestión de cobranzas" });
  escribirMaestro(ctx.directory, maestro);
  const antes = maestroCrudo(ctx.directory);
  const r = json(await registrar.execute({ mensaje_id: "msg-001", confirmado: true, contrato: { id_contrato: "AUTO-2026-003" } }, ctx));
  assert.equal(r.ok, false);
  assert.match(r.revision?.find((c) => c.campo === "id_contrato")?.motivo ?? "", /generado.*ya pertenece a otro contrato/);
  assert.equal(maestroCrudo(ctx.directory), antes);
  assert.equal(historial(ctx.directory), "");
  assert.equal(json(await registrar.execute({ mensaje_id: "msg-001", confirmado: true, contrato: { id_contrato: "AUTO-2026-004" } }, ctx)).ok, true);
  assert.equal(leerMaestro(ctx.directory).length, 11);
});
