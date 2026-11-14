---
name: progress-report
description: 'Only on explicit request — never start it from a plain question. Answers "where are we?" for an issue and its sub-issues with a fixed table (Issue | What it does | Unit | State) read live from the tracker, git and herdr, followed by Next and Waiting on you. Run `/progress-report`, `/progress-report #n` or `/progress-report roadmap`.'
argument-hint: "[#n | roadmap]"
disable-model-invocation: true
metadata:
  kit-version: "1.1.0"
  kit-tags: workflow
  kit-global: "true"
---

This skill answers "where are we?" from live state, never from what you remember. It reads and
never writes: no comment, no label, no git command that changes anything.

## 1. Run the script

```bash
python3 <skill-dir>/scripts/report.py [#n | roadmap]
```

Pass the user's argument through unchanged. The script reads `gh`, git and the herdr CLI JSON
(when herdr is installed) and prints one JSON object. It has already decided everything that
can be decided by rule: the scope, the rows and their order (in the `roadmap` view, blockers
before the issues they block), each row's branches, PRs, unit and state, and the two lists. Never recompute, reorder or second-guess any of it — the tracker and
git win over anything you remember.

## 2. When the scope is a question

When `scope.kind` is `ask`, render no table. Say why and ask:

- `no-roadmap` — no open issue carries the `roadmap` label; ask for an issue number (`#n`).
- `several-roadmaps` — list the `candidates` and ask which one.
- `several-current` — several open sub-issues of the roadmap have no open blocker; list the
  `candidates` and ask which one.
- `no-current` — no open sub-issue of the roadmap is free of open blockers; ask for `#n`.

When `scope` is `null`, the tracker could not be read: say so, quoting `error`, and stop.

## 3. Render the report

Write it in the conversation's language. Issue numbers, branch names, labels, pane ids and
state icons stay verbatim.

**Header**: `read_at`, the `sources` used, every name in `unreadable`, and always the line
"unit questions: not read, no public interface".

**Table**, one line per row, in the order given, columns fixed:

| Issue | What it does | Unit | State |
| --- | --- | --- | --- |

- *Issue*: `#number`, indented by `depth` (two non-breaking spaces per level); **bold** when
  `open` is true.
- *What it does*: one plain sentence from the row's `title` and `body`. Say only what they say;
  never invent a purpose, a status or a detail.
- *Unit*: `unit_cell` as given.
- *State*: `state.icon`, `state.word` and `state.reason`, translated, in that order. A child
  with no work of its own inside an integrated group reads ↳ Part of #N (integrated into
  `branch`); render it like any other state.

**Next**: the issues in `next`, in that order.

**Waiting on you**: each entry of `waiting_on_you.blocking` with its `actions`; then a
"Non-blocking reviews" sub-heading with each entry of `waiting_on_you.non_blocking_reviews`.
Both lists cover the scope issue and every open issue below it, whatever its state and whether
or not the table shows it (the `roadmap` view shows only the direct sub-issues), so an entry may
name an issue that has no row. A list given as `"?"` could not be read in full: render `?`,
never "none".

An empty list or sub-heading is written as empty ("none"), never left out, so the reader knows
it was checked.

A `?` is never filled in; render it as `?` with its reason. It comes in two kinds:

- `unreadable: <source>`: a read failed (gh or git erroring, or a connection that came back
  truncated), and the reason names that source.
- `Unverified: …`: every read succeeded, but the state cannot be proven, because a branch's
  history no longer shows which commits are its own. The reason names the branch, what happened
  to it, and the `git log` the user can run to check. A close-out that re-signs delegated commits
  rewrites every branch it moves, so run the report before that re-sign: afterwards, every
  integrated row reads `Unverified` by design.
