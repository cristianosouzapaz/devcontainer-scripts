---
name: index-components
version: "1.0.0"
description: Index React components in one or more folders by reading local component files and summarizing each component's architectural role. Use when documenting component folders anywhere in a workspace.
argument-hint: Folder path, glob, or natural-language scope describing which React component folders to process
---
Create or replace `index.md` in each requested folder that contains React components.

## Input

The prompt argument may be any of the following:

- One folder path.
- Multiple folder paths.
- A glob-like scope.
- A natural-language request such as "create it for every folder with React components under dashboard".

If the input points to a broad parent folder, treat it as a recursive search scope and process only descendant folders that contain React components.

## Task

1. Resolve the requested scope into one or more target folders.
2. If the request names a broad parent folder or area, search recursively for descendant folders that contain React components and use only those folders as targets.
3. In each target folder, identify the local React component files that should be documented.
4. Read each component file to understand what it renders and its role in that folder.
5. Infer one role for each file using only these labels:
   - `entry-point`
   - `layout`
   - `form`
   - `sub-component`
   - `provider`
6. Write `index.md` into each target folder using the exact structure below.

## Output Format

```md
<One sentence describing the folder scope and its main components. Imperative present tense.>

| File         | Role     | Description |
| ------------ | -------- | ----------- |
| `<filename>` | `<role>` | ...         |
```

## Rules

### Context Sentence

- One line only.
- Imperative present tense.
- End with a period.
- Mention the feature, area, or component group and summarize what the folder covers.

### Table Columns

- `File` uses the filename in backticks.
- `Role` uses exactly one allowed label.
- `Description` is in English, starts with a verb such as `Renders`, `Displays`, or `Wraps`, and stays within about 80 characters.

### Role Labels

- `entry-point`: Root component of the feature, page, or component group.
- `layout`: Visual shell or wrapper with no business logic.
- `form`: Controlled input fields for CRUD operations.
- `sub-component`: Reusable piece consumed within the same local feature or group.
- `provider`: Context or state wrapper.

### Row Order

- Put the `entry-point` row first.
- Sort all remaining rows alphabetically by filename.

## Constraints

- Work only inside folders resolved from the user's request.
- Treat `.tsx` and `.jsx` files as React component candidates. Ignore files that clearly are not React components.
- A folder qualifies as a target only if it directly contains at least one React component file.
- When searching recursively, do not generate `index.md` for parent folders that do not directly contain React components.
- Do not include `index.md` itself in any table.
- Generate one `index.md` per target folder.
- Do not combine files from different folders into the same `index.md`.
- Do not mention this prompt, any source template, or external instructions in the generated file.
- If the user requests a broad scope, process every matching folder that contains React components.
- If a resolved folder has no React component files, skip it and mention that in the chat response.
- If no matching folders contain React component files, stop and explain that no component index can be generated.