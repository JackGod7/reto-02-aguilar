import { test } from "node:test";
import assert from "node:assert/strict";
import { construirPregunta, evaluarConfirmacion, usuarioConfirma } from "../../src/agent/run.ts";
import type { NeedsConfirmation } from "../../src/agent/session.ts";

const revision = (id: string): NeedsConfirmation => {
  const campos = [{ campo: "valor", valor_propuesto: 0, confianza: 0.5, motivo: "indeterminado" }];
  return { mensaje_id: id, campos, pregunta: construirPregunta(id, campos) };
};

test("usuarioConfirma acepta solo confirmaciones afirmativas explícitas", () => {
  for (const t of ["confirmo", "Sí, confirmo", "si, adelante", "ok", "apruebo el registro", "acepto", "registra el contrato", "ok, confirmo el valor 0"]) {
    assert.equal(usuarioConfirma(t), true, t);
  }
});

test("usuarioConfirma rechaza preguntas, condicionales, negaciones y texto neutro", () => {
  for (const t of ["¿confirmas?", "puedes confirmar?", "si el valor es correcto, confirma", "si confirmo qué pasa", "no confirmo", "cancela, ok", "rechazo", "dame más info", "confirmas"]) {
    assert.equal(usuarioConfirma(t), false, t);
  }
});

test("evaluarConfirmacion: exige revisión vista, confirmación explícita y mensaje_id si hay varias", () => {
  const p6 = revision("msg-006");
  const una = new Map([["msg-006", p6]]);
  const args = { mensaje_id: "msg-006", confirmado: true };

  assert.deepEqual(evaluarConfirmacion(args, "confirmo", una, new Set(["msg-006"])), { permitido: true });
  assert.equal(evaluarConfirmacion(args, "¿confirmas?", una, new Set(["msg-006"])).permitido, false);
  assert.equal(evaluarConfirmacion(args, "confirmo", una, new Set()).permitido, false, "revisión creada en este turno: no vista");
  assert.equal(evaluarConfirmacion({ mensaje_id: "msg-099", confirmado: true }, "confirmo", una, new Set(["msg-006"])).permitido, false);

  const dos = new Map([["msg-006", p6], ["msg-007", revision("msg-007")]]);
  const vistas = new Set(["msg-006", "msg-007"]);
  assert.equal(evaluarConfirmacion(args, "confirmo", dos, vistas).permitido, false, "varias pendientes sin nombrar id");
  assert.equal(evaluarConfirmacion(args, "confirmo msg-006", dos, vistas).permitido, true);
});

test("evaluarConfirmacion rechaza overrides de campos fuera de la revisión", () => {
  const una = new Map([["msg-006", revision("msg-006")]]);
  const d = evaluarConfirmacion({ mensaje_id: "msg-006", confirmado: true, contrato: { valor: 1, cliente: "X" } }, "confirmo", una, new Set(["msg-006"]));
  assert.equal(d.permitido, false);
  assert.match(d.permitido ? "" : d.error, /cliente/);
});
