---
name: "TypeScript Rules"
description: "Use when writing or reviewing TypeScript or TSX code. Covers naming, type design, imports and exports, function style, mutation safety, and file organization."
applyTo: "**/*.{ts,tsx}"
---

# TypeScript Rules

## Naming

- Use `kebab-case` for files and folders.
- Use `PascalCase` for types and interfaces.
- Prefix generic type parameters with `T`.
- Use `camelCase` for variables and functions.
- Name the main exported component props shape `Props`.
- Prefix intentionally unused parameters with `_`. Do not use the underscore prefix for any other purpose.
- Use `SCREAMING_SNAKE_CASE` only for top-level primitive literal constants.

## Type Design

- Use `interface` for object shapes.
- Use `type` for unions, intersections, and other compositions.
- Compose interfaces with `extends`.
- Compose props with `type` intersections.
- Use discriminated unions for mutually exclusive states.
- Do not add optional properties unless every call site already justifies the null handling with checks such as `if` or `??`.
- External API interfaces may use optional properties when the source contract requires them.
- Do not use `any`.
- Use `unknown` and narrow it explicitly.

## Imports And Exports

- Use `import type` for type-only imports.
- Use named imports and named exports by default.
- Default exports are allowed only for React components whose names start with an uppercase letter.
- Use absolute internal aliases for project modules.

## Functions

- Use arrow functions except for React components and class methods.
- Define React components with `function ComponentName()` declarations, not arrow-function components.
- Omit explicit return types when TypeScript can infer them correctly.
- Add an explicit return type only for recursive functions, public APIs, or when intentionally restricting the inferred type.
- Omit braces for single-statement `if` bodies.

## Variables

- Use `const` for every variable declaration.
- Do not use `let` or `var`.

## Mutation And Error Handling

- Do not mutate function arguments.
- Do not mutate external state or objects and arrays reached through those inputs.
- Local variables, `reduce` accumulators, locally created `Map` and `Set` instances, and private class fields are exempt.
- In React hooks only, `Ref.current` is exempt for internal tracking.
- Do not use `try-catch` for predictable control flow.
- Return structured result objects for recoverable errors instead of throwing.

## File Organization

- Keep one responsibility per file.
- Order each file from top to bottom as types and interfaces, then constants, then functions.
- Within each section, declare dependencies before dependents.
- Group related functions together.
- Within a function group, place callees before callers.