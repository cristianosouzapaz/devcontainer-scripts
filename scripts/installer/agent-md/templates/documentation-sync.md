---
name: "Documentation Sync"
description: "Requires the Documentation Sync skill to be invoked before editing the documentation tree or the README, and whenever a change affects documented behavior; adds the /documentation-sync audit sweep."
metadata:
  kit-version: "1.3.0"
  kit-tags: docs workflow
  kit-skills: documentation-sync
---
## Documentation Sync

Before editing any file in the project's documentation tree or the `README.md`, and whenever a change affects documented behavior (API, package, toolchain, structure), invoke the **Documentation Sync** skill and follow its procedure — it keeps those docs from contradicting the codebase. Run `/documentation-sync audit` for a full sweep of the docs and README against the code and the doc rules.
