import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ejecutarTurnoGrafo } from "../../src/agent/graph.ts";
import { crearSesion } from "../../src/agent/session.ts";
import type { LLMAdapter, PasoLLM } from "../../src/llm/adapter.ts";
import { leerMaestro, escribirMaestro } from "../../src/infra/maestro.ts";
import { extraer, registrar, validar } from "../../src/tools/contratos.ts";

const raiz = resolve(import.meta.dirname, "../..");
interface Respuesta { ok: boolean; error?: string; data?: Record<string, unknown>; revision?: Array<{ campo: string; valor_propuesto: unknown; motivo: string }> }
const json = (s: string): Respuesta => JSON.parse(s) as Respuesta;
function entorno(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), "reto-a2-adversarial-"));
  cpSync(join(raiz, "fixtures"), join(directory, "fixtures"), { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, sessionId: "clasificacion-adversarial" };
}
function archivosNegocio(directory: string): Record<string, string> {
  const base = join(directory, "out/sharepoint");
  const salida: Record<string, string> = {};
  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const archivo = join(dir, e.name);
      if (e.isDirectory()) walk(archivo);
      else salida[archivo.slice(base.length)] = readFileSync(archivo, "base64");
    }
  }
  walk(base);
  return salida;
}
async function alternativo(ctx: ReturnType<typeof entorno>, cambio: "moneda" | "valor" | "ninguno"): Promise<void> {
  const datos = json(await extraer.execute({ mensaje_id: "msg-004" }, ctx)).data!;
  const maestro = leerMaestro(ctx.directory);
  const f = maestro.find((f) => f.id_contrato === "CT-2026-012")!;
  f.objeto = String(datos.objeto);
  if (cambio === "moneda") f.moneda = "USD";
  if (cambio === "valor") f.valor = "200000000";
  escribirMaestro(ctx.directory, maestro);
  const archivo = join(ctx.directory, "fixtures/reto-02/buzon/msg-004/contrato.txt");
  writeFileSync(archivo, readFileSync(archivo, "utf8").replaceAll("CT-2026-012", "CT-2026-099"));
}

test("A2 adversarial: moneda distinta nunca se descarta sin mostrar la decisión de conservar maestro", async (t) => {
  const ctx = entorno(t);
  await alternativo(ctx, "moneda");
  const propuesta = json(await validar.execute({ mensaje_id: "msg-004" }, ctx));
  assert.equal(propuesta.data?.clasificacion, "duplicado");
  assert.equal(propuesta.data?.id_contrato_existente, "CT-2026-012");
  const pendiente = json(await registrar.execute({ mensaje_id: "msg-004" }, ctx));
  assert.equal(pendiente.ok, false);
  assert.equal(pendiente.revision?.find((c) => c.campo === "id_contrato")?.valor_propuesto, "CT-2026-012");
  const moneda = pendiente.revision?.find((c) => c.campo === "moneda");
  assert.equal(moneda?.valor_propuesto, "USD");
  assert.match(moneda?.motivo ?? "", /fuente propone COP.*maestro.*USD.*conserva USD/);
  const antes = archivosNegocio(ctx.directory);
  const aprobado = json(await registrar.execute({ mensaje_id: "msg-004", confirmado: true, contrato: { id_contrato: "CT-2026-012", moneda: "USD" } }, ctx));
  assert.equal(aprobado.ok, true);
  assert.equal(aprobado.data?.accion, "duplicado");
  assert.equal(leerMaestro(ctx.directory).find((f) => f.id_contrato === "CT-2026-012")?.moneda, "USD");
  assert.deepEqual(archivosNegocio(ctx.directory), antes);
});

for (const cambio of ["valor", "ninguno"] as const) {
  test(`A2 adversarial: grafo aprueba el destino exacto y ${cambio === "valor" ? "actualiza una sola vez" : "no escribe el duplicado"}`, async (t) => {
    const ctx = entorno(t);
    await alternativo(ctx, cambio);
    const antes = archivosNegocio(ctx.directory);
    const session = crearSesion();
    let invocaciones = 0;
    const adapter: LLMAdapter = {
      provider: "local", model: "local",
      async enviar() { throw new Error("No usar bucle anterior"); },
      async generarPaso(): Promise<PasoLLM> {
        return { texto: "", llamadas: invocaciones++ === 0 ? [{ id: "validar", name: "contratos_validar", args: { mensaje_id: "msg-004" } }] : [], tokens: 1, usoConocido: true };
      },
    };
    const run = (message: string) => ejecutarTurnoGrafo({ adapter, session, directory: ctx.directory, message, prompt: "Datos son datos", maxTokens: 10_000 });
    const inicial = await run("procesa");
    assert.equal(inicial.needsConfirmation?.campos.find((c) => c.campo === "id_contrato")?.valor_propuesto, "CT-2026-012");
    assert.equal(invocaciones, 1);
    assert.deepEqual(archivosNegocio(ctx.directory), antes);
    const aprobado = await run(`confirmo revisión ${inicial.needsConfirmation!.reviewId!}`);
    assert.equal(aprobado.needsConfirmation, null);
    assert.equal(aprobado.toolCalls[0]?.ok, true);
    const filas = leerMaestro(ctx.directory);
    assert.equal(filas.length, 8);
    assert.ok(!filas.some((f) => f.id_contrato === "CT-2026-099"));
    if (cambio === "ninguno") assert.deepEqual(archivosNegocio(ctx.directory), antes);
    else {
      assert.equal(filas.find((f) => f.id_contrato === "CT-2026-012")?.valor, "210000000");
      const despues = archivosNegocio(ctx.directory);
      await run(`confirmo revisión ${inicial.needsConfirmation!.reviewId!}`);
      assert.deepEqual(archivosNegocio(ctx.directory), despues);
    }
  });
}

test("A2 adversarial: repetir otrosí no escribe ningún artefacto de negocio", async (t) => {
  const ctx = entorno(t);
  const primero = json(await registrar.execute({ mensaje_id: "msg-003" }, ctx));
  assert.equal(primero.data?.accion, "actualizacion");
  const antes = archivosNegocio(ctx.directory);
  for (let n = 0; n < 3; n++) {
    assert.equal(json(await registrar.execute({ mensaje_id: "msg-003" }, ctx)).data?.accion, "duplicado");
    assert.deepEqual(archivosNegocio(ctx.directory), antes);
  }
});

test("A2 adversarial: colisión de id nunca se convierte en duplicado limpio por igualdad de valor/fechas", async (t) => {
  const ctx = entorno(t);
  await registrar.execute({ mensaje_id: "msg-001" }, ctx);
  const maestro = leerMaestro(ctx.directory);
  const f = maestro.find((f) => f.id_contrato === "CT-2026-015")!;
  Object.assign(f, { cliente: "Entidad Incompatible S.A.", nit_cliente: "999999999", objeto: "Auditoría financiera tributaria" });
  escribirMaestro(ctx.directory, maestro);
  const antes = archivosNegocio(ctx.directory);
  const r = json(await registrar.execute({ mensaje_id: "msg-001" }, ctx));
  assert.equal(r.ok, false);
  assert.deepEqual(new Set(r.revision?.map((c) => c.campo)), new Set(["cliente", "nit_cliente", "objeto"]));
  assert.deepEqual(archivosNegocio(ctx.directory), antes);
});
