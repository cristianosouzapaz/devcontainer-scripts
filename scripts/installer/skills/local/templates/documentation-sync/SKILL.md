---
name: documentation-sync
description: Use when editing any file in the project's documentation tree or the README, or when a change affects documented behavior (API, package, toolchain, structure) — checks those docs against the codebase and keeps them from contradicting it. Run `/documentation-sync audit` for a full docs + README review.
argument-hint: "[audit]"
---

A doc page makes the *shape and why* of the system reachable without re-deriving it from the
source every time.

## Modes

- **Sync** (default) — a change touched documented behavior, or you are about to edit a page
  directly. Runs on `/documentation-sync` and may auto-trigger.
- **Audit** — `/documentation-sync audit`. Explicit only, never auto-triggered. Reviews the
  whole documentation tree and the README against the code and against the rules below,
  reports in chat, then fixes what you approve.

## The rules

Every doc page must satisfy these; the audit scores each one.

1. **Consistency** — every verifiable claim (config values, env var and flag names, paths,
   commands, version numbers, structure) matches the code. On any conflict the code wins.
2. **No frontmatter** — pages carry no YAML frontmatter.
3. **Atomic** — one concept per page; the title has no "and" and the page bundles no
   sub-topic list. A title that needs "and" is two pages.
4. **Length** — under ~400 lines (soft); 800 is a hard stop that should never be reached.
5. **Reachable** — every page is linked from the docs index, directly or through an inline
   cross-reference on a linked page. Adding, renaming or removing a page updates the index in
   the same change — an unlinked page does not exist.
6. **Altitude** — state *what* and *why*, never *how*. Don't name internal symbols (functions,
   private `_`-prefixed variables, lock or hash files the tooling writes): a rename would
   silently stale the page and the code already shows what they do — describe the behavior
   instead. Do name stable contract identifiers (env vars, flags, CLI commands, config-file
   keys, published file names) and structural locations (a source directory, the file a page
   is about, an extension-point config a contributor edits): a rename there is a real change
   that *should* reach the docs. Name a location, never what lives inside it.

The README is held to rule 1 only; rules 2–6 are docs-page rules.

## Sync mode

When a change affects documented behavior, or before editing a page directly:

1. Open the docs index (the documentation tree's entry page), then every page it links to
   that covers the affected area — the index is the map, don't guess which pages matter.
2. Update each affected page so it matches the code and satisfies **The rules**.
3. Reflect any page add / rename / remove in the index in the same change.

Add a page only when its content is verifiable against the code. Intent, guidelines and
aspirational material go in a top-level doc linked from the index, never inlined into a page.

Done when every page you touched matches the code and the index links every page that exists.

## Audit mode

Runs only on an explicit `/documentation-sync audit`.

1. **Scope** — every page in the documentation tree (walk out from the index) plus the
   README. Ignore vendored and generated trees (dependencies, build output, third-party
   checkouts).
2. **Check** — for each page evaluate all six rules. Verify rule-1 claims against the actual
   code, not memory. With 3+ independent pages, fan the consistency checks out to parallel
   subagents, then synthesize.
3. **Report** — one table: pages as rows, rules 1–6 as columns, each cell `✅` (pass),
   `⚠️` (borderline / minor) or `❌` (violation), `—` when a rule doesn't apply (rules 2–6
   for the README). Under the table, number each `⚠️` / `❌` with the finding and a proposed
   fix. Make no edits yet.
4. **Confirm** — if anything is `⚠️` or `❌`, ask which findings to fix (all / a subset /
   none). "None" ends the run as a report only.
5. **Fix & re-verify** — apply the approved fixes, re-check the touched pages against the
   rules, and confirm every inline link still resolves.
6. **Final report** — the table again, updated, plus a short list of what changed and what
   was deferred. If step 3 found nothing, say so and stop.
