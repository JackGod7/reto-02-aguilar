import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { crearServidor } from "../../src/server.ts";
import type { RespuestaChat } from "./tipos.ts";
import type { LlamadaLLM, LLMAdapter, PasoLLM } from "../../src/llm/adapter.ts";

// Integración M2↔M3: servidor + registry + tools REALES (solo el modelo está guionado).
const REAL = resolve(import.meta.dirname, "../..");
const dir = mkdtempSync(join(tmpdir(), "reto02-int-"));
cpSync(join(REAL, "fixtures"), join(dir, "fixtures"), { recursive: true });

const registrar = (id: string): LlamadaLLM => ({ id: `r-${id}`, name: "contratos_registrar", args: { mensaje_id: id, hoy: "2026-09-03" } });
const guion: PasoLLM[] = [
  { texto: "", llamadas: ["msg-001", "msg-002", "msg-003", "msg-004", "msg-005", "msg-006"].map(registrar), tokens: 10, usoConocido: true },
  { texto: "", llamadas: [{ id: "alertas", name: "contratos_alertas", args: { hoy: "2026-09-03" } }], tokens: 10, usoConocido: true },
  { texto: "006 registrado", llamadas: [], tokens: 10, usoConocido: true },
];
let paso = 0;
const adapter: LLMAdapter = { provider: "mock", model: "mock-1", async generarPaso() { return structuredClone(guion[paso++]!); } };

test("servidor con tools reales: para en 006 y registra tras confirmar", async () => {
  const srv = crearServidor({ adapter, prompt: "p", webDir: "web", directory: dir });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = (b: unknown) => fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json() as Promise<RespuestaChat>);
  try {
    const r1 = await post({ message: "procesa" });
    assert.equal(r1.needsConfirmation?.mensaje_id, "msg-006");
    assert.deepEqual(r1.needsConfirmation!.campos.map((c) => c.campo), ["valor", "fecha_fin"]);
    const r2 = await post({ sessionId: r1.sessionId, message: "confirmo el valor 0 y la fecha fin 2027-08-31" });
    assert.equal(r2.needsConfirmation, null);
    assert.ok(r2.toolCalls.some((c) => c.name === "contratos_registrar" && c.ok));
    const md = readFileSync(join(dir, "out", "alertas.md"), "utf8");
    assert.match(md, /CM-2026-03/);
    assert.match(readFileSync(join(dir, "out", "sharepoint", "maestro-contratos.csv"), "utf8"), /CM-2026-03/);
  } finally {
    srv.close();
  }
});
