#!/bin/bash

[[ -n "${_RETRY_SH_LOADED:-}" ]] && return 0
readonly _RETRY_SH_LOADED=1

# Retry utility functions for handling transient failures
#
# This module provides flexible retry mechanisms with exponential backoff,
# jitter, and a circuit breaker pattern to prevent excessive retries on
# persistent failures. It is designed to be sourced by other scripts to
# provide consistent retry behavior.
#
# NOTE: This module does not use configuration variables from devcontainer-setup.sh.
# Internal retry logic is controlled via internal constants and runtime state.
#
# Never calls anything from spinner.sh that starts a spinner (e.g.
# start_spinner), even though callers may wrap this in one: retry_command/
# retry_with_backoff are commonly invoked from inside a subshell — a `$(...)`
# capture, or spinner_stream's internal process substitution (see
# spinner.sh). Starting a spinner from inside a subshell forks its
# background draw loop as a child of that subshell, not of the caller, so it
# becomes an orphaned, undetected, unkillable background process the moment
# the subshell exits.
#
# Also logs nothing itself beyond push_error (which only records to the
# error stack, no output) — retry_with_backoff's own log_warning/log_error
# calls used to fire for circuit-breaker/final-failure conclusions, but any
# caller capturing this function's output (to re-log it themselves, e.g. via
# spinner_stream) would then re-log that already-formatted text a second
# time, doubling the prefix. Callers log their own conclusion by inspecting
# the return code instead.

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_CIRCUIT_BREAKER_FAILURES=0
_CIRCUIT_BREAKER_THRESHOLD=5
_DEFAULT_INITIAL_BACKOFF=1
_DEFAULT_MAX_BACKOFF=30
_MAX_RETRY_ATTEMPTS=3

# Runtime state variables (not readonly as they change during execution)
_CIRCUIT_BREAKER_OPEN="false"
_JITTER_ENABLED="true"
_RETRY_SUCCESS_CHECK_CMD=""

# ----- FUNCTIONS --------------------------------------------------------------

# compute_sleep: compute sleep with optional jitter and cap
compute_sleep() {
	local backoff=$1
	local max_backoff=$2
	local jitter_enabled=$3
	local sleep_time=$backoff
	if [[ "$jitter_enabled" == "true" ]]; then
		# Add uniform random jitter between 0 and backoff
		local extra=$((RANDOM % (backoff + 1)))
		sleep_time=$((backoff + extra))
	fi
	if ((sleep_time > max_backoff)); then
		sleep_time=$max_backoff
	fi
	echo "$sleep_time"
}

# retry_with_backoff: flexible retry driver
# Usage: retry_with_backoff <max_attempts> <initial_backoff> <max_backoff> <command...>
# Honors env vars: _JITTER_ENABLED, _CIRCUIT_BREAKER_THRESHOLD
# Logs nothing itself — see file header. Caller inspects the return code.
# Returns: 0 on success, 1 on failure after retries, 2 if circuit breaker open
retry_with_backoff() {
	local max_attempts=${1:-${_MAX_RETRY_ATTEMPTS}}
	local backoff=${2:-${_DEFAULT_INITIAL_BACKOFF}}
	local max_backoff=${3:-${_DEFAULT_MAX_BACKOFF}}
	shift 3
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

		# If a custom success check command is provided via env var, evaluate it
		if [[ -n "${_RETRY_SUCCESS_CHECK_CMD}" ]]; then
			if eval "${_RETRY_SUCCESS_CHECK_CMD}"; then
				_CIRCUIT_BREAKER_FAILURES=0
				return 0
			fi
		fi

		# failed attempt
		(( attempt++ )) || true
		if ((attempt <= max_attempts)); then
			local sleep_time
			sleep_time=$(compute_sleep "$backoff" "$max_backoff" "${_JITTER_ENABLED}")
			sleep "$sleep_time"
			# exponential increase
			backoff=$((backoff * 2))
		fi
	done

	# On permanent failure, increment circuit breaker failures and maybe open it
	(( _CIRCUIT_BREAKER_FAILURES++ )) || true
	if ((_CIRCUIT_BREAKER_FAILURES >= ${_CIRCUIT_BREAKER_THRESHOLD})); then
		_CIRCUIT_BREAKER_OPEN="true"
		push_error 1 "${LINENO}" "retry_with_backoff" "${cmd[*]}" "Circuit breaker opened after repeated failures"
		return 2
	fi

	push_error 1 "${LINENO}" "retry_with_backoff" "${cmd[*]}" "Command failed after $max_attempts attempts"
	return 1
}

# retry_command: backward-compatible wrapper using retry_with_backoff
# Usage: retry_command [max_attempts] [initial_backoff] [command]
retry_command() {
	local max_attempts=${1:-$_MAX_RETRY_ATTEMPTS}
	local initial_backoff=${2:-$_DEFAULT_INITIAL_BACKOFF}
	shift 2
	local -a command=("$@")
	retry_with_backoff "$max_attempts" "$initial_backoff" "$_DEFAULT_MAX_BACKOFF" "${command[@]}"
}

export -f compute_sleep retry_with_backoff retry_command
