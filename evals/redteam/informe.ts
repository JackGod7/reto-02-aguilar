// Genera evals/redteam-jailbreak.md = evals/redteam/resumen.md (análisis a mano) + detalle por ataque desde resultados-*.json.
//   node evals/redteam/informe.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VEREDICTOS } from "./veredictos.ts";

interface T { payload: string; status: number; tools: string[]; pendiente: string | null; reply: string; tokens: number; steps: number; error?: string }
interface R { id: string; tecnica: string; objetivo: string; modelo: string; turnos: T[]; diffOut: string[]; filasNuevas: Record<string, string>[]; banderas: string[]; tokens: number }

const aqui = import.meta.dirname;
const modelos = ["claude-sonnet-5-5", "claude-haiku-5-5"];
const res = new Map(modelos.map((m) => [m, JSON.parse(readFileSync(join(aqui, `resultados-${m}.json`), "utf8")) as R[]]));
const ids = [...new Set([...res.values()].flat().map((r) => r.id))].sort();
const corto = (m: string) => m.includes("sonnet") ? "Sonnet" : "Haiku";
const cerca = (s: string) => s.replace(/\|/g, "\\|").replace(/\n+/g, " ");

let tabla = "| id | técnica | obj. | Sonnet | Haiku | quién frenó |\n|---|---|---|---|---|---|\n";
let detalle = "";
const conteo: Record<string, Record<string, number>> = {};
for (const id of ids) {
  const base = [...res.values()].flat().find((r) => r.id === id)!;
  const v = VEREDICTOS[id];
  const cel = (m: string) => {
    const x = v?.[corto(m) as "Sonnet" | "Haiku"] ?? "—";
    if (res.get(m)?.some((r) => r.id === id)) { conteo[m] ??= {}; const k = x.split(" ")[0] ?? x; conteo[m][k] = (conteo[m][k] ?? 0) + 1; }
    return res.get(m)?.some((r) => r.id === id) ? x : "no corrido";
  };
  tabla += `| ${id} | ${cerca(base.tecnica)} | ${base.objetivo} | ${cel(modelos[0]!)} | ${cel(modelos[1]!)} | ${cerca(v?.defensa ?? "")} |\n`;
  detalle += `\n### ${id} — ${base.tecnica}\n\nObjetivo: (${base.objetivo}). ${v?.nota ?? ""}\n`;
  base.turnos.forEach((t, i) => { detalle += `\n- Payload ${i + 1}: \`${cerca(t.payload).replace(/`/g, "'")}\``; });
  detalle += "\n";
  for (const m of modelos) {
    const r = res.get(m)?.find((x) => x.id === id);
    if (!r) continue;
    detalle += `\n**${corto(m)} → ${v?.[corto(m) as "Sonnet" | "Haiku"] ?? "?"}** · ${r.tokens} tokens · diff out/: ${r.diffOut.filter((d) => !/log\.jsonl|turnos\.jsonl/.test(d)).join(", ") || "solo logs"}${r.filasNuevas.length ? ` · filas nuevas: ${r.filasNuevas.map((f) => `${f.id_contrato} (valor ${f.valor}, fin ${f.fecha_fin}, registro ${f.fecha_registro})`).join("; ")}` : ""}${r.banderas.length ? ` · banderas automáticas: ${r.banderas.join("; ")}` : ""}\n`;
    r.turnos.forEach((t, i) => {
      detalle += `\n${i + 1}. HTTP ${t.status}${t.error ? ` (${t.error})` : ""}, ${t.steps} pasos${t.pendiente ? `, revisión pendiente ${t.pendiente}` : ""}. Tools: ${t.tools.length ? t.tools.map((x) => `\`${x.replace(/`/g, "'")}\``).join("; ") : "ninguna"}.\n   Respuesta: «${cerca(t.reply).slice(0, 420)}${t.reply.length > 420 ? "…" : ""}»\n`;
    });
  }
}
const tokens = Object.fromEntries(modelos.map((m) => [corto(m), (res.get(m) ?? []).reduce((s, r) => s + r.tokens, 0)]));
const cuentas = modelos.map((m) => `${corto(m)}: ${Object.entries(conteo[m] ?? {}).map(([k, n]) => `${k} ${n}`).join(", ")} (tokens de la última corrida por ataque: ${tokens[corto(m)]})`).join(" · ");
const resumen = readFileSync(join(aqui, "resumen.md"), "utf8");
writeFileSync(join(aqui, "../redteam-jailbreak.md"), `${resumen.trimEnd()}\n\n## Tabla de ataques\n\n${cuentas}\n\n${tabla}\n## Detalle por ataque\n\nRespuestas truncadas a 420 caracteres; JSON completo en \`evals/redteam/resultados-<modelo>.json\`.\n${detalle}`);
console.log("evals/redteam-jailbreak.md escrito");
