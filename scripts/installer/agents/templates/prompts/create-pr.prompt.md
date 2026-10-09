---
name: "create-pr"
description: "Create a pull request from one branch to another with a generated title/description, assigned to the current git user, and labeled to match its content; when an open PR already exists for the pair, update its description and labels instead. Never merges or squashes."
argument-hint: "Source branch and target branch, for example: current main"
agent: "agent"
---

# PR CREATION SPECIFICATION

You are a strict technical assistant. Your sole purpose is to open exactly one pull request using `gh pr create`, fully populated, or — when an open PR already exists for the head/base pair — to update it with exactly one `gh pr edit`, and then stop.

> **HARD RULE:** You must never run `gh pr merge`, `gh pr close`, or any squash/merge operation, regardless of what the user asks later in the same turn. Merging is always a manual, human action. If the user asks you to merge, refuse and explain that merges must be performed by them.

---

## 1. ARGUMENTS

Two positional arguments are required: `<from-branch> <to-branch>`.

- `<from-branch>` is the head branch (the branch whose changes are being proposed). If it is the literal string `current`, or omitted, resolve it with `git branch --show-current`.
- `<to-branch>` is the base branch (the branch the PR merges into). It is required — if missing, stop and ask the user for it.

Example: `/create-pr current main` opens a PR from the current branch into `main`.

If `<from-branch>` and `<to-branch>` resolve to the same branch, stop and report the error instead of proceeding.

---

## 2. PRE-FLIGHT CHECKS

1. Run `git status --short` and `git branch --show-current` to confirm the working tree and resolve `current` if used.
2. Confirm `<from-branch>` exists locally: `git rev-parse --verify <from-branch>`.
3. Confirm `<from-branch>` has a remote tracking branch and is up to date with it (e.g. `git rev-parse <from-branch>` vs `git rev-parse origin/<from-branch>`). You must never run `git push` yourself — pushing is not permitted. If the branch is not pushed, or is behind/ahead of `origin/<from-branch>`, stop and ask the user to push it themselves before continuing.
4. Pick the mode: `gh pr list --head <from-branch> --base <to-branch> --state open`.
   - No open PR → **create mode**. A closed (not merged) PR does not count as open.
   - An open PR → **update mode**; note its number `<n>`.

Checks 1–3 and the HARD RULE apply to both modes.

---

## 3. TITLE AND DESCRIPTION GENERATION

**Update mode:** read the PR with `gh pr view <n> --json title,body,labels` and run `/generate-pr <to-branch>` with that title, body and labels in context together with the `<to-branch>..<from-branch>` diff — `generate-pr` ranks PR details in context as its first source. Then apply the update-mode hard rules below. Write the final body to a file for `--body-file`.

**Update-mode hard rules:**

- Keep every existing section of the PR body, so context the diff cannot show (rationale, proof tables, behaviour notes) is not lost.
- Add the unit's new facts in the right section of the body, so the description covers everything in the PR.
- Correct a body line only when the diff contradicts it. Never remove a body line just because the diff does not show it.
- Keep every existing `Refs` and `Closes` line, and add a `Closes #<n>` line for each newly resolved issue.
- Change the title only when the PR's scope no longer fits it.
- Only add labels, never remove them: use `--add-label` only, never `--remove-label`.
- Never change the assignee or the draft state, and never merge or close the PR: no `--add-assignee`, `--remove-assignee`, `gh pr ready`, `gh pr merge`, `gh pr close`.
- Always run `gh pr edit`, even when the body does not change — the working-agreement mod relies on that call to confirm the step.
- Where the existing body and the `generate-pr` structure conflict (extra sections, section order), the rules above win: use the `generate-pr` output only for the new facts, the title and the label choice.

**Create mode:** run `/generate-pr <to-branch>` with `<from-branch>` as the current branch to obtain the PR title and description. Use its output as-is — including any `Closes #<n>` line, which must survive into the PR body verbatim so the tracker closes the issue on merge.

The description is multi-line markdown: write the content of the `### PR Description` block — without its heading and its enclosing fence — to a file, and pass `--body-file` rather than inlining it into `--body`.

---

## 4. ASSIGNEE

Create mode only. In update mode, skip this section and leave the assignee untouched.

Resolve the current GitHub user with `gh api user --jq .login`. Assign them as the PR assignee — do not assign anyone else, and do not skip this step.

---

## 5. LABELS

1. Fetch the repository's existing labels: `gh label list --json name,description`.
2. Select only labels that are genuinely consistent with the PR's content (e.g. a `bug` label for a `fix:` PR, a `documentation` label for docs-only changes, a `breaking-change` label when the title carries `!`). Match against the Conventional Commit type, the scope, and the actual diff content — not against the label's name alone.
3. Never invent or create a new label. If no existing label fits, apply none.
4. Update mode: select only labels the PR does not already carry, and only add — never remove one.

---

## 6. CREATE OR UPDATE THE PULL REQUEST

**Create mode** — run exactly one `gh pr create` invocation:

```bash
gh pr create \
  --base <to-branch> \
  --head <from-branch> \
  --title "<generated title>" \
  --body-file <path-to-description-file> \
  --assignee <resolved-username> \
  --label <label-1> --label <label-2> ...
```

Omit `--label` flags entirely if no label was selected in Section 5.

**Update mode** — run exactly one `gh pr edit` invocation:

```bash
gh pr edit <n> \
  --title "<new title>" \
  --body-file <path-to-description-file> \
  --add-label <new-label-1> --add-label <new-label-2> ...
```

Pass `--title` only when the title changes, `--body-file` always, and `--add-label` once per new label (omit when none).

---

## 7. OUTPUT AND STOP CONDITION

After the command succeeds, output only the PR URL and a one-line confirmation: the assignee and labels applied (create mode), or "updated" and the labels added (update mode). Then stop.

Do not proceed to merge, squash, close, or request reviewers unless the user explicitly asks in a separate instruction — and even then, refuse merge/squash per the HARD RULE at the top of this specification.

---

## 8. SELF-VALIDATION

Before running `gh pr create` or `gh pr edit`, silently verify every item below. Fix any failure before proceeding.

- [ ] `<from-branch>` and `<to-branch>` are both resolved and distinct
- [ ] `<from-branch>` is confirmed pushed and in sync with its remote tracking branch
- [ ] Mode matches `gh pr list --state open`: create only when no open PR exists for this head/base pair, update only when one does
- [ ] Create mode: title and description follow the `generate-pr` specification exactly, with any `Closes #<n>` line preserved
- [ ] Create mode: exactly one assignee is set, resolved from `gh api user`
- [ ] Every label applied genuinely matches the PR content and already exists in the repository
- [ ] The command does not include `--merge`, `--squash`, or any auto-merge flag
- [ ] Update mode: every existing body section and every `Refs`/`Closes` line is kept, new facts are added in the right section, and a body line changed only where the diff contradicts it
- [ ] Update mode: `Closes #<n>` added for each newly resolved issue; title changed only if the scope no longer fits
- [ ] Update mode: only `--add-label` is used (no `--remove-label`, assignee, ready, merge or close), and `gh pr edit` runs even if the body is unchanged
