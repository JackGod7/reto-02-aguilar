// Evals con el modelo REAL contra un servidor local (nunca producción).
// Uso: node scripts/evals.ts [--model haiku|sonnet] [--runs 3] [--max-tokens-total 400000] [--solo id,id] [--env-file .env]
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";
import { ChatAnthropic } from "@langchain/anthropic";
import { crearServidor } from "../src/server.ts";
import { crearAnthropicAdapter, type FactoriaAnthropic } from "../src/llm/anthropic.ts";
import { casos, type RespuestaChat } from "../evals/casos.ts";

const MODELOS: Record<string, { id: string; entrada: number; salida: number }> = {
  // USD por millón de tokens (precios públicos de Anthropic)
  haiku: { id: "claude-haiku-5-5", entrada: 0.10, salida: 0.50 },
  sonnet: { id: "claude-sonnet-5-5", entrada: 2.00, salida: 10.00 },
};

const { values: o } = parseArgs({ options: {
  model: { type: "string", default: "haiku" },
  runs: { type: "string", default: "3" },
  "max-tokens-total": { type: "string", default: "400000" },
  solo: { type: "string" },
  "env-file": { type: "string", default: ".env" },
} });
const modelo = MODELOS[o.model ?? ""];
const runs = Number(o.runs);
const tope = Number(o["max-tokens-total"]);
if (!modelo || !Number.isSafeInteger(runs) || runs < 1 || !Number.isSafeInteger(tope) || tope < 1) {
  console.error("Uso: node scripts/evals.ts --model haiku|sonnet --runs N --max-tokens-total N");
  process.exit(2);
}
if (!process.env.ANTHROPIC_API_KEY) {
  try { process.loadEnvFile(resolve(o["env-file"] ?? ".env")); } catch { /* se reporta abajo */ }
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Falta ANTHROPIC_API_KEY (entorno o --env-file).");
  process.exit(2);
}

// Medición de entrada/salida para el costo: envuelve el modelo real sin cambiar el adapter.
const uso = { entrada: 0, salida: 0 };
const medir: FactoriaAnthropic = (config) => {
  const real = new ChatAnthropic(config);
  return {
    bindTools(h) {
      const atado = real.bindTools(h);
      return {
        async invoke(m, op) {
          const r = await atado.invoke(m, op);
          uso.entrada += r.usage_metadata?.input_tokens ?? 0;
          uso.salida += r.usage_metadata?.output_tokens ?? 0;
          return r;
        },
      };
    },
  };
};
const adapter = crearAnthropicAdapter({ ...process.env, LLM_MODEL: modelo.id }, medir);
const raiz = resolve(import.meta.dirname, "..");
const consumidos = (): number => uso.entrada + uso.salida;

async function correr(caso: (typeof casos)[number]): Promise<{ fallos: string[]; tokens: number; ms: number }> {
  const dir = mkdtempSync(join(tmpdir(), "reto-evals-"));
  cpSync(join(raiz, "fixtures"), join(dir, "fixtures"), { recursive: true });
  const srv = crearServidor({ adapter, directory: dir, rateLimit: 10_000, maxSessionTokens: 200_000, webDir: join(raiz, "web") });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const antes = consumidos();
  const inicio = Date.now();
  try {
    await caso.preparar?.(dir);
    const { sessionId } = await (await fetch(`${base}/api/sessions`, { method: "POST" })).json() as { sessionId: string };
    const turnos: RespuestaChat[] = [];
    for (const message of caso.turnos) {
      if (consumidos() >= tope) return { fallos: [`tope de ${tope} tokens alcanzado antes del turno ${turnos.length + 1}`], tokens: consumidos() - antes, ms: Date.now() - inicio };
      const res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, message, requestId: randomUUID() }) });
      const body = await res.json() as Omit<RespuestaChat, "status">;
      turnos.push({ status: res.status, reply: body.reply ?? "", toolCalls: body.toolCalls ?? [], needsConfirmation: body.needsConfirmation ?? null, usage: body.usage ?? { tokens: 0 }, error: body.error });
    }
    let fallos: string[];
    try { fallos = caso.calificar({ dir, turnos }); } catch (e) { fallos = [`grader lanzó: ${e instanceof Error ? e.message : String(e)}`]; }
    if (process.env.EVALS_VERBOSE && fallos.length > 0) {
      for (const [i, t] of turnos.entries()) console.error(`  [${caso.id} t${i + 1}] tools=${t.toolCalls.map((c) => `${c.name.replace("contratos_", "")}${c.ok ? "" : "✗"}(${JSON.stringify(c.args)})`).join(" ")}\n  reply=${JSON.stringify(t.reply.slice(0, 600))}`);
    }
    return { fallos, tokens: consumidos() - antes, ms: Date.now() - inicio };
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const elegidos = o.solo ? casos.filter((c) => o.solo?.split(",").includes(c.id)) : casos;
const filas: string[] = [];
let criticoFalla = false;
console.log(`Modelo ${modelo.id} · runs=${runs} · tope=${tope} tokens\n`);
for (const caso of elegidos) {
  for (let i = 1; i <= runs; i++) {
    const r = await correr(caso);
    const pasa = r.fallos.length === 0;
    if (!pasa && caso.critico) criticoFalla = true;
    const fila = `${caso.id.padEnd(30)} ${String(i).padStart(3)}  ${(pasa ? "PASA" : "FALLA").padEnd(5)} ${(caso.critico ? "sí" : "no").padEnd(7)} ${String(r.tokens).padStart(8)} ${(r.ms / 1000).toFixed(1).padStart(7)}s`;
    filas.push(fila);
    console.log(fila);
    for (const f of r.fallos) console.log(`    - ${f}`);
  }
}
const costo = (uso.entrada * modelo.entrada + uso.salida * modelo.salida) / 1_000_000;
console.log(`\n${"caso".padEnd(30)} run  res.  crítico   tokens  latencia\n${filas.join("\n")}`);
console.log(`\nTokens: entrada ${uso.entrada} · salida ${uso.salida} · total ${consumidos()}`);
console.log(`Costo estimado: US$ ${costo.toFixed(4)} (${modelo.id}, sin descuento de caché)`);
console.log(criticoFalla ? "Resultado: FALLA algún caso crítico" : "Resultado: todos los críticos pasan");
process.exit(criticoFalla ? 1 : 0);
