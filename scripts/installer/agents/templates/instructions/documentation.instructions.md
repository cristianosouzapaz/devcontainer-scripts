---
name: "Documentation Rules"
version: "1.0.1"
description: "Use when writing JSDoc, module headers, or inline comments in TypeScript or TSX files. Covers summaries, placement, tag usage, cross-references, and documentation anti-patterns."
applyTo: "**/*.{ts,tsx}"
---

# Documentation Rules

## Language And Style

- Write comments and JSDoc in English.
- Write summary lines as one sentence in imperative present tense ending with a period.
- Do not start summaries with phrases such as `This function`.
- Wrap lines at about 100 columns.

## TSX Files

TSX files (React components) have a lighter documentation surface than pure TypeScript modules.

- Do **not** add a module header block comment (`/* */`) to `.tsx` files.
- Do **not** add JSDoc blocks to functions in `.tsx` files.
- Section comments (`// ─── Types ───`) are allowed and follow the same format rules below.

## Module Header

Applies to `.ts` files only.

- Start every module with a non-JSDoc block comment that describes the file's role in 1 to 4 lines.
- Place the header before the first import or declaration.
- If the file starts with `"use client";` or `"use server";`, place the header after the directive with one blank line between them.
- Do not hardcode symbol names, `{@link ...}` references, JSDoc tags, or backticked identifiers in the header.

## Section Comments

- When section comments are used, they must use this exact 80-character format including `//`: `// ─── Types ───────────────────────────────────────────────────────────────────`.
- Only `Types`, `Constants`, or `Functions` are allowed as the section label.

## Functions

Applies to `.ts` files only.

- Add a JSDoc block to every exported function and every internal function.
- Include one summary line, one `@param` tag for each parameter, and one `@returns` tag.
- Do not include parameter or return types inside JSDoc tags.
- Use `@returns Never returns; the function always throws.` for functions that always throw.
- Use `@example` only when the call syntax is not obvious from the signature.
- Do not use `@author`, `@since`, `@version`, `@description`, or `@deprecated`.
- Do not add JSDoc to functions declared inside the body of a `use*` hook.
- Put the why for those nested functions in the module header or in the hook's own JSDoc.

## Types Interfaces And Constants

- Do not add JSDoc to types, interfaces, or constants.
- Express semantic invariants through naming, branded types, or field-name suffixes.
- For constant-specific context, use an inline `//` comment on the same line or above.

## Cross References

- Use `{@link name}` for references to other symbols in the codebase.
- Do not use backtick-only references when the target is a linkable symbol.

## Anti Patterns

- Do not paraphrase what the code already makes obvious.
- Document the why, the constraints, and the edge cases.
- Do not mention the current task, PR, or caller in comments.
- Update or remove stale JSDoc during refactors.
