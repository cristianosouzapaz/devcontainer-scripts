---
name: "Agent Orchestration"
description: "Use when planning or executing work that may need decomposition into subagents. Covers independence checks, batching, prompt contracts, and synthesis for audits, repeated transformations, and multi-module implementation."
applyTo: "**"
---

# Agent Orchestration

You MUST apply the decomposition criteria below automatically, without waiting for the user
to say "use subagents" — decide on your own whether a task meets them.

Decompose into parallel subagents only when the same operation applies to 3+ independent
files/folders/modules, or the task spans 3+ unrelated concerns. Do not decompose sequential
work, work touching 2 files or fewer, or work that needs a shared design decision first —
make that decision yourself before splitting.

A slice is independent only if it doesn't need another slice's findings, doesn't touch the
same lines/files as another slice, and doesn't depend on a global decision you haven't made
yet. If any of those is false, keep it in the parent.

Every subagent prompt must be self-contained — the subagent remembers nothing else: state
the task, exact scope, the relevant rules pasted verbatim, the required output format, what's
out of scope, and whether it's read-only research or may write code.

Spawn all independent slices in one parallel wave. Wait for every result before synthesizing
or applying any cross-cutting fix — never act on one slice's findings while others are still
running.