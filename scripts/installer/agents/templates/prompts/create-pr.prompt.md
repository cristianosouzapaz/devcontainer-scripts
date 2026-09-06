---
name: "create-pr"
description: "Create a pull request from one branch to another with a generated title/description, assigned to the current git user, and labeled to match its content. Never merges or squashes."
argument-hint: "Source branch and target branch, for example: current main"
agent: "agent"
---

# PR CREATION SPECIFICATION

You are a strict technical assistant. Your sole purpose is to open exactly one pull request using `gh pr create`, fully populated, and then stop.

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
4. Confirm no open PR already exists for this head/base pair: `gh pr list --head <from-branch> --base <to-branch>`. If one exists, stop and report its URL instead of creating a duplicate.

---

## 3. TITLE AND DESCRIPTION GENERATION

Run `/generate-pr <to-branch>` with `<from-branch>` as the current branch to obtain the PR title and description. Use its output as-is — including any `Closes #<n>` line, which must survive into the PR body verbatim so the tracker closes the issue on merge.

The description is multi-line markdown: write the content of the `### PR Description` block — without its heading and its enclosing fence — to a file, and pass `--body-file` rather than inlining it into `--body`.

---

## 4. ASSIGNEE

Resolve the current GitHub user with `gh api user --jq .login`. Assign them as the PR assignee — do not assign anyone else, and do not skip this step.

---

## 5. LABELS

1. Fetch the repository's existing labels: `gh label list --json name,description`.
2. Select only labels that are genuinely consistent with the PR's content (e.g. a `bug` label for a `fix:` PR, a `documentation` label for docs-only changes, a `breaking-change` label when the title carries `!`). Match against the Conventional Commit type, the scope, and the actual diff content — not against the label's name alone.
3. Never invent or create a new label. If no existing label fits, apply none.

---

## 6. CREATE THE PULL REQUEST

Run exactly one `gh pr create` invocation:

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

---

## 7. OUTPUT AND STOP CONDITION

After the command succeeds, output only the resulting PR URL and a one-line confirmation of the assignee and labels applied. Then stop.

Do not proceed to merge, squash, close, or request reviewers unless the user explicitly asks in a separate instruction — and even then, refuse merge/squash per the HARD RULE at the top of this specification.

---

## 8. SELF-VALIDATION

Before running `gh pr create`, silently verify every item below. Fix any failure before proceeding.

- [ ] `<from-branch>` and `<to-branch>` are both resolved and distinct
- [ ] `<from-branch>` is confirmed pushed and in sync with its remote tracking branch
- [ ] No duplicate open PR exists for this head/base pair
- [ ] Title and description follow the `generate-pr` specification exactly, with any `Closes #<n>` line preserved
- [ ] Exactly one assignee is set, resolved from `gh api user`
- [ ] Every label applied genuinely matches the PR content and already exists in the repository
- [ ] The command does not include `--merge`, `--squash`, or any auto-merge flag
