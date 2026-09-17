---
name: "Next.js Rules"
description: "Use when building Next.js pages, layouts, components, route handlers, and mutations. Covers rendering boundaries, streaming, Server Actions, HTTP routes, accessibility, and images."
applyTo: "**/*.{ts,tsx}"
---

# Next.js Rules

## Scope and Structure

- **S1:** Route files MUST follow the framework's file-system conventions.
- **S2:** Client Components MUST declare their client boundary at the file boundary.

## Code Design

- **C1:** Server Components MUST perform data access that does not require browser APIs or event handlers.
- **C2:** Client Components MUST NOT be declared async.
- **C3:** Server Components MUST pass unresolved promises when independent UI can render before the data resolves.
- **C4:** Client Components MUST unwrap streamed promises inside a Suspense boundary.
- **C5:** Server Components MUST NOT await independent data before rendering UI that does not depend on that data.

## Behavior and Reliability

- **B1:** Server Actions MUST validate every argument before using it.
- **B2:** Server Actions MUST authorize the caller before changing protected data.
- **B3:** Server Actions MUST handle mutations initiated by application UI.
- **B4:** Route handlers MUST handle requests that require an HTTP interface.
- **B5:** Route handlers MUST validate request inputs before using them.

## Framework and Runtime

- **F1:** Application content images MUST use the framework's image component.
- **F2:** Non-decorative images MUST provide an accessible text alternative.
- **F3:** Decorative images MUST be marked as decorative to assistive technologies.
- **F4:** Interactive controls MUST have an accessible name.
- **F5:** Rendered UI MUST use semantic HTML elements for its structure.
