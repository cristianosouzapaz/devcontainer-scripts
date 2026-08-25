## Documentation Sync

A change to documented behavior (API, package, toolchain, structure) MUST update `docs/wiki/` (start at `docs/wiki/index.md`) and any relevant `README.md` in the same change — docs MUST NEVER contradict the codebase. See [Documentation Sync skill](.claude/skills/documentation-sync/SKILL.md) for the full procedure.

Every wiki page MUST be LLM Wiki style: atomic, one concept per page, minimal, no frontmatter — `index.md` and inline links are the only navigation and cross-reference mechanism that exists. A page MUST be verifiable against the code — intent, guidelines, and aspirational content MUST go in a root doc, never in the wiki. Name a specific file or function only to anchor a non-obvious *why* (same bar as a code comment); NEVER to restate *what* the code already shows. A page MUST NOT exceed 400 lines — split it instead; 800 lines is a hard stop, never reached.
