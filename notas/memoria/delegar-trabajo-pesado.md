---
name: delegar-trabajo-pesado
description: "Heavy work (test runs, scans, reviews, edits) goes to separate sessions; this session only orchestrates to save context"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 96a9b1b4-d35f-41d0-8bd1-c6da367d457a
  modified: 2026-11-04T07:53:17.417Z
---

The coordinating session should only orchestrate: verifications, scans (knip, secrets), reviews and code edits run in separate sessions/subagents, and only their short reports come back here.

**Why:** User noticed this session's context gets spent fast ("acá se gasta mucho").
**How to apply:** Default to start_session / SendMessage to an existing session with context; keep tool output here minimal. Related: [[borrar-antes-que-escribir]].
