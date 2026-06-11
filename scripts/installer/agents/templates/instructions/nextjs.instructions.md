---
name: "Next.js Rules"
description: "Use when building Next.js pages, layouts, components, and mutations. Covers Server Components, Promise streaming, Server Actions, accessibility, and image handling."
applyTo: "**/*.{ts,tsx}"
---

# Next.js Rules

## Components And Data Fetching

- Use Server Components for async data fetching.
- Do not make Client Components async.
- Prefer passing unresolved `Promise` values from Server Components to Client Components.
- Unwrap those promises in Client Components with `React.use()` inside `<Suspense>` boundaries.
- Do not await all data in the Server Component before rendering when streaming can preserve responsiveness.

## Server Actions And Routes

- Prefix every exported server action with `ACTION_`.
- Use Server Actions for data mutations and server-side business logic.
- Do not use API routes unless they are strictly necessary, such as third-party webhooks.

## Accessibility And Media

- Use semantic HTML elements.
- Add the ARIA attributes required by the interaction and labeling model.
- Use the Next.js `<Image>` component for images.
- Do not use plain `<img>` tags.