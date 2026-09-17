---
name: "JavaScript Rules"
description: "Use when writing or reviewing JavaScript or JSX. Covers modules, immutable bindings, validation, asynchronous failures, state, and documentation."
applyTo: "**/*.{js,mjs,cjs,jsx}"
---

# JavaScript Rules

## Scope and Structure

- **S1:** Each JavaScript file MUST use one import/export system.
- **S2:** CommonJS files MUST begin with a top-level `"use strict"` directive.
- **S3:** Each JavaScript file MUST have one primary responsibility.
- **S4:** Declarations that depend on other declarations MUST follow their dependencies.

## Naming

- **N1:** JavaScript file and directory names MUST use `kebab-case`.
- **N2:** Class names MUST use `PascalCase`.
- **N3:** Variable and function names MUST use `camelCase`.
- **N4:** Intentionally unused parameters MUST begin with an underscore.
- **N5:** Identifiers other than intentionally unused parameters MUST NOT begin with an underscore.

## Code Design

- **C1:** Variables whose bindings are not reassigned MUST use `const`.
- **C2:** Variables whose bindings are reassigned MUST use `let`.
- **C3:** JavaScript code MUST NOT use `var` declarations.
- **C4:** Equality comparisons MUST use strict equality operators.
- **C5:** Values from outside the function's trust boundary MUST be validated before use.
- **C6:** Own properties on untrusted objects MUST be checked with `Object.hasOwn()`.
- **C7:** JSDoc type assertions MUST NOT replace runtime validation of externally sourced values.
- **C8:** Functions MUST NOT mutate caller-owned data reachable through their parameters.
- **C9:** JavaScript code MUST NOT read undeclared global variables.
- **C10:** JavaScript code MUST NOT assign to native read-only globals.

## Behavior and Reliability

- **B1:** Functions that access a filesystem, network, process, or process-wide configuration MUST receive each effect target explicitly.
- **B2:** Functions that access a filesystem, network, process, or process-wide configuration MUST document each effect and its failure behavior in JSDoc.
- **B3:** Functions without an external-effect contract MUST NOT access a filesystem, network, process, or process-wide configuration.
- **B4:** Promises whose results are used by a caller MUST be awaited or returned.
- **B5:** Promises that are not awaited or returned MUST have an explicit rejection handler.
- **B6:** An async function MUST NOT be used as a `new Promise()` executor.
- **B7:** Catch blocks MUST identify the failure conditions they handle.
- **B8:** Catch blocks MUST rethrow failures they do not recognize.
- **B9:** Code that replaces an error with another error MUST preserve the original error as its cause.
- **B10:** Code that acquires a resource MUST release it on every exit path.

## Documentation

- **D1:** Comments MUST document non-obvious constraints or reasons.
- **D2:** Comments MUST NOT paraphrase adjacent code.
- **D3:** Comments MUST NOT record edit history, tasks, or issue references.
- **D4:** Documentation comments MUST immediately precede the declaration they document.
- **D5:** Each JSDoc block MUST document one declaration.
- **D6:** Exported functions MUST have JSDoc.
- **D7:** Exported classes MUST have JSDoc.
- **D8:** JSDoc for exported functions MUST describe their contract, parameters, return value, and relevant failures.
- **D9:** JSDoc MUST match the documented declaration's behavior.
- **D10:** Comments MUST NOT be the only enforcement of a runtime contract.
