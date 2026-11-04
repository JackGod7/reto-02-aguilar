import test from "node:test";
import assert from "node:assert/strict";
import { log } from "../../src/infra/log.ts";

function capturar(fn: () => void): string {
  const original = process.stdout.write;
  let salida = "";
  process.stdout.write = ((c: string | Uint8Array) => { salida += String(c); return true; }) as typeof process.stdout.write;
  try { fn(); } finally { process.stdout.write = original; }
  return salida;
}

test("Dado un evento con campos, Cuando se registra, Entonces sale una sola línea JSON con ts, nivel, evento y los campos", () => {
  const salida = capturar(() => log("info", "http", { sessionId: "s1", status: 200, ms: 5 }));
  assert.equal(salida.split("\n").filter(Boolean).length, 1);
  const l = JSON.parse(salida) as Record<string, unknown>;
  assert.deepEqual({ nivel: l.nivel, evento: l.evento, sessionId: l.sessionId, status: l.status, ms: l.ms }, { nivel: "info", evento: "http", sessionId: "s1", status: 200, ms: 5 });
  assert.ok(!Number.isNaN(Date.parse(String(l.ts))));
});

test("Dado ANTHROPIC_API_KEY en el entorno, Cuando se registra un evento, Entonces la línea no contiene la clave", () => {
  const previa = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-secreto-de-prueba";
  try {
    const salida = capturar(() => log("warn", "tool", { herramienta: "contratos_extraer", ok: false }));
    assert.ok(!salida.includes("sk-ant-secreto-de-prueba"));
  } finally {
    if (previa === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previa;
  }
});
