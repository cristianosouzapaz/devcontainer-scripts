---
name: "TypeScript Rules"
description: "Use when writing or reviewing TypeScript or TSX code."
applyTo: "**/*.{ts,tsx}"
---

# TypeScript Rules

## Naming

- **N1:** Type, interface, class, and enum names MUST use PascalCase.
- **N2:** Variable and function names MUST use camelCase.
- **N3:** Intentionally unused parameters MUST use an underscore prefix.

## Code Design

- **C1:** Object shapes MUST use interfaces.
- **C2:** Union and intersection types MUST use type aliases.
- **C3:** Mutually exclusive states MUST use discriminated unions.
- **C4:** Type-only imports MUST use `import type`.
- **C5:** Values with unknown runtime shapes MUST use `unknown` until explicitly narrowed.
- **C6:** TypeScript code MUST NOT use `any`.
- **C7:** Optional properties MUST represent values that callers may omit.
- **C8:** Variables that are not reassigned MUST use `const`.
- **C9:** Publicly exported functions MUST declare explicit return types.

## Behavior and Reliability

- **B1:** Functions MUST NOT mutate their arguments.
