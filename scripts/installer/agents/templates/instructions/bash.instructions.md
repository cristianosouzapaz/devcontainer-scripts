---
name: "Bash Rules"
description: "Use when writing or reviewing Bash scripts. Covers script headers, naming conventions, function declarations, variables, error handling, logging, idempotency, and quoting."
applyTo: "**/*.sh"
---

# Bash Rules

## Script Header

- Every script **MUST** begin with `#!/bin/bash`. **DO NOT** use `#!/usr/bin/env bash`.
- Entry scripts (run directly) and setup modules (which carry a shebang to support standalone execution in addition to being sourced) **MUST** declare `set -euo pipefail` immediately after the shebang.
- Pure library files (only ever sourced, never executed directly) **MUST NOT** declare `set -euo pipefail`; they inherit the caller's shell options.
- Every pure library file **MUST** include a sourcing guard immediately after the shebang to prevent double-loading (analogous to `#pragma once`). The guard variable **MUST** follow the pattern `_<FILENAME_SNAKE>_LOADED`.

## Naming

- Files **MUST** use `kebab-case`.
- Setup module files **MUST** use a two-digit numeric prefix followed by a kebab-case name.
- Functions **MUST** use `snake_case`.
- Internal (non-exported) functions **MUST** be prefixed with `_`.
- Global constants **MUST** use `SCREAMING_SNAKE_CASE`.
- Internal constants **MUST** be prefixed with `_` and use `SCREAMING_SNAKE_CASE`.
- Local variables within functions **MUST** use `snake_case`.
- Environment/configuration variables **MUST** use `SCREAMING_SNAKE_CASE`.

## Function Declarations

- **MUST** use the `name() { }` form. **DO NOT** use the `function` keyword.
- All local variables **MUST** be declared with `local` at or near the top of the function body, before any logic.
- Functions that return a value via stdout **MUST** use `echo` or `printf` as their only output mechanism and **MUST NOT** mix logging into the return path.
- Exported functions **MUST** be explicitly exported at the bottom of the file with `export -f`.

## Variables

- Truly immutable values (colors, symbols, fixed string literals) **MUST** be declared with `readonly`.
- Behavioral thresholds, numeric defaults, and path constants that test code may need to override **MUST NOT** be declared with `readonly`; use the `_` prefix alone to signal they are internal. **DO NOT** use `readonly` on variables that are valid test seams.
- **MUST** use `local` for all function-scoped variables. **DO NOT** let variables leak into the global scope.
- For quoting rules, see the **Quoting** section.
- **MUST** use `declare -a` for arrays and `declare -A` for associative arrays.
- **MUST** use `var=$(( var + 1 ))` for integer assignment. **DO NOT** use `expr` (external process).
- When using `(( expr ))` as a standalone statement (not inside `if`/`while`), **MUST** append `|| true` to prevent unexpected exit under `set -e` when the expression evaluates to zero.

## Sourcing and Imports

- Modules **MUST** source shared utilities exclusively through a single loader file. **DO NOT** source individual utility files directly from modules.
- **MUST** resolve the source path relative to `${BASH_SOURCE[0]}` to ensure portability across execution contexts.
- **DO NOT** assume a working directory; always derive paths from `BASH_SOURCE[0]` or an explicitly set `SCRIPT_DIR`.

## Error Handling

- **MUST** use a centralized trap registry in module entry functions to register `ERR`, `EXIT`, `INT`, and `TERM` traps.
- **MUST** register cleanup logic via a dedicated cleanup registration function; **DO NOT** set `trap` directly inside modules.
- Cleanup handlers **MUST** always `return 0` so they never block subsequent cleanup execution.
- Use `|| true` to intentionally suppress errors for non-critical commands.
- **DO NOT** use `|| true` to silence errors that should be propagated or logged.
- Sensitive variable cleanup **MUST** be registered as a cleanup handler, not performed inline.

## Logging

- **MUST** use a centralized logging library with named log-level functions. **DO NOT** use `echo` for user-facing messages. Exception: scripts that run before shared utilities are loaded may use `echo` to stderr for fatal errors.
- The fatal log-level function **MUST** only be called for unrecoverable errors; it exits the process.
- The error log-level function **MUST** be used for recoverable errors; the caller decides whether to return or continue.
- The debug log-level function **MUST** be used for any trace-level detail useful during development or troubleshooting.

## Idempotency

- All setup modules **MUST** be safe to re-run without side effects.
- **MUST** check preconditions (already installed, already configured) and return early with `return 0` when the desired state already exists.
- Use a dedicated skip mechanism when a module cannot apply due to a missing optional dependency or environment variable, then `return 0`. **DO NOT** call `exit`.
- Guard patterns **MUST** be explicit and logged at debug level.

## Return Values

- **MUST** return `0` for success and a non-zero code for failure. **DO NOT** use undocumented non-zero codes.
- Functions that produce output **MUST** return it via `echo`/`printf` to stdout; callers capture it with `$( )`.
- **MUST** capture command substitution into a named variable before use. **DO NOT** use the output of a command substitution directly in a condition without first capturing it; this obscures errors.

## Module Structure

- Every discoverable module **MUST** declare structured metadata comments (name, description, entry point) immediately after the shebang and `set` options to support auto-discovery.
- The entry-point metadata value **MUST** exactly match the name of the module's public entry function.
- Modules **MUST** follow this top-to-bottom order:
  1. Shebang + `set -euo pipefail`
  2. Module metadata comments
  3. Source the project's shared loader
  4. Internal constants
  5. Internal helper functions (prefixed with `_`)
  6. Public entry function (matching the entry-point metadata)
- **DO NOT** execute any side-effecting code at the top level of a module; all logic **MUST** live inside functions.

## Quoting

- **MUST** double-quote all variable and parameter expansions.
- **MUST** use single quotes for truly literal strings where no expansion is intended.
- **MUST** double-quote glob patterns only when they **must not** expand. Unquoted globs are intentional only in `for` loops over filesystem paths.
- Here-strings (`<<<`) **MUST** use double quotes when the string contains variables; use single quotes for literals.

## Subshells and Process Substitution

- **MUST** use `source` (not subshells) when the called script needs to modify the current environment.
- **MUST** use command substitution `$( )` (not backticks) to capture output.
- **MUST** prefer input redirection (`< file`) over piping `cat file |` to avoid unnecessary subshells.
- Avoid pipelines where the exit status of intermediate commands must be checked; capture output into variables instead.

## String and Path Handling

- **MUST** use `[[ ]]` for all conditional tests. **DO NOT** use `[ ]` or `test`.
- **MUST** use `command -v "$name" >/dev/null 2>&1` to test command availability; the redirect silences both stdout and stderr.
- **MUST** use parameter expansion defaults rather than separate `if` blocks for simple fallbacks.
- **DO NOT** parse the output of `ls`; use glob expansion in `for` loops instead.

## Comments and Documentation

- Public functions **MUST** have a comment block immediately above them describing purpose, arguments, and return value.
- Internal helper functions **SHOULD** have at minimum a single-line comment describing their purpose.
- Section headers **MUST** use a consistent dash-separator format.
- Configuration variables **MUST** be documented with their type, purpose, and default value in a comment block.
- **DO NOT** leave TODO/FIXME comments in committed code; open an issue instead.
