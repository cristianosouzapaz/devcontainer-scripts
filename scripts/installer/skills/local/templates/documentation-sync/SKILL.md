---
name: documentation-sync
description: Use when a change affects documented behavior (API, package, toolchain, structure) — checks docs/wiki/ and README.md and keeps them from contradicting the codebase.
---
1. Identify whether the change affects documented behavior: an API, a package, a toolchain, or the project's structure.
2. If it does, check `docs/wiki/` (start at `docs/wiki/index.md`) and any relevant `README.md` for pages describing the affected behavior.
3. Update those pages so they never contradict the codebase.
4. Keep every wiki page LLM Wiki style: atomic, one concept per page, minimal. Soft cap ~400 lines, hard cap 800 — split into another page instead of growing past that.
