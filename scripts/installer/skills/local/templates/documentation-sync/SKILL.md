---
name: documentation-sync
description: Use when a change affects documented behavior (API, package, toolchain, structure) — checks docs/wiki/ and README.md and keeps them from contradicting the codebase.
---
1. Check every change against documented behavior: an API, a package, a toolchain, or the
   project's structure. If none of these changed, stop — do not touch the wiki.
2. If one of these changed, open `docs/wiki/index.md` first, then every page it links to that
   describes the affected behavior. Do not guess which pages are affected — check the index.
3. Update every affected page so it matches the codebase exactly. A page and the code MUST NEVER
   disagree.
4. A page MUST be verifiable against the code: behavior, contracts, data shapes. Intent,
   guidelines, and aspirational content MUST NOT go in `docs/wiki/` — put that in a root doc and
   link to it from `index.md`. Do not duplicate the root doc's content in the wiki page.
5. Every wiki page MUST be atomic: one concept per page. A title that needs "and" or covers a
   list of sub-topics is two pages, not one — split it.
6. A page MUST NOT exceed 400 lines. If it does, split it; 800 lines is a hard stop, never
   reached.
7. A wiki page MUST NOT carry frontmatter. `index.md`'s curated links and inline cross-references
   are the only navigation and cross-reference mechanism that exists — use them, don't invent
   another one.
8. Adding, renaming, or removing a page REQUIRES updating `index.md` in the same change. An
   unlinked page does not exist as far as this wiki is concerned.
9. Name a specific file, function, or symbol only to anchor a non-obvious *why* — a race
   condition, a counterintuitive constraint — the same bar a code comment must clear. NEVER name
   one to restate *what* the code already shows; that duplicates the codebase and goes stale the
   next time the implementation changes.
