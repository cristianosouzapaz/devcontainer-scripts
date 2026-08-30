# Installer Tests

## `template-lock.test.js`

| Test | Verifies |
| --- | --- |
| Records Claude and Copilot adapters for every generated agent artifact | A v2 lock records canonical instruction and prompt artifacts, their generated Claude symlinks including expected targets, and Copilot adapter files; a removed symlink is pruned during reconciliation |
| Does not create adapters for an unmanaged asset skipped during conflict resolution | Skipping an untracked canonical conflict leaves the asset unrecorded and creates neither Claude nor Copilot adapter |
