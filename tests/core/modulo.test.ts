import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as tools from "../../modulo/tools/contratos.ts";

const REAL = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const leer = (p: string): string => readFileSync(join(REAL, p), "utf8");
const cuerpo = (md: string): string => md.replace(/^---\n[\s\S]*?\n---\n\n/, "");

test("modulo/agent.md: frontmatter y cuerpo == agent/prompt.md", () => {
  const md = leer("modulo/agent.md");
  assert.match(md, /^---\ndescription: .+\nmode: primary\npermission:\n {2}edit: deny\n {2}bash: deny\n---\n/);
  assert.equal(cuerpo(md), leer("agent/prompt.md"));
});

test("modulo/SKILL.md: frontmatter y cuerpo == knowledge", () => {
  const md = leer("modulo/skill/registro-contratos/SKILL.md");
  assert.match(md, /^---\nname: registro-contratos\ndescription: .+\n---\n/);
  assert.equal(cuerpo(md), leer("src/knowledge/registro-contratos.md"));
});

test("modulo/tools exporta las 5 tools y leer_buzon devuelve ok", async () => {
  for (const n of ["leer_buzon", "extraer", "validar", "registrar", "alertas"] as const) {
    const t = tools[n];
    assert.equal(typeof t.description, "string");
    assert.ok(t.args);
    assert.equal(typeof t.execute, "function");
  }
  const dir = mkdtempSync(join(tmpdir(), "modulo-"));
  cpSync(join(REAL, "fixtures"), join(dir, "fixtures"), { recursive: true });
  const r = JSON.parse(await tools.leer_buzon.execute({}, { directory: dir, sessionId: "t" }));
  assert.equal(r.ok, true);
});
