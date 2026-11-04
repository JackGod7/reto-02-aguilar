import { readFileSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";

const RUTA_PROMPT = "agent/prompt.md";
const RUTA_CONOCIMIENTO = "src/knowledge/registro-contratos.md";

function dentro(base: string, destino: string): boolean {
  const rel = relative(base, destino);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function leerDentro(directory: string, ruta: string): string | null {
  const base = resolve(directory);
  const destino = resolve(base, ruta);
  if (!dentro(base, destino)) return null;
  try {
    return readFileSync(destino, "utf8");
  } catch {
    return null;
  }
}

/** Prompt del agente + conocimiento del proceso. Tolera que falte el conocimiento; sin prompt lanza (fail fast). */
export function buildSystemPrompt(directory: string): string {
  const prompt = leerDentro(directory, RUTA_PROMPT);
  if (prompt === null || prompt.trim() === "") {
    throw new Error(`System prompt ausente o vacío: se esperaba ${RUTA_PROMPT} en ${resolve(directory)}`);
  }
  const conocimiento = leerDentro(directory, RUTA_CONOCIMIENTO);
  if (conocimiento === null || conocimiento.trim() === "") return prompt;
  return `${prompt.trimEnd()}\n\n## Conocimiento del proceso (fuente: ${RUTA_CONOCIMIENTO})\n\n${conocimiento.trim()}\n`;
}
