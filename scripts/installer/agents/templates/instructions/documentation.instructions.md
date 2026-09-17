---
name: "Documentation Rules"
description: "Use when writing or reviewing comments and JSDoc in TypeScript or TSX code."
applyTo: "**/*.{ts,tsx}"
---

# Documentation Rules

## Scope and Structure

- **S1:** Documentation comments MUST immediately precede the declaration they document.
- **S2:** Each JSDoc block MUST document only one declaration.

## Documentation

- **D1:** Comments MUST describe non-obvious constraints or reasons.
- **D2:** Comments MUST NOT paraphrase code.
- **D3:** Comments MUST NOT record edit history, tasks, or issue references.
- **D4:** JSDoc summary sentences MUST use declarative present-tense wording.
- **D5:** JSDoc summary sentences MUST end with a period.
- **D6:** Exported APIs MUST have JSDoc that describes their behavior.
- **D7:** JSDoc `@param` tags MUST document every parameter of documented functions.
- **D8:** JSDoc `@returns` tags MUST describe the return values of documented functions.
- **D9:** JSDoc tags MUST NOT duplicate types from TypeScript declarations.
