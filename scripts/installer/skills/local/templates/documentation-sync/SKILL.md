---
name: documentation-sync
description: Use when a change affects documented behavior (API, package, toolchain, structure) — checks docs/wiki/ and README.md and keeps them from contradicting the codebase.
---

The code is the only source of truth for mechanics — functions, variables, flags, behavior. A
wiki page never restates that; it exists to make the *shape and why* of the system reachable
without re-deriving it from source every time. When a page and the code disagree, the code wins
and the page is wrong.

## When this applies

A change to an API, a package, a toolchain, or the project's structure affects documented
behavior. Anything else, skip — don't touch the wiki for an unrelated change.

## Process

1. Open `docs/wiki/index.md`, then every page it links to that describes the affected area.
   Don't guess which pages matter — the index is the map.
2. Update each affected page so it matches the codebase. Add a new page only when the content is
   verifiable against the code (behavior, contracts, data shapes); intent, guidelines, and
   aspirational material go in a root doc instead, linked from the index, never inlined into a
   wiki page.
3. Adding, renaming, or removing a page means updating `index.md` in the same change — an
   unlinked page doesn't exist as far as this wiki is concerned.

## What a page contains

Name a file, function, or symbol only to anchor a *why* that isn't obvious from reading the code
— a race condition, a counterintuitive constraint — the same bar a code comment has to clear.
Never name one to restate *what* the code already shows: that's the code's job, and a page that
does it goes stale the moment the implementation changes.

## Shape

One concept per page — atomic. A title needing "and," or covering a list of sub-topics, is two
pages. Soft cap ~400 lines; 800 is a hard stop that should never be reached in practice. No
frontmatter — `index.md`'s curated links and a page's own inline cross-references are the only
navigation and cross-reference mechanism a page uses.
