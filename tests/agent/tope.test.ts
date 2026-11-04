import { test } from "node:test";
import assert from "node:assert/strict";
import { ejecutarTurno, MAX_PASOS, resumir } from "../../src/agent/run.ts";
import { crearSesion } from "../../src/agent/session.ts";
import type { Herramienta, LLMAdapter } from "../../src/llm/adapter.ts";

const base = () => ({ session: crearSesion(), directory: process.cwd(), prompt: "p", maxTokens: 1000 });
const ok = (data: unknown) => JSON.stringify({ ok: true, data });

test("tope: adapter que devuelve texto vacío y 25 pasos -> reply determinista, nunca 'Listo.'", async () => {
  const adapter: LLMAdapter = {
    provider: "mock", model: "m",
    async enviar(_m, h: Herramienta[]) {
      await h.find((x) => x.name === "contratos_leer_buzon")!.execute({});
      return { texto: "", pasos: 25, tokens: 1 };
    },
  };
  const r = await ejecutarTurno({ ...base(), adapter, message: "procesa", runTool: async () => ok({ mensajes: [{}, {}] }) });
  assert.match(r.reply, new RegExp(`^Alcancé el tope de ${MAX_PASOS} pasos\\. Hecho: .*leer_buzon.*2 mensajes.*\\. Falta: .*\\. Escribe 'continúa' para seguir\\.`));
  assert.notEqual(r.reply, "Listo.");
});

test("tope: el ejecutor rechaza llamadas por encima de MAX_PASOS aunque el adapter no lo honre", async () => {
  let ejecutadas = 0;
  const adapter: LLMAdapter = {
    provider: "mock", model: "m",
    async enviar(_m, h) {
      const t = h.find((x) => x.name === "contratos_leer_buzon")!;
      const ultimas: string[] = [];
      for (let i = 0; i < MAX_PASOS + 3; i++) ultimas.push(await t.execute({}));
      assert.equal(JSON.parse(ultimas.at(-1)!).error, "tope de pasos");
      return { texto: "x", pasos: 1, tokens: 1 };
    },
  };
  await ejecutarTurno({ ...base(), adapter, message: "m", runTool: async () => { ejecutadas++; return ok({ mensajes: [] }); } });
  assert.equal(ejecutadas, MAX_PASOS);
});

test("resumen: un toolCall ok no tiene resumen 'ok' y es específico por herramienta", () => {
  assert.equal(resumir("contratos_leer_buzon", { ok: true, data: { mensajes: [1, 2, 3] } }), "3 mensajes");
  assert.match(resumir("contratos_extraer", { ok: true, data: { tiene_contrato: true, confianza: { valor: 0.5, cliente: 0.9 } } }, { mensaje_id: "msg-006" }), /msg-006.*2 campos.*0\.50/);
  assert.match(resumir("contratos_validar", { ok: true, data: { clasificacion: "nuevo", requiere_revision: ["valor"] } }), /nuevo.*valor/);
  assert.match(resumir("contratos_registrar", { ok: true, data: { accion: "nuevo", id_contrato: "AB-2026-1", ruta_archivo: "out/x" } }), /nuevo AB-2026-1.*out\/x/);
  assert.match(resumir("contratos_alertas", { ok: true, data: { vencen: [1], vencidos: [], polizas_pendientes: [1, 2], registrados_desde_corte: [] } }), /vencen 1.*vencidos 0.*pólizas pendientes 2/);
  assert.equal(resumir("contratos_otra", { ok: true, data: { a: "x".repeat(400) } }).length <= 160, true);
  assert.equal(resumir("contratos_registrar", { ok: false, error: "boom" }), "boom");
});
