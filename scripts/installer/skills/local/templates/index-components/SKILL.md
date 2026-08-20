---
name: index-components
description: Use when documenting React component folders anywhere in a workspace. Indexes components in one or more folders by reading local component files and summarizing each component's UI role.
---
Create or replace `index.md` in each folder that directly contains React component files (`.tsx`/`.jsx`).

## Scope

The request may name a folder path, multiple folder paths, a glob, or describe the scope in natural language (e.g. "every folder with React components under dashboard"). If it names a broad parent, search recursively and target only descendant folders that directly contain component files — never a parent folder that has none directly inside it.

## Output Format

```md
---
update: Rewrite from scratch on every change. UI role only — no props, hooks, refs, state, libraries, or history.
---
<One sentence, imperative present tense, ending with a period, naming the folder's feature/group and what it covers.>

| File         | Role     | Description |
| ------------ | -------- | ----------- |
| `<filename>` | `<role>` | ...         |
```

## Content Rules

- **Describe the UI, not the implementation.** Say what the component shows or does for the user. Never mention prop names, hook names, refs, internal state, libraries, or the history of how it got that way.
- `Description`: starts with a verb (`Renders`, `Displays`, `Wraps`, ...), 80 characters max, one line.
- `File`: filename in backticks.
- `Role`: exactly one label — `entry-point`, `layout`, `form`, `sub-component`, `provider`.
- Row order: `entry-point` first, then alphabetical by filename.
- When `index.md` already exists, rewrite every changed row from scratch against these rules — never append to or extend prior wording.

## Role Labels

- `entry-point`: root component of the feature, page, or group.
- `layout`: visual shell or wrapper with no business logic.
- `form`: controlled input fields for CRUD operations.
- `sub-component`: reusable piece consumed within the same local feature or group.
- `provider`: context or state wrapper.

## Edge Cases

- One `index.md` per folder; never merge files from different folders into one.
- Never list `index.md` itself as a row.
- Never mention this skill, any template, or external instructions in the output.
- A folder with no component files: skip it and say so in the chat response.
- No matching folders at all: stop and say no index can be generated.
