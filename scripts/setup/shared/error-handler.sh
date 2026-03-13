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
# - DUMP_ERROR_STACK

# ----- ERROR CODE CONSTANTS ---------------------------------------------------

readonly FATAL_ERROR=1
readonly VALIDATION_ERROR=2
readonly AUTH_ERROR=4
readonly NETWORK_ERROR=8

# ----- INTERNAL STATE ---------------------------------------------------------

declare -a _ERROR_STACK=()
declare -a _CLEANUP_HANDLERS=()

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

# push_error: Push an error record onto the internal error stack.
# Usage: push_error [code] [lineno] [func] [cmd] [message]
# Args:
#   code: numeric error code (default: $FATAL_ERROR)
#   lineno: line number where the error occurred (default: 0)
#   func: function name or context (default: MAIN)
#   cmd: command string that failed or triggered the error
#   message: optional human-readable message
# Returns:
#   Appends a serialized error entry to the `_ERROR_STACK` array.
push_error() {
	local code="${1:-$FATAL_ERROR}"
	shift || true
	local lineno="${1:-0}"
	shift || true
	local func="${1:-MAIN}"
	shift || true
	local cmd="${1:-}"
	shift || true
	local msg="${*:-}"
	_ERROR_STACK+=("${code}|${lineno}|${func}|${cmd}|${msg}")
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
	local i entry code lineno func cmd msg
	for i in "${!_ERROR_STACK[@]}"; do
		entry="${_ERROR_STACK[$i]}"
		IFS='|' read -r code lineno func cmd msg <<<"$entry"
		printf '%s: code=%s lineno=%s func=%s cmd=%s msg=%s\n' "$((i + 1))" "$code" "$lineno" "$func" "$cmd" "${msg:-}"
	done
}

# _handle_error: Main trap handler that captures error context.
# Usage: _handle_error [exit_code] [lineno] [func] [cmd] [message]
# Args:
#   exit_code: numeric exit status to record. If omitted, the current
#              value of `$?` at handler invocation is used.
#   lineno: line number where the error occurred (optional)
#   func: function name or context (optional)
#   cmd: command string that failed (optional)
#   message: optional human-readable message
# Behavior:
#   When invoked with no arguments (typical trap usage), the function
#   collects context from `BASH_LINENO`, `FUNCNAME` and `BASH_COMMAND`.
#   It then calls `push_error` to record the error.
_handle_error() {
	local exit_code lineno func cmd msg
	exit_code=$?
	if [[ "$#" -ge 1 ]]; then
		exit_code="$1"
		shift || true
		lineno="${1:-0}"
		shift || true
		func="${1:-MAIN}"
		shift || true
		cmd="${1:-}"
		shift || true
		msg="${*:-}"
	else
		lineno="${BASH_LINENO[0]:-0}"
		func="${FUNCNAME[1]:-MAIN}"
		cmd="${BASH_COMMAND:-}"
		msg=""
	fi
	push_error "$exit_code" "$lineno" "$func" "$cmd" "$msg"
}

# _on_sigint: Signal handler for SIGINT (Ctrl-C).
# Usage: _on_sigint
# Args: none
# Behavior: records a SIGINT entry on the `_ERROR_STACK` with code 130.
_on_sigint() {
	push_error 130 "${LINENO}" "SIGINT" "SIGINT received"
}

# _on_sigterm: Signal handler for SIGTERM.
# Usage: _on_sigterm
# Args: none
# Behavior: records a SIGTERM entry on the `_ERROR_STACK` with code 143.
_on_sigterm() {
	push_error 143 "${LINENO}" "SIGTERM" "SIGTERM received"
}

# _on_exit: EXIT trap handler invoked when the script exits.
# Usage: _on_exit
# Args: none
# Behavior: runs all registered cleanup handlers in LIFO order, then
#           prints the accumulated error stack if `DUMP_ERROR_STACK` is true
#           and the stack is non-empty. Always returns 0 so it never
#           blocks the EXIT trap chain.
_on_exit() {
	# Always attempt to run registered cleanup handlers first.
	run_cleanup_handlers || true

	if [[ "${DUMP_ERROR_STACK}" == "true" && "${#_ERROR_STACK[@]}" -gt 0 ]]; then
		dump_error_stack
	fi
	return 0
}

# setup_error_traps: Install standard error and signal traps.
# Usage: setup_error_traps
# Args: none
# Behavior: wires `_handle_error` to `ERR`, `_on_exit` to `EXIT`, and
#           signal handlers for `INT` and `TERM` to their respective
#           handlers. Call this once during script initialization to
#           enable the error handler system.
setup_error_traps() {
	trap '_handle_error' ERR
	trap '_on_exit' EXIT
	trap '_on_sigint' INT
	trap '_on_sigterm' TERM
}

export -f push_error dump_error_stack _handle_error setup_error_traps _on_sigint _on_sigterm _on_exit register_cleanup run_cleanup_handlers
