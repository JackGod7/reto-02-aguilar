import test from "node:test";
import assert from "node:assert/strict";
import { parseDinero, extraerDinero } from "../../src/domain/dinero.ts";
import { addMonths, parseFechaEs, diasEntre } from "../../src/domain/fechas.ts";
import { slugCliente } from "../../src/domain/slug.ts";
import { parsearCsv, serializarCsv } from "../../src/domain/csv.ts";
import { readFileSync } from "node:fs";

test("dinero: formatos COP/USD/PEN", () => {
  assert.equal(parseDinero("265.000.000"), 265000000);
  assert.equal(parseDinero("120,000.00"), 120000);
  assert.equal(parseDinero("520,000.00"), 520000);
  assert.equal(parseDinero("1.234,56"), 1234.56);
  assert.equal(parseDinero("1,5"), 1.5);
  assert.equal(parseDinero("abc"), null);
  assert.deepEqual(extraerDinero("(COP $265.000.000), IVA"), { moneda: "COP", valor: 265000000 });
  assert.deepEqual(extraerDinero("(USD 120,000.00)"), { moneda: "USD", valor: 120000 });
});

test("fechas en español", () => {
  assert.equal(parseFechaEs("primero (1) de agosto de 2026"), "2026-08-01");
  assert.equal(parseFechaEs("treinta y uno (31) de julio de 2027"), "2027-07-31");
  assert.equal(parseFechaEs("27 de agosto de 2026"), "2026-08-27");
  assert.equal(parseFechaEs("sin fecha"), null);
  assert.equal(addMonths("2026-08-31", 12), "2027-08-31");
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(diasEntre("2026-09-03", "2026-09-30"), 27);
});

test("slug reproduce las 8 rutas del maestro", () => {
  const filas = parsearCsv(readFileSync("fixtures/reto-02/maestro-contratos.csv", "utf8"));
  const cab = filas[0] ?? [];
  const ci = cab.indexOf("cliente");
  const ri = cab.indexOf("ruta_sharepoint");
  const datos = filas.slice(1);
  assert.equal(datos.length, 8);
  for (const f of datos) {
    const partes = (f[ri] ?? "").split("/");
    assert.equal(slugCliente(f[ci] ?? ""), partes[2], f[ci]);
  }
});

test("csv: fórmula y comas se releen igual y quedan neutralizadas", () => {
  const celdas = ['=HYPERLINK("http://x","y")', "a, b", 'con "comillas"', "multi\nlinea", "+1", "@cmd", "-2"];
  const texto = serializarCsv([["h1", "h2", "h3", "h4", "h5", "h6", "h7"], celdas]);
  assert.ok(texto.includes("'=HYPERLINK"), "prefijo ' en crudo");
  const back = parsearCsv(texto);
  assert.deepEqual(back[1], celdas);
  for (const linea of texto.split("\n").slice(1)) assert.ok(!/^[=+\-@]/.test(linea));
});
