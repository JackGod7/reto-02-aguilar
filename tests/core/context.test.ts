import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt } from "../../src/agent/context.ts";

function dir(conConocimiento: boolean): string {
  const d = mkdtempSync(join(tmpdir(), "ctx-"));
  mkdirSync(join(d, "agent"));
  writeFileSync(join(d, "agent/prompt.md"), "PROMPT_BASE");
  if (conConocimiento) {
    mkdirSync(join(d, "src/knowledge"), { recursive: true });
    writeFileSync(join(d, "src/knowledge/registro-contratos.md"), "CONOCIMIENTO_X");
  }
  return d;
}

test("contiene prompt y conocimiento, en orden", () => {
  const s = buildSystemPrompt(dir(true));
  assert.ok(s.includes("PROMPT_BASE") && s.includes("CONOCIMIENTO_X"));
  assert.ok(s.includes("## Conocimiento del proceso (fuente: src/knowledge/registro-contratos.md)"));
  assert.ok(s.indexOf("PROMPT_BASE") < s.indexOf("CONOCIMIENTO_X"));
});

test("sin archivo de conocimiento no lanza y devuelve solo el prompt", () => {
  const s = buildSystemPrompt(dir(false));
  assert.equal(s, "PROMPT_BASE");
});

test("con el repo real incluye ambos", () => {
  const s = buildSystemPrompt(process.cwd());
  assert.ok(s.includes("## Conocimiento del proceso"));
});
