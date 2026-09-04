---
name: "Bash Rules"
description: "Use when writing or reviewing Bash scripts. Covers script headers, naming conventions, function declarations, variables, error handling, logging, idempotency, and quoting."
applyTo: "**/*.sh"
---

# Bash Rules

## Script Header

- **Shebang:** MUST begin with `#!/bin/bash`. MUST NOT use `#!/usr/bin/env bash`.
- **Strict mode:** MUST declare `set -euo pipefail` immediately after the shebang in entry scripts and setup modules.
- **Library strict mode:** MUST NOT declare `set -euo pipefail` in pure library files; they inherit the caller's shell options.
- **Sourcing guard:** MUST include a sourcing guard immediately after the shebang in every pure library file to prevent double-loading. Guard variable MUST follow the pattern `_<FILENAME_SNAKE>_LOADED`.
  - ✓ `[[ -n "${_MY_LIB_LOADED:-}" ]] && return 0; readonly _MY_LIB_LOADED=1`

## Naming

- **File names:** MUST use `kebab-case`.
- **Module file names:** MUST use the module identifier in kebab-case (e.g. `git.sh`). Every module MUST declare `MODULE_NAME`, `MODULE_DESCRIPTION`, `MODULE_ENTRY`, and `MODULE_AFTER`; the filename MUST be `<MODULE_NAME>.sh`.
- **Function names:** MUST use `snake_case`.
- **Internal functions:** MUST NOT be prefixed with `_`. Public vs internal is signaled by the comment convention (block vs single-line), not by a name prefix.
  - ✓ `validate_token`
  - ✗ `_validate_token`
- **Global constants:** MUST use `SCREAMING_SNAKE_CASE`.
- **Internal constants:** MUST be prefixed with `_` and use `SCREAMING_SNAKE_CASE`.
- **Local variables:** MUST use `snake_case` within functions.
- **Environment variables:** MUST use `SCREAMING_SNAKE_CASE`.

## Function Declarations

- **Form:** MUST use the `name() { }` form. MUST NOT use the `function` keyword.
  - ✓ `validate_token() { ... }`
  - ✗ `function validate_token() { ... }`
- **Local vars:** MUST declare all local variables with `local` at or near the top of the function body, before any logic.
- **Return path:** MUST use `echo` or `printf` as the only output mechanism for functions that return a value via stdout. MUST NOT mix logging into the return path.
- **Export:** MUST explicitly export functions at the bottom of the file with `export -f`.

## Variables

- **Immutable values:** MUST declare truly immutable values (colors, symbols, fixed string literals) with `readonly`.
- **Test seams:** MUST NOT declare with `readonly` behavioral thresholds, numeric defaults, or path constants that test code may need to override. Use the `_` prefix alone to signal they are internal.
- **Arrays:** MUST use `declare -a` for indexed arrays and `declare -A` for associative arrays.
- **Integer arithmetic:** MUST use `var=$(( var + 1 ))` for integer assignment. MUST NOT use `expr`.
- **Standalone arithmetic:** MUST append `|| true` when using `(( expr ))` as a standalone statement outside `if`/`while` to prevent unexpected exit under `set -e` when the expression evaluates to zero.

## Sourcing and Imports

- **Single loader:** MUST source shared utilities exclusively through a single loader file. MUST NOT source individual utility files directly from modules.
- **Relative path:** MUST resolve the source path relative to `${BASH_SOURCE[0]}` to ensure portability.
- **No assumed CWD:** MUST NOT assume a working directory; always derive paths from `BASH_SOURCE[0]` or an explicitly set `SCRIPT_DIR`.

## Error Handling

- **Trap registry:** MUST use a centralized trap registry in module entry functions to register `ERR`, `EXIT`, `INT`, and `TERM` traps.
- **Cleanup registration:** MUST register cleanup logic via a dedicated cleanup registration function. MUST NOT set `trap` directly inside modules.
- **Cleanup return:** Cleanup handlers MUST always `return 0` so they never block subsequent cleanup execution.
- **Intentional suppression:** MAY use `|| true` to intentionally suppress errors for non-critical commands.
- **No silent propagation:** MUST NOT use `|| true` to silence errors that should be propagated or logged.
- **Sensitive cleanup:** MUST register sensitive variable cleanup as a cleanup handler, not performed inline.

## Logging

- **Centralized logger:** MUST use a centralized logging library with named log-level functions. MUST NOT use `echo` for user-facing messages. Exception: scripts that run before shared utilities are loaded may use `echo` to stderr for fatal errors.
- **Fatal level:** MUST call the fatal log-level function only for unrecoverable errors; it exits the process.
- **Error level:** MUST use the error log-level function for recoverable errors; the caller decides whether to return or continue.
- **Debug level:** MUST use the debug log-level function for any trace-level detail useful during development or troubleshooting.
- **No re-logging formatted output:** MUST NOT capture output that already passed through the logging library and pass it through the logger again. Only raw, unformatted output (e.g. third-party command output) should be captured and logged; re-logging already-formatted lines duplicates their prefix/formatting.

## Idempotency

- **Re-run safety:** All setup modules MUST be safe to re-run without side effects.
- **Early return:** MUST check preconditions (already installed, already configured) and return early with `return 0` when the desired state already exists.
- **Skip mechanism:** MUST use a dedicated skip mechanism when a module cannot apply due to a missing optional dependency or environment variable, then `return 0`. MUST NOT call `exit`.
- **Guard logging:** Guard patterns MUST be explicit and logged at debug level.

## Return Values

- **Exit codes:** MUST return `0` for success and a non-zero code for failure. MUST NOT use undocumented non-zero codes.
- **Output via stdout:** Functions that produce output MUST return it via `echo`/`printf` to stdout; callers capture it with `$( )`.
- **Capture before use:** MUST capture command substitution into a named variable before use. MUST NOT use the output of a command substitution directly in a condition without first capturing it; this obscures errors.
  - ✓ `local result; result=$(get_value); [[ -n "$result" ]]`
  - ✗ `[[ -n "$(get_value)" ]]`
- **Exit code capture under `set -e`:** MUST capture a command's exit code with `cmd || var=$?` as a single statement, never as a bare command followed by a separate `var=$?` line. Under `set -e` (inherited by subshells), a bare failing command aborts execution before the following line ever runs, silently skipping the capture.
  - ✓ `exit_code=0; cmd || exit_code=$?`
  - ✗ `cmd` then `exit_code=$?` on the next line

## Module Structure

- **Metadata:** Every discoverable module MUST declare structured metadata comments (name, description, entry point) immediately after the shebang and `set` options to support auto-discovery.
- **Entry match:** The entry-point metadata value MUST exactly match the name of the module's public entry function.
- **Order:** Modules MUST follow this top-to-bottom order:
  1. Shebang + `set -euo pipefail`
  2. Module metadata comments
  3. Source the project's shared loader
  4. Internal constants
  5. Internal helper functions
  6. Public entry function (matching the entry-point metadata)
- **No top-level logic:** MUST NOT execute any side-effecting code at the top level of a module; all logic MUST live inside functions.

## Quoting

- **Variable expansions:** MUST double-quote all variable and parameter expansions.
- **Literal strings:** MUST use single quotes for truly literal strings where no expansion is intended.
- **Glob patterns:** MUST double-quote glob patterns only when they must not expand. Unquoted globs are intentional only in `for` loops over filesystem paths.
- **Here-strings:** MUST use double quotes in here-strings (`<<<`) when the string contains variables; use single quotes for literals.

## Subshells and Process Substitution

- **Environment modification:** MUST use `source` (not subshells) when the called script needs to modify the current environment.
- **Command substitution:** MUST use `$( )` to capture output. MUST NOT use backticks.
  - ✓ `result=$(get_value)`
  - ✗ `` result=`get_value` ``
- **Input redirection:** MUST prefer input redirection (`< file`) over piping `cat file |` to avoid unnecessary subshells.
- **Pipeline exit status:** SHOULD avoid pipelines where the exit status of intermediate commands must be checked; capture output into variables instead.
- **Background processes:** MUST NOT launch a background process (`cmd &`) from inside a command substitution, process substitution, or pipeline stage. The forked process becomes a child of that subshell, not of the calling shell, and is orphaned — untracked and unkillable by the caller — the moment the subshell exits.

## String and Path Handling

- **Conditionals:** MUST use `[[ ]]` for all conditional tests. MUST NOT use `[ ]` or `test`.
  - ✓ `[[ -f "$path" ]]`
  - ✗ `[ -f "$path" ]`
- **Command availability:** MUST use `command -v "$name" >/dev/null 2>&1` to test command availability.
- **Parameter defaults:** MUST use parameter expansion defaults rather than separate `if` blocks for simple fallbacks.
- **Directory listing:** MUST NOT parse the output of `ls`; use glob expansion in `for` loops instead.

## Comments and Documentation

- **Public functions:** MUST have a comment block immediately above them describing purpose, arguments, and return value.
- **Internal functions:** SHOULD have at minimum a single-line comment describing their purpose.
- **Section headers:** MUST use a consistent dash-separator format.
- **Config variables:** MUST be documented with their type, purpose, and default value in a comment block.
- **No TODO/FIXME:** MUST NOT leave TODO/FIXME comments in committed code; open an issue instead.
