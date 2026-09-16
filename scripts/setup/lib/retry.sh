#!/bin/bash

[[ -n "${_RETRY_SH_LOADED:-}" ]] && return 0
readonly _RETRY_SH_LOADED=1

# Retry utility functions for handling transient failures
#
# This module provides a retry mechanism with exponential backoff and a
# circuit breaker pattern to prevent excessive retries on persistent
# failures. It is designed to be sourced by other scripts to provide
# consistent retry behavior.
#
# NOTE: This module does not use configuration variables from devcontainer-setup.sh.
# Internal retry logic is controlled via internal constants and runtime state.
#
# Never calls anything from spinner.sh that starts a spinner (e.g.
# start_spinner), even though callers may wrap this in one: retry_command is
# commonly invoked from inside a subshell — a `$(...)` capture, or
# spinner_stream's internal process substitution (see spinner.sh). Starting
# a spinner from inside a subshell forks its background draw loop as a
# child of that subshell, not of the caller, so it becomes an orphaned,
# undetected, unkillable background process the moment the subshell exits.
#
# Also logs nothing itself beyond push_error (which only records to the
# error stack, no output) — this file's own log_warning/log_error calls
# used to fire for circuit-breaker/final-failure conclusions, but any
# caller capturing this function's output (to re-log it themselves, e.g. via
# spinner_stream) would then re-log that already-formatted text a second
# time, doubling the prefix. Callers log their own conclusion by inspecting
# the return code instead.

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_CIRCUIT_BREAKER_FAILURES=0
_CIRCUIT_BREAKER_THRESHOLD=5
_DEFAULT_INITIAL_BACKOFF=1
_MAX_RETRY_ATTEMPTS=3

# Runtime state variables (not readonly as they change during execution)
_CIRCUIT_BREAKER_OPEN="false"

# ----- FUNCTIONS --------------------------------------------------------------

# retry_command: retry a command with exponential backoff and a circuit breaker
# Usage: retry_command [max_attempts] [initial_backoff] <command...>
# Honors env vars: _CIRCUIT_BREAKER_THRESHOLD
# Logs nothing itself — see file header. Caller inspects the return code.
# Returns: 0 on success, 1 on failure after retries, 2 if circuit breaker open
retry_command() {
	local max_attempts=${1:-${_MAX_RETRY_ATTEMPTS}}
	local backoff=${2:-${_DEFAULT_INITIAL_BACKOFF}}
	shift 2
	local -a cmd=("$@")

	if [[ "${_CIRCUIT_BREAKER_OPEN}" == "true" ]]; then
		return 2
	fi

	local attempt=1
	while ((attempt <= max_attempts)); do
		if "${cmd[@]}"; then
			# success -> reset circuit breaker failure counter
			_CIRCUIT_BREAKER_FAILURES=0
			return 0
		fi

		# failed attempt
		(( attempt++ )) || true
		if ((attempt <= max_attempts)); then
			sleep "$backoff"
			# exponential increase
			backoff=$((backoff * 2))
		fi
	done

	# On permanent failure, increment circuit breaker failures and maybe open it
	(( _CIRCUIT_BREAKER_FAILURES++ )) || true
	if ((_CIRCUIT_BREAKER_FAILURES >= _CIRCUIT_BREAKER_THRESHOLD)); then
		_CIRCUIT_BREAKER_OPEN="true"
		push_error 1 "${LINENO}" "retry_command" "${cmd[*]}" "Circuit breaker opened after repeated failures"
		return 2
	fi

	push_error 1 "${LINENO}" "retry_command" "${cmd[*]}" "Command failed after $max_attempts attempts"
	return 1
}

export -f retry_command
