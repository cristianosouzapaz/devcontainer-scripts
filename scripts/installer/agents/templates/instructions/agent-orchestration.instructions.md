---
name: "Agent Orchestration"
description: "Use when planning or executing work that may need decomposition into subagents. Covers independence checks, batching, prompt contracts, and synthesis for audits, repeated transformations, and multi-module implementation."
applyTo: "**"
---

# Agent Orchestration

## Goal

- Decompose only when doing so reduces total coordination cost.
- Prefer one focused agent for local tasks.
- Use subagents for parallel, independent slices with clear boundaries.

## Routing Decision

1. Read the full request and identify the smallest concrete anchors first.
2. List the candidate work units.
3. Decompose only if at least one of these is true:
  - The same operation applies to 3 or more independent units.
  - Multiple folders, modules, or rule groups can be handled in isolation.
  - The task spans 3 or more concerns, such as accessibility, data fetching, and error handling.
  - A single agent would otherwise need to keep too many unrelated contexts active.
4. Do not decompose when:
  - The steps are sequentially dependent.
  - The task is local, such as 2 files or fewer, 2 rules or fewer, or one concrete bug path.
  - A shared abstraction or policy must be decided before child work can start.
  - The user explicitly wants one inline answer or one-pass editing.

## Independence Test

A slice is independent only if the subagent can finish it without needing:

- Another subagent's findings to choose its approach.
- Edits to the same lines or same ownership surface as another slice.
- A global design decision that the parent has not made yet.

If any of those conditions is false, keep the work in the parent or postpone splitting until the dependency is resolved.

## Decomposition Workflow

1. Read all governing instructions and the concrete files in scope first.
2. Build non-overlapping batches by folder, rule group, or concern.
3. Make each batch self-contained.
4. Spawn all independent subagents in one parallel wave.
5. Wait for every result before reporting conclusions or applying cross-cutting fixes.
6. Synthesize duplicates, conflicts, and shared follow-up work in the parent.

## Subagent Prompt Contract

Every subagent prompt must include all of the following:

1. `Task`: one sentence describing exactly what to do.
2. `Scope`: exact files, folders, modules, or rule groups.
3. `Constraints`: the relevant rules pasted verbatim when accuracy depends on them.
4. `Output Format`: how results must be reported.
5. `Out of Scope`: what belongs to other subagents.
6. `Mode`: whether the subagent should be read-only research or may write code.

Do not assume a subagent remembers parent context, prior turns, or referenced files that were not pasted into the prompt.

## Parent Responsibilities

- Keep ownership of cross-cutting files, shared utilities, registrations, and aggregate docs.
- Decide shared abstractions before parallelizing dependent implementation work.
- Normalize subagent outputs into one deduplicated synthesis.
- Apply shared follow-up edits only after synthesis.

## Reporting Rules

- Do not report partial conclusions from one slice while other slices are still running.
- After any parallel read-only exploration, give one concise progress update and the next step.
- For audits, synthesize by severity and group by file, module, or concern.
- For implementation work, synthesize by shipped outcome and include validation.

## Canonical Patterns

### Audit Across Rule Groups

If a request asks whether a folder follows many independent rule groups, split by rule family such as naming, types, imports, functions, or structure.

### Repeated Transformation

If the same change must be applied to 3 or more independent folders or files, split by ownership boundary and run the transformations in parallel.

### Multi-Module Feature

If a feature spans multiple modules, split per module only after the parent defines any shared contract, abstraction, or utility.

## Anti-Patterns

- Sequentially auditing many independent targets when they could run in parallel.
- Writing vague subagent prompts that omit exact rules or scope.
- Splitting work into overlapping slices that touch the same ownership surface.
- Spawning a fix subagent before the audit or discovery phase has completed.
- Reporting one subagent's findings as final before all sibling slices are synthesized.
