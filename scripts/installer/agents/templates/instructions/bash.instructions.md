---
name: "Bash Rules"
description: "Use when writing or reviewing Bash scripts. Covers script headers, naming conventions, function declarations, variables, error handling, logging, idempotency, quoting, and comments."
applyTo: "**/*.{sh,bash,bats}"
---

# Bash Rules

## Script Header

- **Shebang:** An executable Bash script MUST begin with `#!/bin/bash` and MUST NOT use `#!/usr/bin/env bash`. A Bats test file MUST begin with `#!/usr/bin/env bats`. A file that is only sourced into an interactive shell or loaded by Bats `load` (e.g. `test/bats/helper.bash`) carries no shebang.
- **Strict mode:** MUST declare `set -euo pipefail` immediately after the shebang in entry scripts and setup modules. Exception: a script that must degrade rather than abort (e.g. a status line renderer) omits it, with a one-line `# why:`.
- **Library strict mode:** MUST NOT declare `set -euo pipefail` in pure library files; they inherit the caller's shell options.
- **Sourcing guard:** MUST include a sourcing guard immediately after the shebang in every pure library file to prevent double-loading. Guard variable MUST be `_<PATH>_SH_LOADED`, where `<PATH>` is the file's path relative to its library root, without `.sh`, in SCREAMING_SNAKE_CASE (`/` and `-` become `_`).
  - ✓ `[[ -n "${_PERSISTENT_DATA_LOCKS_SH_LOADED:-}" ]] && return 0; readonly _PERSISTENT_DATA_LOCKS_SH_LOADED=1` (for `persistent-data/locks.sh`)
- **Fake commands:** A fake command a test writes out as a `#!/bin/sh` script is POSIX sh, not Bash; these rules (e.g. `[[ ]]`) do not apply to its body.

## Naming

- **File names:** MUST use `kebab-case`.
- **Module file names:** MUST use the module identifier in kebab-case (e.g. `git.sh`). Every module MUST declare `MODULE_NAME`, `MODULE_DESCRIPTION`, `MODULE_ENTRY`, and `MODULE_AFTER`; the filename MUST be `<MODULE_NAME>.sh`.
- **Function names:** MUST use `snake_case`.
- **Internal functions:** MUST NOT be prefixed with `_`. A function is looked up at its definition, where its header already describes it; a prefix would add nothing there. A variable is read at its use sites, far from its declaration, which is why variables carry the prefix and functions do not.
  - ✓ `validate_token`
  - ✗ `_validate_token`
- **Global constants:** MUST use `SCREAMING_SNAKE_CASE`.
- **Internal constants:** MUST be prefixed with `_` and use `SCREAMING_SNAKE_CASE`.
- **Prefix scope:** `_` marks what never leaves its own file; a project-specific prefix marks what does. A name published for other files MUST carry the project prefix and MUST NOT carry `_`; a name confined to one file MUST carry `_` and MUST NOT carry the project prefix. The two answer different questions — `_` tells a reader not to touch it, the project prefix keeps the runtime from colliding — so a published name needs the second even though it is not private. `_` is a note, not a namespace: every library following the convention shares the same `_*` space, so on its own it prevents no collision.
- **Local variables:** MUST use `snake_case` within functions.
- **Environment variables:** MUST use `SCREAMING_SNAKE_CASE`.

## Function Declarations

- **Form:** MUST use the `name() { }` form. MUST NOT use the `function` keyword.
  - ✓ `validate_token() { ... }`
  - ✗ `function validate_token() { ... }`
- **Local vars:** MUST declare all local variables with `local` at or near the top of the function body, before any logic.
- **Return path:** MUST use `echo` or `printf` as the only output mechanism for functions that return a value via stdout. MUST NOT mix logging into the return path.
- **Export:** A sourced file (a library, a setup module) MUST export its functions at the bottom with `export -f`. An executed script MAY omit it.

## Variables

- **Immutable values:** MUST declare truly immutable values (colors, symbols, fixed string literals) with `readonly`.
- **Test seams:** MUST NOT declare with `readonly` behavioral thresholds, numeric defaults, or path constants that test code may need to override. Use the `_` prefix alone to signal they are internal.
- **Arrays:** MUST declare the array type — `-a` for indexed arrays and `-A` for associative arrays. Inside a function use `local -a` / `local -A`; at file scope use `declare -a` / `declare -A`.
- **Integer arithmetic:** MUST use `var=$(( var + 1 ))` for integer assignment. MUST NOT use `expr`.
- **Standalone arithmetic:** MUST append `|| true` when using `(( expr ))` as a standalone statement outside `if`/`while` to prevent unexpected exit under `set -e` when the expression evaluates to zero.

## Sourcing and Imports

- **Single loader:** MUST source shared utilities exclusively through a single loader file. MUST NOT source individual utility files directly from modules.
- **Path anchors:** The loader MUST derive the absolute directory anchors of the script tree once, from its own `${BASH_SOURCE[0]}`, and publish them for the rest of the scripts. Every other file MUST read a path from those anchors. MUST NOT re-derive the tree layout anywhere else.
- **Namespaced globals:** Published anchors and any other global the loader declares `readonly` MUST carry a project-specific prefix. An unprefixed common name (`CONFIG_DIR`, `BIN_DIR`, …) collides with the caller's environment: assigning to a `readonly` variable fails, which aborts the run under `set -e`.
- **Bootstrap hop:** The one `..` hop allowed anywhere is the bootstrap line by which a file locates the loader, and it MUST be absolutized on the spot with `cd … && pwd`.
  - ✓ `source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../lib" && pwd)/loader.sh"`
  - ✗ `source "$(dirname "${BASH_SOURCE[0]}")/../lib/loader.sh"`
- **No assumed CWD:** MUST NOT resolve a path against the working directory — no bare relative path, no `$PWD`- or `$(pwd)`-anchored path. A script may be invoked from anywhere, may `cd` elsewhere mid-run, and may be installed at a different location than the one it was written at.
- **Symlinked entry points:** A script reachable through a symlink MUST resolve `${BASH_SOURCE[0]}` through the link (`readlink -f`) before deriving anything from it; otherwise it anchors on the link's directory instead of its own.

## Error Handling

- **Trap registry:** The orchestrator/registry MUST own `ERR`, `EXIT`, `INT`, and `TERM` traps. Module entries MUST NOT install traps.
- **Cleanup registration:** MUST register cleanup logic via a dedicated cleanup registration function. MUST NOT set `trap` directly inside modules.
- **Cleanup return:** Cleanup handlers MUST always `return 0` so they never block subsequent cleanup execution.
- **Intentional suppression:** MAY use `|| true` to intentionally suppress errors for non-critical commands.
- **No silent propagation:** MUST NOT use `|| true` to silence errors that should be propagated or logged.
- **Sensitive cleanup:** MUST register sensitive variable cleanup as a cleanup handler, not performed inline.
- **ERR needs errtrace:** An `ERR` trap MUST be paired with `set -E`. Without it Bash does not run the trap inside functions or subshells, so a failure there is never recorded.
- **Errexit inheritance:** Module subshells MUST enable `shopt -s inherit_errexit` alongside `set -eEuo pipefail`.
- **Whole steps:** Call a whole step bare under live errexit; `|| return 1` exempts its call tree.
- **Signal handlers exit:** An `INT` or `TERM` handler MUST end with `exit` (130 for `INT`, 143 for `TERM`). A handler that returns resumes the script at the next command, so the signal no longer stops the run. Cleanups belong to the `EXIT` trap, which the `exit` triggers.
- **Conditional context:** A command tested by `if`, `while`, `!`, `||` or `&&` runs its whole call tree with `set -e` and the `ERR` trap off. MUST NOT call a function that runs a whole step (a module entry, a module plan) in such a context: turn `errexit` off, call it bare, read `$?`, then restore `errexit` to its previous state.

## Logging

- **Centralized logger:** MUST use a centralized logging library with named log-level functions. MUST NOT use `echo` for user-facing messages. Exception: a script that runs before or without the shared library (e.g. the standalone installer bootstrap) defines its own minimal logger writing to stderr. A command's result printed to stdout (a table, a status word) is output, not a log message.
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
  - Exception: with `errexit` explicitly turned off around the call (the *Conditional context* rule), a bare call followed by `exit_code=$?` is required.
  - Exception: a helper that must finalize after running a whole step (restore a directory, release a lock) calls it bare and captures on the next line (`"$@"` then `rc=$?`): under live errexit a failure stops the process and the finalization is moot; under a caller's `if`/`||` the status is captured and the finalization runs.

## Module Structure

- **Metadata:** Every discoverable module MUST declare structured metadata comments (`MODULE_NAME`, `MODULE_DESCRIPTION`, `MODULE_ENTRY`, `MODULE_AFTER`) immediately after the shebang and `set` options to support auto-discovery.
- **Entry match:** The entry-point metadata value MUST exactly match the name of the module's public entry function.
- **Order:** Modules MUST follow this top-to-bottom order:
  1. Shebang + `set -euo pipefail`
  2. Module metadata comments
  3. `# ----- OVERVIEW -----` block
  4. Source the project's shared loader
  5. Configuration variable list, when the module reads any
  6. Internal constants
  7. Internal helper functions
  8. Public entry function (matching the entry-point metadata)
  9. `export -f` line
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
- **Directory listing:** MUST NOT iterate over or parse `ls` output to find files; use glob expansion in `for` loops instead. A test MAY compare `ls -A` output to assert a directory's exact contents.

## Comments and Documentation

- **Body comments:** Only two forms are allowed inside a function or `@test` body; code outside functions counts as a body:
  - `# why: <reason>` on one line, for a non-obvious reason tied to that statement.
  - `# shellcheck` directives.
- **Step labels:** A step label ("what") MUST be deleted, or become a named function when the step is a real sub-operation. A function MUST NOT be split just to remove a why.
- **Long reasons:** A longer reason MUST go to the function header under `Notes:`.
- **Shared reasons:** A reason shared by several call sites MUST go to the `Notes:` of the helper that embodies the pattern, when it can be extracted without a behaviour change; otherwise each site MUST keep a one-line `# why:`.
- **Wiki:** Mechanics MUST NOT move to the wiki: the wiki describes behaviour, and the code owns the technical why.
- **Function header:** Every internal and public function MUST have a function header in this form:
  ```bash
  # <name> <args>: <purpose — "prints …" when stdout is the result, "sets VAR" when a caller reads it>
  # Returns: <only when not plain 0 = success / non-zero = failure>
  # Notes: <the why moved out of the body>
  ```
  - The first line is mandatory for every function, public or internal.
  - `Returns:` and `Notes:` are optional and are the only labels allowed.
  - `Args:`, `Arguments:`, `Usage:` and free-form lines are folded into these.
- **Module metadata:** `MODULE_*` metadata comments MUST keep their exact `# MODULE_<KEY>="…"` form; they are machine-read.
- **File header:** An `OVERVIEW` in modules or a file header in `lib/` MUST be present and short. It states the file's responsibility and any file-wide why. A single function's mechanics move to that function's `Notes:`. The file header is the first comment block after the shebang and preamble lines (`set` options, the sourcing guard).
- **Configuration variables:** The configuration variable list MUST be kept complete (names only), under a `README.md#configuration-variables` link. Only variables the README does not document (e.g. `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PERSISTENT_DATA_HOME`) MAY carry a short technical note.
- **Constants:** Constants and internal globals MUST carry no comment, or a one-line `# why:`.
- **Section headers:** MUST use a consistent dash-separator format: `# ----- X -----`.
- **Test annotations:** The only comments allowed above a `@test` are: `# contract:`, `# group:` and an optional `# Notes:`.
- **Allowed comments:** The only comments allowed anywhere MUST be: file header/`OVERVIEW`, `MODULE_*` metadata, separators, the configuration variable list, function headers, test annotations, one-line `# why:`, and `# shellcheck` directives.
- **No issue references:** MUST NOT include issue tracker references (no `#<n>`) in a comment or string anywhere in code or tests, including `skip`. A skipped test for a known bug describes the bug in words.
- **No TODO/FIXME:** MUST NOT leave TODO/FIXME comments in committed code; open an issue instead.
