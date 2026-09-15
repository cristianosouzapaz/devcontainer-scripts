#!/bin/bash

[[ -n "${_ERROR_HANDLER_SH_LOADED:-}" ]] && return 0
readonly _ERROR_HANDLER_SH_LOADED=1

# Core error handler module
#
# This module provides a structured error handling system for the setup scripts.
# It captures errors, maintains an error stack with context, supports cleanup
# handlers, and can dump the error stack on exit for debugging. It is designed to
# be sourced by other scripts to provide consistent error handling behavior.

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# This module uses the following configuration variables:
#
# DUMP_ERROR_STACK        Print the error stack on exit (true/false)
#                         Default: true (set by loader.sh)

# ----- ERROR CODE CONSTANTS ---------------------------------------------------

readonly DEVCONTAINER_FATAL_ERROR=1
# shellcheck disable=SC2034 # consumed by modules/git.sh
readonly DEVCONTAINER_VALIDATION_ERROR=2
# shellcheck disable=SC2034 # consumed by modules/git.sh
readonly DEVCONTAINER_AUTH_ERROR=4
# shellcheck disable=SC2034 # consumed by modules/ngrok.sh
readonly DEVCONTAINER_NETWORK_ERROR=8

# ----- INTERNAL STATE ---------------------------------------------------------

declare -a _ERROR_STACK=()
declare -a _CLEANUP_HANDLERS=()
declare -a _MODULE_CLEANUP_HANDLERS=()
_ERROR_LAST_DEPTH=0
_ERROR_LAST_CODE=0
_ERROR_LAST_LINE=0

# ----- FUNCTIONS --------------------------------------------------------------

# register_cleanup: register a cleanup handler to be run on exit.
# Usage: register_cleanup handler_name_or_command
register_cleanup() {
	local handler="$1"
	_CLEANUP_HANDLERS+=("$handler")
}

# run_cleanup_handlers: execute all registered cleanup handlers in LIFO order.
# Failures are recorded via push_error but do not stop subsequent handlers.
run_cleanup_handlers() {
	local i handler rc
	if [[ "${#_CLEANUP_HANDLERS[@]}" -eq 0 ]]; then
		return 0
	fi
	for ((i = ${#_CLEANUP_HANDLERS[@]} - 1; i >= 0; i--)); do
		handler="${_CLEANUP_HANDLERS[$i]}"
		if declare -F "$handler" >/dev/null 2>&1; then
			"$handler" || rc=$?
		else
			eval "$handler" || rc=$?
		fi
		if [[ -n "${rc:-}" && "$rc" -ne 0 ]]; then
			push_error "$rc" "${LINENO}" "CLEANUP:${handler}" "${handler}" "cleanup failed"
			rc=0
		fi
	done
	return 0
}

# register_module_cleanup: register a cleanup handler scoped to the current module, kept apart
# from the process-wide registry above. run_module (setup/lib/module-registry.sh) runs these
# handlers in the parent right after the module's subshell ends — success, failure or skip alike —
# then clears the list, so a module's own secrets (a clone token, an auth token, a signing key)
# never reach the next module. on_exit also runs any handler still pending, as a backstop for a
# signal delivered to the parent mid-module.
# Usage: register_module_cleanup handler_name_or_command
register_module_cleanup() {
	local handler="$1"
	_MODULE_CLEANUP_HANDLERS+=("$handler")
}

# run_module_cleanup_handlers: execute all module-scoped cleanup handlers in LIFO order,
# exactly like run_cleanup_handlers. Failures are recorded via push_error but do not stop
# subsequent handlers. Clears the registry afterward so each handler runs at most once.
run_module_cleanup_handlers() {
	local i handler rc
	if [[ "${#_MODULE_CLEANUP_HANDLERS[@]}" -eq 0 ]]; then
		return 0
	fi
	for ((i = ${#_MODULE_CLEANUP_HANDLERS[@]} - 1; i >= 0; i--)); do
		handler="${_MODULE_CLEANUP_HANDLERS[$i]}"
		if declare -F "$handler" >/dev/null 2>&1; then
			"$handler" || rc=$?
		else
			eval "$handler" || rc=$?
		fi
		if [[ -n "${rc:-}" && "$rc" -ne 0 ]]; then
			push_error "$rc" "${LINENO}" "MODULE_CLEANUP:${handler}" "${handler}" "cleanup failed"
			rc=0
		fi
	done
	_MODULE_CLEANUP_HANDLERS=()
	return 0
}

# push_error: Push an error record onto the internal error stack.
# Usage: push_error [code] [lineno] [func] [cmd] [message]
# Args:
#   code: numeric error code (default: $DEVCONTAINER_FATAL_ERROR)
#   lineno: line number where the error occurred (default: 0)
#   func: function name or context (default: MAIN)
#   cmd: command string that failed or triggered the error
#   message: optional human-readable message
# Returns:
#   Appends a serialized error entry to the `_ERROR_STACK` array, and records
#   the caller's depth, call site and status so `handle_error` does not record
#   the same failure again as it propagates to that call site.
push_error() {
	local code="${1:-$DEVCONTAINER_FATAL_ERROR}"
	shift || true
	local lineno="${1:-0}"
	shift || true
	local func="${1:-MAIN}"
	shift || true
	local cmd="${1:-}"
	shift || true
	local msg="${*:-}"
	_ERROR_STACK+=("${code}|${lineno}|${func}|${cmd}|${msg}")
	_ERROR_LAST_DEPTH=${#FUNCNAME[@]}
	_ERROR_LAST_LINE=${BASH_LINENO[1]:-0}
	_ERROR_LAST_CODE=$code
}

# dump_error_stack: Print all errors currently stored in the error stack.
# Usage: dump_error_stack
# Args: none
# Returns: prints a numbered list of error entries. Each line contains
#          index, code, lineno, func, cmd, and message. Returns 0 if
#          the stack is empty or after printing.
dump_error_stack() {
	if [[ "${#_ERROR_STACK[@]}" -eq 0 ]]; then
		return 0
	fi
	local i entry code lineno func cmd msg line
	for i in "${!_ERROR_STACK[@]}"; do
		entry="${_ERROR_STACK[$i]}"
		IFS='|' read -r code lineno func cmd msg <<<"$entry"
		line=$(printf '%s: code=%s lineno=%s func=%s cmd=%s msg=%s' "$((i + 1))" "$code" "$lineno" "$func" "$cmd" "${msg:-}")
		log_error "$line"
	done
}

# handle_error: ERR trap handler. Records the failing command with its context.
# Skips only the same status one frame up at the tracked caller site; every ERR,
# including skipped propagation, updates the tracked depth, caller site and status.
handle_error() {
	local exit_code=$?
	# The registry imports the origin from the child, not the subshell command.
	[[ "${_MODULE_WAITING:-false}" != true ]] || return 0
	local depth=${#FUNCNAME[@]}
	if [[ "$depth" -ne $(( _ERROR_LAST_DEPTH - 1 )) ||
		"${BASH_LINENO[0]:-0}" != "$_ERROR_LAST_LINE" ||
		"$exit_code" != "$_ERROR_LAST_CODE" ]]; then
		push_error "$exit_code" "${BASH_LINENO[0]:-0}" "${FUNCNAME[1]:-MAIN}" "${BASH_COMMAND:-}" ""
	fi
	_ERROR_LAST_DEPTH=$depth
	_ERROR_LAST_LINE=${BASH_LINENO[1]:-0}
	_ERROR_LAST_CODE=$exit_code
}

# on_sigint: Signal handler for SIGINT (Ctrl-C).
# Usage: on_sigint
# Args: none
# Behavior: records SIGINT, then exits with 130; EXIT runs cleanups and dumps errors.
on_sigint() {
	push_error 130 "${LINENO}" "SIGINT" "SIGINT received"
	exit 130
}

# on_sigterm: Signal handler for SIGTERM.
# Usage: on_sigterm
# Args: none
# Behavior: records SIGTERM, then exits with 143; EXIT runs cleanups and dumps errors.
on_sigterm() {
	push_error 143 "${LINENO}" "SIGTERM" "SIGTERM received"
	exit 143
}

# on_exit: EXIT trap handler invoked when the script exits.
# Usage: on_exit
# Args: none
# Behavior: runs all registered cleanup handlers in LIFO order, then
#           prints the accumulated error stack if `DUMP_ERROR_STACK` is true
#           and the stack is non-empty. Always returns 0 so it never
#           blocks the EXIT trap chain.
on_exit() {
	# Backstop: a signal or fatal exit mid-module can leave module cleanups pending, since
	# run_module normally runs them in the parent after the module subshell ends.
	run_module_cleanup_handlers || true
	# Always attempt to run registered (process-wide) cleanup handlers next.
	run_cleanup_handlers || true

	if [[ "${DUMP_ERROR_STACK}" == "true" && "${#_ERROR_STACK[@]}" -gt 0 ]]; then
		dump_error_stack
	fi
	return 0
}

# setup_error_traps: Install standard error and signal traps.
# Usage: setup_error_traps
# Args: none
# Behavior: enables ERR inheritance in functions and subshells; wires
#           `handle_error` to `ERR`, `on_exit` to `EXIT`, and signal handlers
#           for `INT` and `TERM` to their respective handlers, ending the run
#           with 130/143 after EXIT cleanup. Call this once during script
#           initialization to enable the error handler system.
setup_error_traps() {
	set -E
	trap 'handle_error' ERR
	trap 'on_exit' EXIT
	trap 'on_sigint' INT
	trap 'on_sigterm' TERM
}

export -f push_error dump_error_stack handle_error setup_error_traps on_sigint on_sigterm on_exit register_cleanup run_cleanup_handlers register_module_cleanup run_module_cleanup_handlers
