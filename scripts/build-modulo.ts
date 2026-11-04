// Genera modulo/ desde las fuentes (agent/prompt.md y src/knowledge). Idempotente.
// Uso: npm run build:modulo
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const leer = (p: string): string => readFileSync(join(RAIZ, p), "utf8");
const escribir = (p: string, contenido: string): void => {
  const destino = join(RAIZ, p);
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, contenido);
};

const prompt = leer("agent/prompt.md");
const conocimiento = leer("src/knowledge/registro-contratos.md");

escribir(
  "modulo/agent.md",
  [
    "---",
    'description: "Asistente de registro de contratos vigentes de Periferia IT Group desde un buzón único."',
    "mode: primary",
    "permission:",
    "  edit: deny",
    "  bash: deny",
    "---",
    "",
  ].join("\n") + "\n" + prompt,
);

escribir(
  "modulo/skill/registro-contratos/SKILL.md",
  [
    "---",
    "name: registro-contratos",
    'description: "Reglas del proceso de registro de contratos vigentes: clasificación, revisión humana y campos."',
    "---",
    "",
  ].join("\n") + "\n" + conocimiento,
);

escribir(
  "modulo/tools/contratos.ts",
  `// GENERADO por scripts/build-modulo.ts. No editar a mano.
// Re-exporta las mismas tools del agente; importable sin levantar el servidor.
export { leer_buzon, extraer, validar, registrar, alertas } from "../../src/tools/contratos.ts";
`,
);

escribir(
  "modulo/README.md",
  `# Módulo reutilizable: registro de contratos

Agente empaquetado a partir de las fuentes del proyecto (sin copias divergentes).

- \`agent.md\`: definición del agente (frontmatter YAML + prompt de \`agent/prompt.md\`). Permisos: sin edición ni bash.
- \`tools/contratos.ts\`: las 5 tools (\`leer_buzon\`, \`extraer\`, \`validar\`, \`registrar\`, \`alertas\`), cada una con \`description\`, \`args\` (zod) y \`execute(args, { directory, sessionId })\`. No requiere servidor.
- \`skill/registro-contratos/SKILL.md\`: conocimiento del proceso (de \`src/knowledge/registro-contratos.md\`).

## Integración

1. Copia \`modulo/\` junto con \`src/\` (las tools importan de \`../../src/tools/contratos.ts\`) al proyecto destino.
2. Registra \`agent.md\` como agente primario y \`skill/\` como skill; expón las tools con el prefijo \`contratos_\`.
3. Pasa \`directory\` con el buzón (\`fixtures/\`) en el contexto de cada \`execute\`.

## Regeneración

Los archivos de este directorio se generan: ejecuta \`npm run build:modulo\` tras cambiar \`agent/prompt.md\` o \`src/knowledge/\`.
`,
);
console.log("modulo/ generado");
