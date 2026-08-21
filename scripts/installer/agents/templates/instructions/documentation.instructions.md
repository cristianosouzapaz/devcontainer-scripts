---
description: "Use when writing JSDoc, module headers, or inline comments in TypeScript or TSX files. Covers summaries, placement, tag usage, cross-references, and documentation anti-patterns."
paths:
  - "**/*.{ts,tsx}"
---

# Documentation Rules

These rules apply to hand-written project files only. Generated code is exempt.

## Language And Style

- **Language:** MUST write all comments and JSDoc in English.
- **Summary tense:** MUST write summary lines as one imperative present-tense sentence ending with a period.
  - ✓ `Validates the user token against the session store.`
  - ✗ `This function validates the user token.`
  - ✗ `Validates the user token` _(missing period)_
- **Forbidden summary openers:** MUST NOT start summaries with `This function`, `This method`, or similar subject phrases.
- **Line length:** SHOULD wrap lines at about 100 columns.

## Inline Comments

Applies to both `.ts` and `.tsx` files. Governs every inline `//` why-comment referenced
elsewhere in this document.

- **Surprise Test:** MUST pass this test before adding an inline comment: would a competent
  developer editing this line, without the comment, make a *different and wrong* choice? If
  they'd naturally arrive at the same code anyway, omit the comment.
- **No justifying reversible choices:** MUST NOT add a comment to justify a reversible,
  no-correctness-impact choice — visual/stylistic preference, naming, variant selection between
  equally-valid options. Comments are reserved for behavioral or logic invariants: constraints
  where getting it wrong breaks something, not where it just looks or reads differently.
  - ✗ `// Use bg-card here to match the pill style elsewhere` _(preference, not a constraint)_
  - ✓ `// Retry uses the stale closure's id on purpose: the mutation started before the newer`
    `// props arrived, and it must resolve against the item it was actually called for.`
- **No comment-per-edit:** MUST NOT add a new inline comment to justify each incremental edit
  to the same block. Consolidate: one comment per invariant, not one per change — update or
  remove the existing comment instead of stacking another one beside it.

## Section Comments

Applies to both `.ts` and `.tsx` files.

- **When to add:** MUST add a section comment before each section when a file has two or more distinct sections (Types, Constants, Functions).
- **Placement after imports:** MUST place the first section comment after the last import, with one blank line before it and one blank line after it.
- **Placement between sections:** MUST place each subsequent section comment with one blank line before it and one blank line after it.
- **Format:** MUST use this exact 80-character format including `//`:
  ```
  // ─── Types ───────────────────────────────────────────────────────────────────
  ```
- **Allowed labels:** MUST use only `Types`, `Constants`, or `Functions` as the section label.

## Module Header

Applies to `.ts` files only.

- **Required:** MUST start every `.ts` module with a non-JSDoc block comment (`/* */`) that describes the file's role in 1 to 4 lines.
- **Placement:** MUST place the header before the first import or declaration.
- **Directive exception:** MUST place the header after the directive with one blank line between them when the file starts with `"use client";` or `"use server";`.
- **Forbidden content:** MUST NOT hardcode symbol names, `{@link ...}` references, JSDoc tags, or backticked identifiers in the header.

## TSX Files

TSX files (React components) have a lighter documentation surface than pure TypeScript modules.

- **No module header:** MUST NOT add a module header block comment (`/* */`) to `.tsx` files.
- **No JSDoc:** MUST NOT add JSDoc blocks to functions in `.tsx` files.
- **Section comments:** MUST follow the same Section Comments rules as `.ts` files.
- **Inline why-comments:** MAY use an inline `//` comment above the relevant line(s) inside a
  function body to document a non-obvious constraint or cross-file interaction, since `.tsx`
  files have no JSDoc or module header to hold it, subject to the Inline Comments section above.
  MUST NOT use it to paraphrase what the code already makes obvious — the Anti Patterns rules
  still apply.
  - ✗ `// Loop over matches and render a badge for each`

## Functions

Applies to `.ts` files only.

- **Coverage:** MUST add a JSDoc block to every top-level function in the module — exported or
  not — and to every method of a class. "Top-level" means declared directly at module scope, not
  nested inside another function's body.
  - ✓ `export const parseQuery = (...) => {...}` declared at module scope
  - ✓ `const isExactOperator = (...) => {...}` declared at module scope, not exported
  - ✓ a method declared on a class, public or private
  - ✗ `const helper = (...) => {...}` declared inside another function's body — see **Nested
    functions** below instead
- **Required tags:** MUST include one summary line, one `@param` tag for each parameter, and one
  `@returns` tag — except a function that always throws, which omits `@returns` and uses
  `@throws` instead (see **Always-throws**).
- **Param format:** MUST separate a `@param` tag's name from its description with a hyphen.
  - ✓ `@param userId - The ID of the user to fetch.`
  - ✗ `@param userId The ID of the user to fetch.` _(missing hyphen)_
- **No types in tags:** MUST NOT include parameter or return types inside JSDoc tags (TypeScript types are the source of truth).
  - ✓ `@param userId - The ID of the user to fetch.`
  - ✗ `@param {string} userId - The ID of the user to fetch.`
- **Extended context:** MUST move any explanation beyond the one-sentence summary into a
  `@remarks` block rather than lengthening the summary — the summary stays one sentence even
  when the "why" needs several.
  - ✓ a one-sentence summary followed by a `@remarks` block for multi-sentence rationale
  - ✗ a five-sentence run-on summary with no `@remarks`
- **Always-throws:** MUST use `@throws` (not `@returns`) to document a function that always
  throws instead of returning.
  - ✓ `@throws Always throws when the input fails schema validation.`
  - ✗ `@returns Never returns; the function always throws.`
- **Example tag:** SHOULD use `@example` only when the call syntax is not obvious from the signature.
- **Forbidden tags:** MUST NOT use `@author`, `@since`, `@version`, `@description`, or
  `@deprecated` — this is an application, not a published library with external consumers who
  need a deprecation window, so superseded code is deleted, not marked.
- **Nested functions:** MUST NOT add JSDoc to a function declared inside the body of another
  function, regardless of whether the enclosing function is a `use*` hook. Put the why in the
  enclosing top-level function's own JSDoc instead.
  - ✓ a helper closure inside `promoteMergeableFacetsFromQuery` documented via that function's own JSDoc
  - ✗ a JSDoc block above a `const` arrow function declared inside another function's body
- **Inline why-comments:** MAY use an inline `//` comment above a specific non-obvious line or
  statement inside a function body, alongside the function's own JSDoc — the JSDoc documents the
  function as a whole, an inline comment documents one line JSDoc can't attach to, subject to the
  Inline Comments section above. MUST NOT use it to paraphrase what the code already makes
  obvious — the Anti Patterns rules still apply.
  - ✓ `// onLostPointerCapture reuses onPointerUp: the browser can release capture without ever`
    `// firing pointerup/pointercancel, which would otherwise leave isDragging stuck at true.`
  - ✗ `// Loop over matches and render a badge for each`

## Types, Interfaces, and Constants

- **No JSDoc:** MUST NOT add JSDoc blocks to types, interfaces, or constants.
- **Semantic naming:** SHOULD express semantic invariants through naming, branded types, or field-name suffixes rather than comments.
- **Inline context:** MAY use an inline `//` comment on the same line or above for constant-specific context that naming alone cannot convey.

## Cross References

- **Link syntax:** MUST use `{@link name}` for references to other symbols in the codebase.
- **No backtick-only refs:** MUST NOT use backtick-only references when the target is a linkable symbol.
  - ✓ `See {@link validateToken} for the token format.`
  - ✗ `See \`validateToken\` for the token format.`

## Anti Patterns

- **No paraphrase:** MUST NOT describe what the code already makes obvious.
  - ✗ `// Increments the counter` above `counter++`
  - ✓ omit entirely; rename the variable if intent is unclear
- **Document the why:** SHOULD document constraints, edge cases, and non-obvious reasons — not
  the what — using `@remarks` in `.ts` files when it takes more than the one-sentence summary.
- **No task references:** MUST NOT mention the current task, PR number, issue, or caller in comments.
  - ✗ `// Added for the auth refactor (PR #42)`
- **No stale JSDoc:** MUST update or remove JSDoc during refactors; stale docs are worse than no docs.
- **No comment-per-edit:** MUST NOT leave a trail of separate comments, one per past edit, on
  the same block — see the Inline Comments section's No comment-per-edit rule.
  - ✗ three stacked `//` comments above one class list, each explaining a different past change
  - ✓ one comment stating the current invariant, updated in place as the code changes