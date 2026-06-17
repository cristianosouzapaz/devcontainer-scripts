---
name: "Next.js Rules"
description: "Use when building Next.js pages, layouts, components, and mutations. Covers Server Components, Promise streaming, Server Actions, accessibility, and image handling."
applyTo: "**/*.{ts,tsx}"
---

# Next.js Rules

## Components And Data Fetching

- **Server Component async:** MUST use Server Components for async data fetching.
- **Client Component async:** MUST NOT make Client Components async.
- **Promise streaming:** SHOULD prefer passing unresolved `Promise` values from Server Components to Client Components rather than awaiting all data before rendering.
- **Promise unwrapping:** MUST unwrap those promises in Client Components with `React.use()` inside `<Suspense>` boundaries.
  - ✓ `const data = React.use(dataPromise)` inside `<Suspense fallback={<Skeleton />}>`
  - ✗ `const data = await fetchData()` in a Client Component
- **No premature await:** MUST NOT await all data in the Server Component before rendering when streaming can preserve responsiveness.

## Server Actions And Routes

- **Action prefix:** MUST prefix every exported server action with `ACTION_`.
- **Mutations:** MUST use Server Actions for data mutations and server-side business logic.
- **API routes:** MUST NOT use API routes unless strictly necessary (e.g. third-party webhooks).

## Accessibility And Media

- **Semantic HTML:** MUST use semantic HTML elements.
- **ARIA attributes:** MUST add the ARIA attributes required by the interaction and labeling model.
- **Images:** MUST use the Next.js `<Image>` component for images. MUST NOT use plain `<img>` tags.
  - ✓ `<Image src={src} alt="Description" width={400} height={300} />`
  - ✗ `<img src={src} alt="Description" />`
