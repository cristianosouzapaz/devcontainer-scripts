---
name: "Documentation Rules"
description: "Use when writing JSDoc, module headers, or inline comments in TypeScript or TSX files. Covers summaries, placement, tag usage, cross-references, and documentation anti-patterns."
applyTo: "**/*.{ts,tsx}"
---

# Documentation Rules

## Language And Style

- **Language:** MUST write all comments and JSDoc in English.
- **Summary tense:** MUST write summary lines as one imperative present-tense sentence ending with a period.
  - ✓ `Validates the user token against the session store.`
  - ✗ `This function validates the user token.`
  - ✗ `Validates the user token` _(missing period)_
- **Forbidden summary openers:** MUST NOT start summaries with `This function`, `This method`, or similar subject phrases.
- **Line length:** SHOULD wrap lines at about 100 columns.

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

## Functions

Applies to `.ts` files only.

- **Coverage:** MUST add a JSDoc block to every exported function and every internal function.
- **Required tags:** MUST include one summary line, one `@param` tag for each parameter, and one `@returns` tag.
- **No types in tags:** MUST NOT include parameter or return types inside JSDoc tags (TypeScript types are the source of truth).
  - ✓ `@param userId The ID of the user to fetch.`
  - ✗ `@param {string} userId The ID of the user to fetch.`
- **Always-throws return:** MUST use `@returns Never returns; the function always throws.` for functions that always throw.
- **Example tag:** SHOULD use `@example` only when the call syntax is not obvious from the signature.
- **Forbidden tags:** MUST NOT use `@author`, `@since`, `@version`, `@description`, or `@deprecated`.
- **Hook internals:** MUST NOT add JSDoc to functions declared inside the body of a `use*` hook. Put the why in the module header or in the hook's own JSDoc instead.

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
- **Document the why:** SHOULD document constraints, edge cases, and non-obvious reasons — not the what.
- **No task references:** MUST NOT mention the current task, PR number, issue, or caller in comments.
  - ✗ `// Added for the auth refactor (PR #42)`
- **No stale JSDoc:** MUST update or remove JSDoc during refactors; stale docs are worse than no docs.
