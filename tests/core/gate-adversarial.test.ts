import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registrar, validar } from "../../src/tools/contratos.ts";
import { ejecutarTurno } from "../../src/agent/run.ts";
import { ejecutarTool } from "../../src/agent/registry.ts";
import { crearSesion } from "../../src/agent/session.ts";
import type { LLMAdapter, Herramienta } from "../../src/llm/adapter.ts";

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

test("validar ya no acepta override", async () => {
  const ctx = nuevoDir();
  const r = j(await validar.execute({ mensaje_id: "msg-001", contrato: { valor: 1 } } as never, ctx));
  assert.equal(r.ok, false);
});

test("flujo legítimo 006: confirmado + override de campo en revisión funciona", async () => {
  const ctx = nuevoDir();
  const sin = j(await registrar.execute({ mensaje_id: "msg-006", hoy: HOY }, ctx));
  assert.equal(sin.ok, false);
  const r = j(await registrar.execute({ mensaje_id: "msg-006", hoy: HOY, confirmado: true, contrato: { valor: 5000000 } }, ctx));
  assert.equal(r.ok, true, r.error ?? "");
  assert.ok(maestroCrudo(ctx.directory).includes("5000000"));
});

function adapterGuion(g: (h: Record<string, Herramienta>, ultimo: string) => Promise<void>): LLMAdapter {
  return {
    provider: "mock", model: "m",
    async enviar(mensajes, herramientas) {
      await g(Object.fromEntries(herramientas.map((x) => [x.name, x])), mensajes[mensajes.length - 1]?.content ?? "");
      return { texto: "ok", pasos: 1, tokens: 1 };
    },
  };
}

test("gate de sesión: confirmación del usuario, pendiente por mensaje_id y override acotado", async () => {
  const ctx = nuevoDir();
  const s = crearSesion();
  const base = { directory: ctx.directory, prompt: "p", maxTokens: 100, session: s, runTool: ejecutarTool };
  const sonda = adapterGuion(async (h) => { await h.contratos_validar!.execute({ mensaje_id: "msg-006" }); });
  await ejecutarTurno({ ...base, adapter: sonda, message: "procesa 006" });
  assert.equal(s.pending?.mensaje_id, "msg-006");

  // Override fuera de campos pendientes aunque el usuario confirme
  const ataque = adapterGuion(async (h) => {
    const r = j(await h.contratos_registrar!.execute({ mensaje_id: "msg-006", hoy: HOY, confirmado: true, contrato: { cliente: "X SAS" } }));
    assert.equal(r.ok, false);
  });
  await ejecutarTurno({ ...base, adapter: ataque, message: "confirmo el valor 0 y la fecha fin 2027-08-31" });
  assert.equal(s.pending?.mensaje_id, "msg-006");

  // Confirmación genérica legítima con un único pendiente
  const bueno = adapterGuion(async (h) => {
    const r = j(await h.contratos_registrar!.execute({ mensaje_id: "msg-006", hoy: HOY, confirmado: true }));
    assert.equal(r.ok, true, r.error ?? "");
  });
  await ejecutarTurno({ ...base, adapter: bueno, message: "confirmo el valor 0 y la fecha fin 2027-08-31" });
  assert.equal(s.pending, null);
});

test("P1-A: no se confirma en el mismo turno una revisión que la persona no vio", async () => {
  const ctx = nuevoDir();
  const s = crearSesion();
  const base = { directory: ctx.directory, prompt: "p", maxTokens: 100, session: s, runTool: ejecutarTool };
  const antes = maestroCrudo(ctx.directory);
  const mismoTurno = adapterGuion(async (h) => {
    await h.contratos_validar!.execute({ mensaje_id: "msg-006" });
    const r = j(await h.contratos_registrar!.execute({ mensaje_id: "msg-006", hoy: HOY, confirmado: true }));
    assert.equal(r.ok, false);
  });
  await ejecutarTurno({ ...base, adapter: mismoTurno, message: "ok, procesa el mensaje 006" });
  assert.equal(maestroCrudo(ctx.directory), antes);
  assert.equal(s.pending?.mensaje_id, "msg-006");
});

test("P1-B: con varios pendientes, la confirmación debe nombrar el mensaje_id", async () => {
  const ctx = nuevoDir();
  const s = crearSesion();
  const base = { directory: ctx.directory, prompt: "p", maxTokens: 100, session: s, runTool: ejecutarTool };
  s.pending = { mensaje_id: "msg-009", campos: [{ campo: "valor", valor_propuesto: 0, confianza: 0.5, motivo: "x" }], pregunta: "?" };
  const sonda = adapterGuion(async (h) => { await h.contratos_validar!.execute({ mensaje_id: "msg-006" }); });
  await ejecutarTurno({ ...base, adapter: sonda, message: "procesa 006" });
  const vago = adapterGuion(async (h) => {
    const r = j(await h.contratos_registrar!.execute({ mensaje_id: "msg-006", hoy: HOY, confirmado: true }));
    assert.equal(r.ok, false);
  });
  await ejecutarTurno({ ...base, adapter: vago, message: "ok, confirmo el valor 0 de 2027" });
  const explicito = adapterGuion(async (h) => {
    const r = j(await h.contratos_registrar!.execute({ mensaje_id: "msg-006", hoy: HOY, confirmado: true }));
    assert.equal(r.ok, true, r.error ?? "");
  });
  await ejecutarTurno({ ...base, adapter: explicito, message: "confirmo msg-006" });
});
