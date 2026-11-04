// Evals con el modelo REAL contra un servidor local (nunca producción).
// Uso:
//   node scripts/evals.ts [--model haiku|sonnet] [--runs 3] [--max-tokens-total 1500000] [--only HU-4,RN5] [--json salida.json] [--env-file .env]
//   node scripts/evals.ts --matriz resultados-haiku.json [resultados-sonnet.json]   (imprime evals/MATRIZ.md)
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";
import { ChatAnthropic } from "@langchain/anthropic";
import { crearServidor } from "../src/server.ts";
import { crearAnthropicAdapter, type FactoriaAnthropic } from "../src/llm/anthropic.ts";
import { criterios, type Contexto, type Criterio, type Ejecucion, type RespuestaChat, type Resultado, type Turno } from "../evals/casos.ts";

const MODELOS: Record<string, { id: string; entrada: number; salida: number }> = {
  // USD por millón de tokens (precios públicos de Anthropic)
  haiku: { id: "claude-haiku-5-5", entrada: 0.10, salida: 0.50 },
  sonnet: { id: "claude-sonnet-5-5", entrada: 2.00, salida: 10.00 },
};

interface Fila { id: string; caracteristica: string; prd: number; gherkin: string; critico: boolean; codigo: string[]; tests: string[]; pasa: number; runs: number; fallos: string[]; evidencia: string[] }
interface Informe { modelo: string; runs: number; tokens: { entrada: number; salida: number }; costoUSD: number; filas: Fila[] }

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
  model: { type: "string", default: "haiku" },
  runs: { type: "string", default: "3" },
  "max-tokens-total": { type: "string", default: "1500000" },
  only: { type: "string" },
  json: { type: "string" },
  matriz: { type: "boolean", default: false },
  "env-file": { type: "string", default: ".env" },
} });

if (o.matriz) {
  process.stdout.write(matriz(positionals.map((p) => JSON.parse(readFileSync(p, "utf8")) as Informe)));
  process.exit(0);
}

const modelo = MODELOS[o.model ?? ""];
const runs = Number(o.runs);
const tope = Number(o["max-tokens-total"]);
if (!modelo || !Number.isSafeInteger(runs) || runs < 1 || !Number.isSafeInteger(tope) || tope < 1) {
  console.error("Uso: node scripts/evals.ts --model haiku|sonnet --runs N --max-tokens-total N [--only HU-4,RN5]");
  process.exit(2);
}
if (!process.env.ANTHROPIC_API_KEY) {
  try { process.loadEnvFile(resolve(o["env-file"] ?? ".env")); } catch { /* se reporta abajo */ }
}
const clave = process.env.ANTHROPIC_API_KEY ?? "";
if (!clave) { console.error("Falta ANTHROPIC_API_KEY (entorno o --env-file)."); process.exit(2); }

// El adapter real, envuelto solo para medir tokens/llamadas e inyectar fallos de transporte.
const uso = { entrada: 0, salida: 0, llamadas: 0, fallasPendientes: 0 };
const medir: FactoriaAnthropic = (config) => {
  const fallar = uso.fallasPendientes > 0;
  if (fallar) uso.fallasPendientes--;
  const real = new ChatAnthropic(fallar ? { ...config, anthropicApiUrl: "http://127.0.0.1:9" } : config);
  return {
    bindTools(h) {
      const atado = real.bindTools(h);
      return {
        async invoke(m, op) {
          uso.llamadas++;
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

function huellas(dir: string): Map<string, string> {
  const m = new Map<string, string>();
  const recorrer = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n); const rel = relative(dir, p);
      if (rel === "out") continue;
      if (statSync(p).isDirectory()) recorrer(p);
      else m.set(rel, createHash("sha256").update(readFileSync(p)).digest("hex"));
    }
  };
  recorrer(dir);
  return m;
}
function archivosOut(dir: string): string[] {
  const out = join(dir, "out"); const r: string[] = [];
  const recorrer = (d: string): void => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) recorrer(p); else r.push(readFileSync(p, "utf8")); } };
  if (existsSync(out)) recorrer(out);
  return r;
}
function conEnv<T>(env: Record<string, string> | undefined, fn: () => Promise<T>): Promise<T> {
  if (!env) return fn();
  const previo = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  return fn().finally(() => { for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

class TopeAlcanzado extends Error {}

async function ejecutar(e: Ejecucion): Promise<{ ctx: Contexto; dir: string; tokens: number; ms: number }> {
  const dir = mkdtempSync(join(tmpdir(), "reto-evals-"));
  cpSync(join(raiz, "fixtures"), join(dir, "fixtures"), { recursive: true });
  const maxSessionTokens = e.servidor?.maxSessionTokens ?? 200_000;
  const srv = crearServidor({ adapter, directory: dir, rateLimit: e.servidor?.rateLimit ?? 10_000, maxSessionTokens, maxDailyTokens: e.servidor?.maxDailyTokens, accessKey: e.servidor?.accessKey, webDir: join(raiz, "web") });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const antes = consumidos(); const inicio = Date.now();
  try {
    await e.preparar?.(dir);
    const huellaInicial = huellas(dir);
    uso.fallasPendientes = e.fallasProveedor ?? 0;
    const turnos: RespuestaChat[] = await conEnv(e.env, async () => {
      if (e.http) return e.http(base);
      const r: RespuestaChat[] = [];
      let sessionId = await nuevaSesion(base);
      for (const t of e.turnos ?? []) {
        if (consumidos() >= tope) throw new TopeAlcanzado(`tope de ${tope} tokens alcanzado`);
        const turno: Turno = typeof t === "string" ? { message: t } : t;
        if (turno.nuevaSesion) sessionId = null;
        const n0 = uso.llamadas;
        const res = await conEnv(turno.env, () => fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: turno.message, ...(sessionId ? { sessionId, requestId: turno.requestId ?? randomUUID() } : {}) }) }));
        const cuerpo = await res.text();
        const b = JSON.parse(cuerpo) as Partial<RespuestaChat> & { sessionId?: string };
        const proc = join(dir, "out/procesados.json");
        r.push({ status: res.status, reply: b.reply ?? "", toolCalls: b.toolCalls ?? [], needsConfirmation: b.needsConfirmation ?? null, error: b.error, cuerpo, llamadasModelo: uso.llamadas - n0, procesados: existsSync(proc) ? JSON.parse(readFileSync(proc, "utf8")) as string[] : [] });
      }
      return r;
    });
    const huellaFinal = huellas(dir);
    const cambios = [...new Set([...huellaInicial.keys(), ...huellaFinal.keys()])].filter((k) => huellaInicial.get(k) !== huellaFinal.get(k));
    const health = await (await fetch(`${base}/api/health`)).text();
    const claveFiltrada = [health, ...turnos.map((t) => t.cuerpo), ...archivosOut(dir)].some((s) => s.includes(clave));
    return { ctx: { dir, turnos, cambiosFueraDeOut: cambios, claveFiltrada, maxSessionTokens }, dir, tokens: consumidos() - antes, ms: Date.now() - inicio };
  } finally {
    uso.fallasPendientes = 0;
    srv.close();
  }
}
async function nuevaSesion(base: string): Promise<string | null> {
  const r = await fetch(`${base}/api/sessions`, { method: "POST" });
  return r.ok ? (await r.json() as { sessionId: string }).sessionId : null;
}

// ---------- ejecución ----------
const filtro = o.only?.split(",").map((s) => s.trim()).filter(Boolean);
const coincide = (c: Criterio) => !filtro || filtro.some((f) => c.id === f || c.id.startsWith(`${f}.`) || c.caracteristica === f);
const elegidos = criterios.filter(coincide);
const ejecuciones = [...new Set(elegidos.map((c) => c.ejecucion))];
const filas = new Map<string, Fila>(elegidos.map((c) => [c.id, { id: c.id, caracteristica: c.caracteristica, prd: c.prd, gherkin: c.gherkin, critico: c.critico, codigo: c.codigo, tests: c.tests, pasa: 0, runs: 0, fallos: [], evidencia: [] }]));
const medidas = new Map<string, { tokens: number; ms: number; n: number }>();
let topeAlcanzado = false;

console.log(`Modelo ${modelo.id} · runs=${runs} · tope=${tope} tokens · ${elegidos.length} criterios en ${ejecuciones.length} ejecuciones\n`);
for (let run = 1; run <= runs && !topeAlcanzado; run++) {
  for (const e of ejecuciones) {
    let r: Awaited<ReturnType<typeof ejecutar>> | undefined;
    let errorEjecucion: string | undefined;
    try { r = await ejecutar(e); } catch (err) {
      if (err instanceof TopeAlcanzado) { topeAlcanzado = true; console.log(`  ⛔ ${err.message}; se detiene la suite`); break; }
      errorEjecucion = `la ejecución ${e.id} lanzó: ${err instanceof Error ? err.message : String(err)}`;
    }
    const m = medidas.get(e.id) ?? { tokens: 0, ms: 0, n: 0 };
    if (r) medidas.set(e.id, { tokens: m.tokens + r.tokens, ms: m.ms + r.ms, n: m.n + 1 });
    for (const c of elegidos.filter((x) => x.ejecucion === e)) {
      let res: Resultado;
      if (!r) res = { fallos: [errorEjecucion ?? "sin resultado"], evidencia: [] };
      else { try { res = c.calificar(r.ctx); } catch (err) { res = { fallos: [`grader lanzó: ${err instanceof Error ? err.message : String(err)}`], evidencia: [] }; } }
      const f = filas.get(c.id);
      if (!f) continue;
      f.runs++;
      if (res.fallos.length === 0) f.pasa++;
      f.fallos.push(...res.fallos.map((x) => `run ${run}: ${x}`));
      f.evidencia.push(...res.evidencia.map((x) => `run ${run}: ${x}`));
      console.log(`${c.gherkin}\n  → ${res.fallos.length === 0 ? "PASA" : "FALLA"} (run ${run}${r ? `, ${r.tokens} tokens, ${(r.ms / 1000).toFixed(1)}s` : ""})`);
      for (const x of res.fallos) console.log(`    ✗ ${x}`);
      for (const x of res.evidencia) console.log(`    · ${x}`);
    }
    if (r) rmSync(r.dir, { recursive: true, force: true });
  }
}

const costoUSD = (uso.entrada * modelo.entrada + uso.salida * modelo.salida) / 1_000_000;
console.log(`\n${"criterio".padEnd(10)} ${"característica".padEnd(14)} crítico  resultado  ejecución              tokens/run  s/run`);
for (const c of elegidos) {
  const f = filas.get(c.id);
  const m = medidas.get(c.ejecucion.id);
  if (!f) continue;
  const estado = f.runs === 0 ? "sin correr" : f.pasa === f.runs ? `PASA ${f.pasa}/${f.runs}` : `FALLA ${f.pasa}/${f.runs}`;
  console.log(`${c.id.padEnd(10)} ${c.caracteristica.padEnd(14)} ${(c.critico ? "sí" : "no").padEnd(8)} ${estado.padEnd(10)} ${c.ejecucion.id.padEnd(22)} ${String(m ? Math.round(m.tokens / m.n) : 0).padStart(10)} ${m ? (m.ms / m.n / 1000).toFixed(1).padStart(6) : "     -"}`);
}
const criticoFalla = [...filas.values()].some((f) => f.critico && (f.runs === 0 || f.pasa < f.runs));
console.log(`\nTokens: entrada ${uso.entrada} · salida ${uso.salida} · total ${consumidos()} · llamadas al modelo ${uso.llamadas}`);
console.log(`Costo estimado: US$ ${costoUSD.toFixed(4)} (${modelo.id}, precio de lista sin descuento de caché)`);
console.log(criticoFalla ? "Resultado: FALLA algún criterio crítico" : "Resultado: todos los críticos pasan");
if (o.json) writeFileSync(o.json, JSON.stringify({ modelo: modelo.id, runs, tokens: { entrada: uso.entrada, salida: uso.salida }, costoUSD, filas: [...filas.values()] } satisfies Informe, null, 2));
process.exit(criticoFalla ? 1 : 0);

// ---------- matriz de trazabilidad ----------
function matriz(informes: Informe[]): string {
  const res = (inf: Informe, id: string): string => {
    const f = inf.filas.find((x) => x.id === id);
    return !f || f.runs === 0 ? "—" : `${f.pasa === f.runs ? "✅" : "❌"} ${f.pasa}/${f.runs}`;
  };
  const lineas: string[] = [
    "# Matriz de trazabilidad PRD → tests → evals con modelo real",
    "",
    "Generada por `node scripts/evals.ts --matriz <resultados.json>…`. Graders deterministas (`evals/casos.ts`); nunca un LLM juez.",
    `Modelos: ${informes.map((i) => `${i.modelo} (${i.runs} runs, US$ ${i.costoUSD.toFixed(4)})`).join(" · ")}.`,
    "",
  ];
  const huecos: string[] = [];
  const caracteristicas = [...new Set(criterios.map((c) => c.caracteristica))];
  for (const car of caracteristicas) {
    lineas.push(`## Característica: ${car}`, "", `| Escenario | PRD | Mecanismo (código) | Test unitario (simulado) | Eval real | ${informes.map((i) => i.modelo).join(" | ")} |`, `|---|---|---|---|---|${informes.map(() => "---").join("|")}|`);
    for (const c of criterios.filter((x) => x.caracteristica === car)) {
      const titulo = c.gherkin.split("\n")[0]?.replace(/^Escenario: /, "") ?? c.id;
      lineas.push(`| ${titulo} | [L${c.prd}](../docs/PRD.md#L${c.prd}) | ${c.codigo.map((x) => `\`${x}\``).join("<br>")} | ${c.tests.length ? c.tests.map((x) => `\`${x}\``).join("<br>") : "**hueco**"} | \`${c.id}\` | ${informes.map((i) => res(i, c.id)).join(" | ")} |`);
      if (c.tests.length === 0) huecos.push(`${c.id}: sin test unitario`);
    }
    lineas.push("");
  }
  lineas.push("## Escenarios (Gherkin)", "");
  for (const c of criterios) lineas.push("```gherkin", c.gherkin, "```", "");
  lineas.push("## Fallos y evidencia", "");
  for (const i of informes) for (const f of i.filas.filter((x) => x.pasa < x.runs)) lineas.push(`- **${f.id}** (${i.modelo}, ${f.pasa}/${f.runs}): ${f.fallos.slice(0, 3).join(" · ")}`);
  lineas.push("", "## Huecos", "", "Criterios con eval pero sin test unitario:", "", ...(huecos.length ? huecos.map((h) => `- ${h}`) : ["- ninguno"]), "", "Criterios del PRD sin eval con modelo real (no dependen del modelo o no son observables por la API):", "", "| Criterio | PRD | Test unitario | Por qué no hay eval real |", "|---|---|---|---|", ...SIN_EVAL.map((x) => `| ${x.criterio} | [L${x.prd}](../docs/PRD.md#L${x.prd}) | ${x.tests.length ? x.tests.map((t) => `\`${t}\``).join("<br>") : "**hueco**"} | ${x.motivo} |`), "");
  return lineas.join("\n");
}

const SIN_EVAL: { criterio: string; prd: number; tests: string[]; motivo: string }[] = [
  { criterio: "CA3 · el front resalta la confirmación", prd: 209, tests: ["tests/agent/front.test.ts:111", "tests/agent/front-a7.test.ts:257"], motivo: "es UI; la API ya expone needsConfirmation (RN5.1)" },
  { criterio: "§6.2 · execute nunca lanza", prd: 190, tests: ["tests/agent/langchain-provider.test.ts:125", "tests/core/tools.test.ts:159"], motivo: "requiere forzar argumentos que el modelo real no emite (E1 de fallos-produccion.md)" },
  { criterio: "§6.4 · GET /api/sessions/:id y /api/health", prd: 220, tests: ["tests/agent/agent.test.ts:112"], motivo: "API sin modelo; /api/health se usa en S8.5" },
  { criterio: "§8 · Arranque en menos de 2 minutos", prd: 330, tests: [], motivo: "operativo (Docker/README), no del modelo" },
  { criterio: "§8 · Determinismo de demo.ts", prd: 331, tests: ["tests/core/tools.test.ts:90"], motivo: "demo.ts corre sin modelo" },
  { criterio: "§8 · Legibilidad (sin any, tsc)", prd: 335, tests: [], motivo: "lo verifica `npx tsc --noEmit`" },
  { criterio: "§8 · zod obligatorio en args", prd: 336, tests: ["tests/core/tools.test.ts:159"], motivo: "estático; S6.2.1 prueba el efecto" },
  { criterio: "HU-3 · NIT+objeto ≥0.9 y colisiones de id", prd: 296, tests: ["tests/core/clasificacion.test.ts:60", "tests/core/clasificacion.test.ts:247"], motivo: "los fixtures no traen ese caso; lógica determinista" },
];
