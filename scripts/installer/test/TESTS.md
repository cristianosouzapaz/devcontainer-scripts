# Installer Tests

## `template-lock.test.js`

| Test | Verifies |
| --- | --- |
| Records Claude and Copilot adapters for every generated agent artifact | A v2 lock records canonical instruction and prompt artifacts, their generated Claude symlinks including expected targets, and Copilot adapter files; a removed symlink is pruned during reconciliation |
| Does not create adapters for an unmanaged asset skipped during conflict resolution | Skipping an untracked canonical conflict leaves the asset unrecorded and creates neither Claude nor Copilot adapter |

## `skills-catalog.test.js`

| Test | Verifies |
| --- | --- |
| Groups known categories in the picker order and retains catalog order within each category | The category picker follows its curated display order while skills in one category retain their catalog order |
| Places uncategorized additions after known categories in their first-seen order | A future category is still shown after curated categories without losing its catalog order |

## `selection-summary.test.js`

| Test | Verifies |
| --- | --- |
| Formats a compact summary with counted sections | The shared summary uses the standard title, divider, counts, and indented items |
| Omits empty sections | Optional sections with no entries do not add visual noise to the summary |
