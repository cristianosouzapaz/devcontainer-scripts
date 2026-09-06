---
name: "generate-commit"
description: "Generate one or more Conventional Commit messages from current git changes, automatically splitting unrelated changes into separate logical commits, without staging or committing anything."
argument-hint: "Optional scope hint or mode, for example: vscode, --staged, or --single"
agent: "agent"
---

# COMMIT MESSAGE SPECIFICATION

Analyze the current workspace changes and produce the `git add` and `git commit` commands needed to record them as one or more logical commits.

> **HARD RULE:** Output only the structure defined in section 5. No preamble, no explanations, no XML. Never run `git add` or `git commit` yourself.

The user argument, when provided, is one of:
- a preferred commit scope, used only if the changes support it
- `--staged` — analyze only staged changes
- `--single` — force one commit covering everything, skipping section 2

With no argument: prefer staged changes when any exist, otherwise the working tree.

---

## 1. CONTEXT RETRIEVAL

1. `git status --short` — this is the authoritative list of what changed.
2. Diff source: `--staged` or existing staged changes → `git diff --cached --unified=3`; otherwise `git diff --unified=3`. Add `--stat` for the same source to gauge scope.
3. **Untracked files (`??` in status) do not appear in any diff.** They belong to the analyzed set only when the working tree is the source — a staged-only run ignores them. For each one that is in scope, read the file, or run `git diff --no-index -- /dev/null <path>`. A new file is often the most significant change in the set — never omit it because the diff was silent about it. Untracked directories must be expanded to their files (`git status --short --untracked-files=all`).
4. If the diff still does not explain intent, read the most relevant changed files.

If nothing relevant changed, output exactly: `No changes detected.`

---

## 2. GROUPING STRATEGY

Unless `--single` was passed, split unrelated concerns into separate commits.

- The unit of grouping is the **whole file**, never a hunk. Never propose `git add -p`.
- Group by concern as revealed by the diff content, not by file path.
- A file spanning two concerns stays whole, in the group of its predominant concern. Flag it with a `Note:` line (section 5).
- Merge two groups when one would not build, lint, or pass tests without the other (a new export and its first call site). No intermediate commit may leave the tree broken.
- Order groups so dependencies land first.
- Every file in the analyzed set appears in exactly one group.
- One group left after grouping → treat as `--single`.

---

## 3. COMMIT RULES

`<type>(<optional-scope>): <imperative-description>`

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

- Imperative mood: `add`, `fix`, `update` — not `added`, `fixed`, `updates`.
- Header within the `header-max-length` the project's commitlint configuration enforces; 100 characters when there is none.
- Scope only when clear and materially more precise; a user-supplied scope only when it matches the changes.
- `!` only for a real breaking change.
- No file names unless the file is the user-facing deliverable.

Body only when the header cannot carry the needed context: one blank line after the header, then why or what changed — never the analysis process.

Footer only for `BREAKING CHANGE: ...` or for issue references the context actually supports.

Never add authorship or tooling trailers — no `Co-Authored-By`, no session or agent links. The commit belongs to the person who runs it.

---

## 4. QUOTING

Wrap every path and message in single quotes. An apostrophe inside a message is closed and re-opened: `'don'\''t'`. Prefer rephrasing to avoid the escape when the wording allows. Always put `--` between `git add` and its paths.

---

## 5. OUTPUT FORMAT

For more than one commit, open with a summary list in application order:

```
**N commits proposed:**
1. `type(scope)` — description
2. `type(scope)` — description
```

Then, per commit in application order, a bold label followed by two separate copyable blocks — staging first, commit second, never combined:

```
**Commit i/N — type(scope): description**
```

```bash
git add -- 'path/one.ts' 'path/two.ts'
```

```bash
git commit -m 'type(scope): description'
```

Body and footer paragraphs each get their own `-m`:

```bash
git commit \
  -m 'type(scope): description' \
  -m 'body paragraph' \
  -m 'footer'
```

A file kept whole across two concerns gets a one-line `Note:` directly above that commit's `git add` block.

For a single commit, emit just the two code blocks — no summary list, no label.

---

## 6. SELF-VALIDATION

Silently verify before emitting:

- every file in the analyzed set appears in exactly one `git add`, and no in-scope untracked file was dropped because the diff was silent about it
- headers are valid types, imperative, within the configured length; scope omitted when unclear
- body and footer justified by the diff; no authorship or tooling trailers anywhere
- quoting is valid Bash; `--` present; staging and committing in separate blocks
- commit order leaves no broken intermediate state
- summary list and labels match the commits, or are both absent for a single commit
- output contains nothing but the section 5 structure
