---
name: "TypeScript Rules"
description: "Use when writing or reviewing TypeScript or TSX code. Covers naming, type design, imports and exports, function style, mutation safety, and file organization."
applyTo: "**/*.{ts,tsx}"
---

# TypeScript Rules

## Naming

- **File and folder names:** MUST use `kebab-case`.
- **Types and interfaces:** MUST use `PascalCase`.
- **Generic type parameters:** MUST prefix with `T` (e.g. `TItem`, `TResult`).
- **Variables and functions:** MUST use `camelCase`.
- **Component props shape:** MUST name the main exported component props type `Props`.
- **Unused parameters:** MUST prefix intentionally unused parameters with `_`. MUST NOT use the underscore prefix for any other purpose.
- **Top-level primitive constants:** MUST use `SCREAMING_SNAKE_CASE` only for top-level primitive literal constants.

## Type Design

- **Object shapes:** MUST use `interface` for object shapes.
- **Compositions:** MUST use `type` for unions, intersections, and other compositions.
- **Interface extension:** MUST compose interfaces with `extends`.
- **Props composition:** MUST compose props with `type` intersections.
- **Exclusive states:** MUST use discriminated unions for mutually exclusive states.
  - ✓ `type State = { status: "loading" } | { status: "error"; error: Error } | { status: "ok"; data: Data }`
  - ✗ `type State = { loading?: boolean; error?: Error; data?: Data }`
- **Optional properties:** MUST NOT add optional properties unless every call site already justifies the null handling with checks such as `if` or `??`. External API interfaces may use optional properties when the source contract requires them.
- **No `any`:** MUST NOT use `any`.
- **Unknown narrowing:** MUST use `unknown` and narrow it explicitly.
  - ✓ `function parse(value: unknown) { if (typeof value === "string") { ... } }`
  - ✗ `function parse(value: any) { ... }`

## Imports And Exports

- **Type imports:** MUST use `import type` for type-only imports.
- **Named by default:** MUST use named imports and named exports by default.
- **Default exports:** Default exports are allowed ONLY for React components whose names start with an uppercase letter.
- **Internal aliases:** MUST use absolute internal aliases for project modules.

## Functions

- **Arrow functions:** MUST use arrow functions except for React components and class methods.
- **React components:** MUST define React components with `function ComponentName()` declarations, not arrow-function components.
  - ✓ `function UserCard({ name }: Props) { ... }`
  - ✗ `const UserCard = ({ name }: Props) => { ... }`
- **Return type inference:** SHOULD omit explicit return types when TypeScript can infer them correctly.
- **Explicit return types:** MUST add an explicit return type for recursive functions, public APIs, or when intentionally restricting the inferred type.
- **Single-statement if:** MUST omit braces for single-statement `if` bodies.

## Variables

- **Const only:** MUST use `const` for every variable declaration.
- **No let or var:** MUST NOT use `let` or `var`.

## Mutation And Error Handling

- **Argument mutation:** MUST NOT mutate function arguments.
- **External state mutation:** MUST NOT mutate external state or objects and arrays reached through function inputs.
- **Mutation exemptions:** The following are exempt: local variables, `reduce` accumulators, locally created `Map` and `Set` instances, private class fields, and `Ref.current` inside React hooks for internal tracking.
- **Predictable control flow:** MUST NOT use `try-catch` for predictable control flow.
- **Recoverable errors:** MUST return structured result objects for recoverable errors instead of throwing.
  - ✓ `return { ok: false, error: "Not found" }`
  - ✗ `throw new Error("Not found")`

## File Organization

- **Single responsibility:** MUST keep one responsibility per file.
- **Top-to-bottom order:** MUST order each file from top to bottom as: types and interfaces, then constants, then functions.
- **Dependency order:** MUST declare dependencies before dependents within each section.
- **Function grouping:** SHOULD group related functions together.
- **Callee placement:** MUST place callees before callers within a function group.
