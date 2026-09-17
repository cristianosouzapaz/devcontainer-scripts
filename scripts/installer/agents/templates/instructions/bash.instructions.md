---
name: "Bash Rules"
description: "Use when writing or reviewing Bash scripts."
applyTo: "**/*.{sh,bash,bats}"
---

# Bash Rules

## Scope and Structure

- **S1:** Executable Bash scripts MUST begin with `#!/bin/bash`.
- **S2:** Bats test files MUST begin with `#!/usr/bin/env bats`.
- **S3:** Files intended solely for sourcing MUST NOT declare a shebang.
- **S4:** Bash entry scripts MUST declare `set -euo pipefail` immediately after their shebang.
- **S5:** Bash libraries MUST NOT change shell options.

## Naming

- **N1:** Bash function names MUST use snake_case.
- **N2:** Bash local variable names MUST use snake_case.
- **N3:** Environment variable names MUST use SCREAMING_SNAKE_CASE.
- **N4:** Constant names MUST use SCREAMING_SNAKE_CASE.

## Code Design

- **C1:** Bash functions MUST use `name() { }` declaration syntax.
- **C2:** Function-local variables MUST use `local` declarations.
- **C3:** Functions MUST declare local variables before non-declaration statements.
- **C4:** Functions that return data through standard output MUST emit only that data to standard output.
- **C5:** Array declarations MUST specify an indexed or associative type.
- **C6:** Command substitutions MUST use `$()` syntax.
- **C7:** Conditional tests MUST use `[[ ]]` syntax.
- **C8:** Parameter expansions passed as command arguments MUST be double-quoted.

## Behavior and Reliability

- **B1:** Scripts MUST resolve their resources independently of the current working directory.
- **B2:** Scripts that invoke optional commands MUST check command availability with `command -v` first.
- **B3:** Scripts that create temporary files MUST remove them before exit.
- **B4:** Signal handlers MUST terminate the script.
- **B5:** Scripts MUST NOT parse `ls` output.
- **B6:** Scripts MUST prevent launched background processes from outliving the script.

## Documentation

- **D1:** Comments MUST describe constraints or reasons not expressed by the code.
- **D2:** Comments MUST NOT paraphrase adjacent code.
