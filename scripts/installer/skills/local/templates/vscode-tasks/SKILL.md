---
name: vscode-tasks
description: Use when creating or editing a project's .vscode/tasks.json — the VS Code 2.0.0 task schema, which fields to reach for, and how to decide whether a failing command should fail the task.
---

`.vscode/tasks.json` runs shell commands from VS Code's Run Task picker. The goal is a task
that reports its outcome correctly — not just one that runs a command.

## Baseline shape

```json
{
    "version": "2.0.0",
    "tasks": [
        {
            "label": "Category: Action",
            "detail": "One sentence: what it does and any precondition (e.g. requires Docker).",
            "type": "shell",
            "command": "...",
            "problemMatcher": [],
            "presentation": {
                "echo": true,
                "reveal": "always",
                "panel": "shared",
                "clear": true
            },
            "group": "test",
            "icon": {
                "id": "beaker",
                "color": "terminal.ansiGreen"
            }
        }
    ]
}
```

- `label` — `Category: Action`, so related tasks sort and scan together in the picker.
- `detail` — the one-line subtitle shown under the label; state any precondition here
  (e.g. "Requires Docker").
- `type: "shell"` unless the command is a single executable with no shell syntax
  (`&&`, `||`, globs, env expansion) — then `"process"` avoids a shell in between.
- `icon` — **required on every task.** `{ "id": "<codicon>", "color": "terminal.ansi<Name>" }`,
  shown next to the task in the Run Task picker. Pick a codicon that fits the action
  (`terminal-bash`, `package`, `repo-push`, `trash`, `search`, `checklist`, …) and an
  `terminal.ansi*` theme color (`Green`, `Blue`, `Cyan`, `Magenta`, `Yellow`, `Red`). Tasks in
  the same `Category:` should each get a distinct icon/color pair so the picker stays scannable;
  reserve `terminal.ansiRed` for destructive tasks (resets, wipes).

## Deciding pass/fail semantics — before wiring problemMatcher or exit codes

A non-zero exit code marks the task's terminal as failed. That's correct for a command whose
job is to gate on success (tests, a build, a real lint you want surfaced as failing). It's wrong
for a command that runs successfully but *reports findings* you want visible without the
red/failed terminal chrome (e.g. an informational scan). Decide which kind this is first:

- **Should fail the task**: leave the exit code alone, and prefer a real `problemMatcher`
  (below) over `[]` so failures also populate the Problems panel, not just a red terminal.
- **Should never fail the task**: append `|| true` to the command. This makes findings
  invisible to the task's pass/fail signal — only use it when that's genuinely wanted, and
  say so in `detail` so a future reader isn't confused by a shell command that trails `|| true`.

## Fields worth reaching for beyond the baseline

- `problemMatcher` — `[]` means "don't parse output for errors." A real matcher (a built-in
  like `$tsc`, `$eslint-compact`, or a custom one) makes matched errors clickable and populates
  the Problems panel — reach for this before defaulting to `[]` on anything that emits
  compiler/linter-shaped output.
- `group` — `"build"` or `"test"`, or `{ "kind": "test", "isDefault": true }` to bind
  Cmd/Ctrl+Shift+B or "Run Test Task" to this one specifically.
- `dependsOn` (+ `dependsOrder: "sequence"` or `"parallel"`) — chain existing tasks instead of
  duplicating their commands in a new one.
- `presentation.panel` — `"shared"` (default, reuses one terminal) vs `"dedicated"` (this task
  always gets its own terminal — use for interactive/long-running tasks that shouldn't be
  clobbered by another task's shared panel).
- `presentation.close` — closes the terminal automatically once the task exits successfully.
- `runOptions.runOn: "folderOpen"` — runs the task once when the folder is opened (rare; only
  for setup-on-open tasks).
- `windows` / `linux` / `osx` — per-OS override blocks when the same task needs a different
  command per platform.
- `inputs` (top-level, alongside `tasks`) — `pickString`/`promptString`/`command` prompts
  referenced from a task's `command` as `${input:id}`; use for a task that needs a
  user-supplied value (a branch name, a target to test) instead of hardcoding one variant per
  option.

## Checklist before adding a task

1. Does the command's exit code mean "this should block/fail"? If not, add `|| true` and note
   why in `detail`.
2. Does the output look like errors/warnings a matcher could parse? If so, use a real
   `problemMatcher` instead of `[]`.
3. Does this task belong in an existing chain (`dependsOn`) instead of repeating another task's
   command?
4. Does the label follow `Category: Action` and match the sorting/grouping of the tasks already
   in the file?
5. Does the task have an `icon` (`id` + `terminal.ansi*` `color`), distinct from its siblings in
   the same `Category:`? This is required — no task ships without one.
