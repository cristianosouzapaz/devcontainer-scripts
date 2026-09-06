---
name: documentation-sync
description: Use when editing any file in the project's documentation tree or the README, or when a change affects documented behavior (API, package, toolchain, structure) — checks those docs against the codebase and keeps them from contradicting it. Run `/documentation-sync audit` for a full docs + README review.
argument-hint: "[audit]"
---

Documentation states the *shape and why* of a system so a reader reaches the right file
without re-deriving it from the source. The code is the source of truth for mechanics; a page
that repeats what the code already says becomes a second source of truth, and a second source
of truth rots in silence.

This skill keeps the documentation tree and the README from contradicting the code, and holds
new writing to that bar. It is organized as a small wiki of its own: this page is the map, and
each reference below is loaded only when the work at hand needs it.

## Who reads this

Two readers, and both can open the code: the developer working on the project, and the coding
agent working alongside them. Neither needs a tutorial. Three consequences shape every rule
below:

- **A false claim costs more than a missing one.** A developer who hits a line contradicting
  the code notices and fixes it; an agent takes the page as authoritative and propagates it
  into new work. Optimize for saying nothing false, never for coverage.
- **The why is the only irrecoverable part.** The *what* is re-derivable from the code in
  seconds. Intent exists nowhere else.
- **A page is a unit of loading.** A page that mixes two concepts costs twice the context to
  use half of it. Atomicity and a precise index are economy, not taste.

A project written for other readers says so in its documentation index's charter, which wins
over this section — every rule below assumes the two readers above.

## The gate

**Most code changes need no doc change.** A page describes responsibilities and decisions;
changing a default, adding a helper, or renaming an internal touches neither. Ask what a
reader would now get wrong. If the answer is nothing, say the docs need no change and stop —
that is a complete, correct outcome.

## The rules

Six judgment rules. You decide them; the audit scores them per page.

1. **Consistency** — every verifiable claim (env var and flag names, paths, commands, version
   numbers, structure) matches the code. On any conflict the code wins.
2. **Verifiability** — every *factual* claim is checkable against this repository. The why of a
   decision is not, and stays admitted on one condition: it must be **attributable** — naming
   the constraint it answers or the alternative it rejected. A why that names neither is an
   opinion. Third-party behavior is never documentable here.
3. **Altitude** — state *what* and *why*. Accept fragility where a machine catches it, refuse
   it where it cannot: a stale path is reported by the checker, a renamed internal symbol lies
   for months. So name locations and contracts, never functions or private variables. The lock
   and hash files the tooling generates are out for a second reason — an artifact a tool
   produces is not a decision anyone made.
4. **No mirroring** — don't reproduce a value the code holds, and don't inventory a location's
   contents. Name the location and point at it.
5. **Single source** — one page owns each verifiable fact; a second page that needs it links to
   the owner instead of restating it. A repeated one-line orientation is not a second source.
6. **Atomic** — one concept per page. A title that needs "and" is two pages.

The README says how the project is used; the wiki says how it is shaped and why. The README is
held to Consistency and Verifiability only. If the documentation index states its own charter,
that statement wins over anything here.

## The reference wiki

| Load | When |
| ---- | ---- |
| [Principles](references/principles.md) | Before writing, keeping, or judging any sentence — the two questions, the admission test, worked examples |
| [The form of a page](references/page-form.md) | Adding, splitting or deleting a page, or writing an index entry |
| [The checker](references/checker.md) | Running the mechanical checks, or configuring them for this project |
| [Sync mode](references/sync.md) | A change touched documented behavior, or you are editing a page directly |
| [Audit mode](references/audit.md) | Only on an explicit `/documentation-sync audit` |

## Modes

- **Sync** (default) — the everyday path, and what an auto-trigger runs. Follow
  [Sync mode](references/sync.md).
- **Audit** — full review of the tree plus the README, reported before anything is edited.
  Explicit only, never auto-triggered. Follow [Audit mode](references/audit.md).

Both end the same way: every page you touched matches the code, the checker reports no errors,
and the index links every page that exists.
