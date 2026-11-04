import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extraer, registrar, validar } from "../../src/tools/contratos.ts";

type Resultado = { ok: boolean; error?: string; data?: Record<string, unknown> };
const json = (s: string): Resultado => JSON.parse(s) as Resultado;
const raiz = resolve(import.meta.dirname, "../..");
const original = readFileSync(join(raiz, "fixtures/reto-02/buzon/msg-001/contrato.txt"), "utf8");

function escenario(texto = original) {
  const directory = mkdtempSync(join(tmpdir(), "reto-prd-domain-"));
  cpSync(join(raiz, "fixtures"), join(directory, "fixtures"), { recursive: true });
  writeFileSync(join(directory, "fixtures/reto-02/buzon/msg-001/contrato.txt"), texto);
  return { directory, sessionId: "prd-domain" };
}

test("HU-2c: los campos ausentes salen null con confianza 0; no hay valores inventados", async () => {
  const ctx = escenario(original.replace(/SEGUNDA\. VALOR\.[\s\S]*?\n\n/, ""));
  try {
    const r = json(await extraer.execute({ mensaje_id: "msg-001" }, ctx));
    assert.equal(r.ok, true);
    assert.equal(r.data!.valor, null);
    assert.equal(r.data!.moneda, null);
    const confianza = r.data!.confianza as Record<string, number>;
    for (const [campo, grado] of Object.entries(confianza)) if (grado === 0) assert.equal(r.data![campo], null, campo);
    assert.equal(confianza.valor, 0);
    assert.equal(confianza.moneda, 0);
    assert.equal(json(await registrar.execute({ mensaje_id: "msg-001" }, ctx)).ok, false);
    const sinCorreccion = json(await registrar.execute({ mensaje_id: "msg-001", confirmado: true }, ctx));
    assert.equal(sinCorreccion.ok, false);
    assert.match(sinCorreccion.error ?? "", /campos ausentes/);
    assert.equal(json(await registrar.execute({ mensaje_id: "msg-001", confirmado: true, contrato: { valor: 100, moneda: "COP" } }, ctx)).ok, true);
  } finally { rmSync(ctx.directory, { recursive: true, force: true }); }
});

for (const [nombre, texto, motivo] of [
  ["texto vacío", " \n ", /vacío/],
  ["fecha imposible", original.replace("(31) de julio de 2027", "(31) de febrero de 2027"), /Fecha inválida/],
  ["moneda desconocida", original.replace("(COP $265.000.000)", "(EUR 265.000.000)"), /Moneda desconocida/],
  ["moneda desconocida sin paréntesis", original.replace("(COP $265.000.000)", "EUR 265.000.000"), /Moneda desconocida/],
  ["moneda desconocida en minúsculas", original.replace("(COP $265.000.000)", "(eur 265.000.000)"), /Moneda desconocida/],
] as const) {
  test(`HU-6: ${nombre} devuelve ok:false y permite procesar el siguiente mensaje`, async () => {
    const ctx = escenario(texto);
    try {
      for (const tool of [extraer, validar, registrar]) {
        const r = json(await tool.execute({ mensaje_id: "msg-001" }, ctx));
        assert.equal(r.ok, false);
        assert.match(r.error ?? "", motivo);
      }
      assert.equal(json(await registrar.execute({ mensaje_id: "msg-002" }, ctx)).ok, true);
    } finally { rmSync(ctx.directory, { recursive: true, force: true }); }
  });
}

test("§7.2: objeto elimina el prefijo contractual antes del máximo de 200 caracteres", async () => {
  const ctx = escenario();
  try {
    const r = json(await extraer.execute({ mensaje_id: "msg-001" }, ctx));
    assert.match(String(r.data!.objeto), /^ejecutar la implementación/);
    assert.doesNotMatch(String(r.data!.objeto), /EL CONTRATISTA se obliga a/i);
    assert.ok(String(r.data!.objeto).length <= 200);
  } finally { rmSync(ctx.directory, { recursive: true, force: true }); }
});

test("§7.2: objeto largo conserva contenido útil al retirar introducción y prefijo", async () => {
  const contenido = "ejecutar la implementación y soporte de la plataforma " + "para usuarios de la entidad ".repeat(12);
  const texto = original.replace(/PRIMERA\. OBJETO\.[\s\S]*?\n\n/, `PRIMERA. OBJETO. El objeto es: EL CONTRATISTA se obliga a ${contenido}\n\n`);
  const ctx = escenario(texto);
  try {
    const r = json(await extraer.execute({ mensaje_id: "msg-001" }, ctx));
    assert.equal(r.ok, true);
    const objeto = String(r.data!.objeto);
    assert.ok(objeto.startsWith("ejecutar la implementación"));
    assert.ok(objeto.length <= 200);
    assert.ok(objeto.endsWith("…"));
    assert.ok(!objeto.includes("CONTRATISTA"));
  } finally { rmSync(ctx.directory, { recursive: true, force: true }); }
});

