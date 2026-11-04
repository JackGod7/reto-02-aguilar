---
name: borrar-antes-que-escribir
description: User wants dead code removed before adding code; only used code stays; clean layered structure with traceability
metadata:
  node_type: memory
  type: feedback
  originSessionId: 96a9b1b4-d35f-41d0-8bd1-c6da367d457a
  modified: 2026-11-04T07:36:15.260Z
---

"El mejor código es el que no se escribe": before adding or rewriting, delete what is unused (legacy loops, exports only tests use, unused folders/classes). Keep a correct layered structure (like the DevTalles course projects: app/ui/models/prompts/services, helpers reused) with traceability, debugging, deployment and observability in mind. Applies to the Reto 02 Periferia project ([[reto-periferia-langgraph]]).

**Why:** The user found many classes/folders/code not actually used after Codex's LangGraph migration; confusing and junior-looking.
**How to apply:** In every brief to sessions/agents, require a dead-code pass and report src line counts before/after; reject additions without a PRD case or test.
