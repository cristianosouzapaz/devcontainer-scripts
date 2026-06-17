---
name: "Agent Orchestration"
description: "Use when planning or executing work that may need decomposition into subagents. Covers independence checks, batching, prompt contracts, and synthesis for audits, repeated transformations, and multi-module implementation."
applyTo: "**"
---

# Agent Orchestration

## Goal

- **Decompose threshold:** MUST decompose only when doing so reduces total coordination cost; default to one focused agent for local tasks.
- **Boundaries:** MUST use subagents only for parallel, independent slices with clear, non-overlapping ownership.

## Routing Decision

1. Read the full request and identify the smallest concrete anchors first.
2. List the candidate work units.
3. Decompose only if at least one of these is true:
   - The same operation applies to 3 or more independent units.
   - Multiple folders, modules, or rule groups can be handled in isolation.
   - The task spans 3 or more concerns (e.g. accessibility, data fetching, error handling).
   - A single agent would otherwise need to keep too many unrelated contexts active.
4. Do not decompose when:
   - The steps are sequentially dependent.
   - The task is local (2 files or fewer, 2 rules or fewer, one concrete bug path).
   - A shared abstraction or policy must be decided before child work can start.
   - The user explicitly wants one inline answer or one-pass editing.

## Independence Test

A slice is independent only if the subagent can finish it without needing:

- **No cross-dependency:** Another subagent's findings to choose its approach.
- **No shared surface:** Edits to the same lines or same ownership surface as another slice.
- **No pending design:** A global design decision that the parent has not made yet.

If any of those conditions is false, keep the work in the parent or postpone splitting until the dependency is resolved.

## Decomposition Workflow

1. Read all governing instructions and the concrete files in scope first.
2. Build non-overlapping batches by folder, rule group, or concern.
3. Make each batch self-contained.
4. Spawn all independent subagents in one parallel wave.
5. Wait for every result before reporting conclusions or applying cross-cutting fixes.
6. Synthesize duplicates, conflicts, and shared follow-up work in the parent.

## Subagent Prompt Contract

Every subagent prompt MUST include all of the following:

1. `Task`: one sentence describing exactly what to do.
2. `Scope`: exact files, folders, modules, or rule groups.
3. `Constraints`: the relevant rules pasted verbatim when accuracy depends on them.
4. `Output Format`: how results must be reported.
5. `Out of Scope`: what belongs to other subagents.
6. `Mode`: whether the subagent should be read-only research or may write code.

MUST NOT assume a subagent remembers parent context, prior turns, or referenced files that were not pasted into the prompt.

## Parent Responsibilities

- **Cross-cutting ownership:** MUST keep ownership of cross-cutting files, shared utilities, registrations, and aggregate docs.
- **Shared abstractions first:** MUST decide shared abstractions before parallelizing dependent implementation work.
- **Synthesis:** MUST normalize subagent outputs into one deduplicated synthesis.
- **Deferred edits:** MUST apply shared follow-up edits only after synthesis.

## Reporting Rules

- **No partial reports:** MUST NOT report partial conclusions from one slice while other sibling slices are still running.
- **Progress update:** SHOULD give one concise progress update and next step after any parallel read-only exploration.
- **Audit format:** For audits, synthesize by severity and group by file, module, or concern.
- **Implementation format:** For implementation work, synthesize by shipped outcome and include validation.

## Canonical Patterns

### Audit Across Rule Groups

If a request asks whether a folder follows many independent rule groups, split by rule family (naming, types, imports, functions, structure).

### Repeated Transformation

If the same change must be applied to 3 or more independent folders or files, split by ownership boundary and run the transformations in parallel.

### Multi-Module Feature

If a feature spans multiple modules, split per module only after the parent defines any shared contract, abstraction, or utility.

## Anti-Patterns

- **Sequential when parallel:** MUST NOT sequentially audit independent targets when they could run in parallel.
- **Vague prompts:** MUST NOT write subagent prompts that omit exact rules or scope.
- **Overlapping slices:** MUST NOT split work into overlapping slices that touch the same ownership surface.
- **Premature fix agents:** MUST NOT spawn a fix subagent before the audit or discovery phase has completed.
- **Partial synthesis:** MUST NOT report one subagent's findings as final before all sibling slices are synthesized.
