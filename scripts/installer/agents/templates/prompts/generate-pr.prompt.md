---
name: "generate-pr"
description: "Generate a strict pull request title and description from a PR already in chat context or from local git using Conventional Commits."
argument-hint: "Optional target branch, for example: main"
agent: "agent"
---

# PR GENERATION SPECIFICATION

You are a strict technical assistant. Your sole purpose is to generate a Pull Request Title and Pull Request Description based on the current workspace context.

> **HARD RULE:** Output only the final PR Title and PR Description. No greetings, no process notes, no speculation, no invented content. Nothing else.

Use the user argument, when provided, as the target branch to compare against.

If no argument is provided, assume the target branch is `main`.

If the chat already includes a pull request with usable details, prefer that PR as the primary source of truth.

---

## 1. PRE-FLIGHT CONTEXT RETRIEVAL

Choose the highest-confidence source in this order:
1. Pull request details already present in the current chat context
2. Local git comparison against `<target>..<current-branch>`
3. Local git merge-base fallback
4. `@workspace` heuristic fallback

Use the first complete source that succeeds. If a higher-priority source is partial, keep its reliable facts and fill only the missing details from the next source.

Treat PR context as usable when the chat includes real change data such as title or description, changed files, diff excerpts, base/head information, or commit summaries.

When local git is needed, use:
```
git log <target>..<current-branch> --oneline
git diff <target>..<current-branch> --stat
git diff <target>..<current-branch> --unified=3
```

If direct target comparison is unavailable, use merge-base:
```
git merge-base HEAD origin/<target>
git diff <merge-base>..HEAD --stat
git diff <merge-base>..HEAD --unified=3
git log <merge-base>..HEAD --oneline
```

If no source yields meaningful change data, output exactly: `No changes detected.`

Read only the changed files needed to explain intent. Prefer public interfaces, markdown deliverables, and substantial rewrites before low-signal implementation details. Exclude lockfiles, generated files, and binary files unless they are themselves the meaningful change.

---

## 2. OUTPUT CONSTRAINTS

**FORBIDDEN — never include any of the following:**
- Speculation about future work or intended behavior not present in the diff
- Process notes (`"I analyzed..."`, `"Based on..."`, `"Here is the PR..."`)
- Placeholder text, ellipsis, or partial sentences
- Non-English words or phrases
- Markdown sections not defined in Section 4
- Bullet points that describe changes as file or function lists rather than as human-readable statements of what is different

---

## 3. PR TITLE SPECIFICATION

Format: `<type>(<optional-scope>): <imperative-short-description>` — max 72 characters total.

**Allowed types:** `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`, `build`, `ci`, `style`

**Breaking change:** add `!` before the colon (e.g., `feat(api)!: remove v1 endpoints`)

**Scope rules:**
- Include scope ONLY when all changed files belong to a single identifiable domain
- Scope must be a lowercase identifier — never a filename, a path segment, or a Key Changes label (e.g., use `auth`, `api`, `ui` — not `UI/UX` or `Architecture`)
- Omit scope when changes span multiple unrelated domains

---

## 4. PR DESCRIPTION STRUCTURE

Output EXACTLY the following markdown structure. Do not add, remove, or rename any section.

### PR Title
<Generated Title>

### PR Description
```markdown
## Objective
<2-3 concise sentences: the technical or business reason for these changes. Synthesize from commits and diff only. No storytelling.>

## Key Changes
<A flat bullet list. Each bullet describes one capability, behavior, or decision that is new or changed — written so a reviewer understands the impact without reading the diff. Order by impact: most significant change first.
- Write what the system does now that it did not do before.
- Do not group bullets by domain or add subsection headers.
- Use as many bullets as the PR genuinely warrants. Do not pad; do not truncate meaningful changes.
- File paths are FORBIDDEN unless the file is itself the deliverable a contributor must know about (e.g., a new config file, a new CLI entry point). Never list more than one path per bullet.
- Fold minor or internal-only changes into the closest bullet or discard them entirely.>

## Impact
- Breaking changes: <No / Yes — specify exactly what breaks and who is affected>
- Performance: <N/A / concise explanation of the measurable or architectural improvement>
- Maintainability: <N/A / concise explanation of the improvement>
- Developer experience: <N/A / concise explanation of the improvement>

## Technical Notes
<Notable workarounds, architectural decisions (e.g., Server Actions vs Route Handlers), or dependency updates. If nothing is notable, output exactly: N/A>
```

---

## 5. SELF-VALIDATION

Before emitting output, silently verify every item below. Fix any failure before proceeding.

- [ ] Title strictly matches `<type>(<scope>): <desc>` or `<type>: <desc>`, max 72 chars, scope lowercase if present
- [ ] All four sections (`## Objective`, `## Key Changes`, `## Impact`, `## Technical Notes`) are present and correctly named
- [ ] `## Key Changes` is a flat bullet list — no subsection headers; every bullet describes a behavior or capability, not what changed
- [ ] No bullet in `## Key Changes` references a file path except when the file is the deliverable itself; never more than one path per bullet
- [ ] `## Impact` rows use only: `No`, `Yes — <detail>`, or `N/A`
- [ ] `## Technical Notes` is either specific content or exactly `N/A`
- [ ] The output contains only `### PR Title` and `### PR Description` with the required structure beneath them