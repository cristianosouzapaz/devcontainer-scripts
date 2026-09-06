---
name: "generate-pr"
description: "Generate a strict pull request title and description from a PR already in chat context or from local git using Conventional Commits."
argument-hint: "Optional target branch, for example: main"
agent: "agent"
---

# PR GENERATION SPECIFICATION

Generate a Pull Request title and description from the current workspace context.

> **HARD RULE:** Produce only the PR title and description. No greetings, no process notes, no speculation, no invented content.

The user argument, when provided, is the target branch to compare against; default `main`.

When another skill invokes this one (for example `create-pr`), the title and description are its input — hand them to the caller instead of presenting them as a standalone answer.

---

## 1. CONTEXT RETRIEVAL

Take the highest-confidence source available, in order:

1. Pull request details already in the chat context — usable when they carry real change data (title, description, changed files, diff excerpts, base/head, commit summaries).
2. `<target>..<current-branch>` comparison.
3. Merge-base comparison.

Use the first complete source; if a higher-priority one is partial, keep its reliable facts and fill the gaps from the next.

```
git log <target>..<current-branch> --oneline
git diff <target>..<current-branch> --stat
git diff <target>..<current-branch> --unified=3
```

When the direct comparison is unavailable:

```
git merge-base HEAD origin/<target>
git log <merge-base>..HEAD --oneline
git diff <merge-base>..HEAD --stat
git diff <merge-base>..HEAD --unified=3
```

No meaningful change data from any source → output exactly: `No changes detected.`

Read only the changed files needed to explain intent: public interfaces, markdown deliverables and substantial rewrites before low-signal implementation detail. Skip lockfiles, generated files and binaries unless one of them is itself the change.

---

## 2. ISSUE LINKING

Identify the issue this work closes, from — in order — the chat context, the branch name (`42-thing`, `feat/42-thing`), and issue references in the commit messages. Confirm it with `gh issue view <n>` when `gh` is available; drop the reference if the issue does not exist or plainly describes different work.

One confident match → a `Closes #<n>` line as the last line of the description. Several → one `Closes #<n>` line each. None → no line, and never guess a number.

---

## 3. FORBIDDEN

- Speculation about future work or behavior not present in the diff
- Process notes (`"I analyzed..."`, `"Based on..."`, `"Here is the PR..."`)
- Placeholders, ellipses, partial sentences
- Non-English words
- Markdown sections beyond those in section 5
- Bullets that read as file or function lists instead of statements of what is different

---

## 4. TITLE

`<type>(<optional-scope>): <imperative-short-description>`

Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`, `build`, `ci`, `style`. Breaking change: `!` before the colon (`feat(api)!: remove v1 endpoints`).

Length: the same limit as a commit header, since a squash merge turns this title into one — the `header-max-length` the project's commitlint configuration enforces, or 100 characters when there is none.

Scope only when every changed file belongs to one identifiable domain, and only as a lowercase identifier — never a filename, a path segment or a Key Changes label (`auth`, `api`, `ui`; not `UI/UX` or `Architecture`). Omit it when the changes span unrelated domains.

---

## 5. DESCRIPTION

Emit exactly this structure. Do not rename or reorder sections, and do not append authorship or tooling trailers.

### PR Title
<Generated Title>

### PR Description
```markdown
## Objective
<2-3 sentences: the technical or business reason for these changes, synthesized from commits and diff only. No storytelling.>

## Key Changes
<A flat bullet list, most significant first. Each bullet states one capability, behavior or decision that is new or changed, so a reviewer grasps the impact without reading the diff.
- Write what the system does now that it did not do before.
- No subsection headers, no grouping by domain.
- As many bullets as the PR warrants: no padding, no truncation of meaningful changes.
- No file paths, unless the file is itself the deliverable a contributor must know about (a new config file, a new CLI entry point) — at most one path per bullet.
- Fold minor or internal-only changes into the nearest bullet, or drop them.>

## Impact
<Include only the rows that carry real information; drop the rest, and drop the whole section when none apply.
- Breaking changes: <exactly what breaks and who is affected>
- Performance: <the measurable or architectural improvement>
- Maintainability: <the improvement>
- Developer experience: <the improvement>>

## Technical Notes
<Notable workarounds, architectural decisions, or dependency updates. Omit the section entirely when there is nothing notable.>

Closes #<n>
```

---

## 6. SELF-VALIDATION

Silently verify before emitting:

- title matches `<type>(<scope>): <desc>` or `<type>: <desc>`, within the configured header length, scope lowercase
- `## Objective` and `## Key Changes` are present; `## Impact` and `## Technical Notes` appear only when they carry content
- Key Changes is a flat list of behaviors, with no file path except a deliverable, one per bullet at most
- every `Closes #<n>` points at an issue confirmed to exist and to match this work
- the output is `### PR Title` and `### PR Description` and nothing else
