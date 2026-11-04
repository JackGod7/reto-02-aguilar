import { test } from "node:test";
import assert from "node:assert/strict";
import { resumir } from "../../src/agent/graph.ts";

test("resumen: un toolCall ok no tiene resumen 'ok' y es específico por herramienta", () => {
  assert.equal(resumir("contratos_leer_buzon", { ok: true, data: { mensajes: [1, 2, 3] } }), "3 mensajes");
  assert.match(resumir("contratos_extraer", { ok: true, data: { tiene_contrato: true, confianza: { valor: 0.5, cliente: 0.9 } } }, { mensaje_id: "msg-006" }), /msg-006.*2 campos.*0\.50/);
  assert.match(resumir("contratos_validar", { ok: true, data: { clasificacion: "nuevo", requiere_revision: ["valor"] } }), /nuevo.*valor/);
  assert.match(resumir("contratos_registrar", { ok: true, data: { accion: "nuevo", id_contrato: "AB-2026-1", ruta_archivo: "out/x" } }), /nuevo AB-2026-1.*out\/x/);
  assert.match(resumir("contratos_alertas", { ok: true, data: { vencen: [1], vencidos: [], polizas_pendientes: [1, 2], registrados_desde_corte: [] } }), /vencen 1.*vencidos 0.*pólizas pendientes 2/);
  assert.equal(resumir("contratos_otra", { ok: true, data: { a: "x".repeat(400) } }).length <= 160, true);
  assert.equal(resumir("contratos_registrar", { ok: false, error: "boom" }), "boom");
});
