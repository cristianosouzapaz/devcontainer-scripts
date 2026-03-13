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

# _compute_sleep: compute sleep with optional jitter and cap
_compute_sleep() {
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
# Returns: 0 on success, 1 on failure after retries, 2 if circuit breaker open
retry_with_backoff() {
	local max_attempts=${1:-${_MAX_RETRY_ATTEMPTS}}
	local backoff=${2:-${_DEFAULT_INITIAL_BACKOFF}}
	local max_backoff=${3:-${_DEFAULT_MAX_BACKOFF}}
	shift 3
	local -a cmd=("$@")

	if [[ "${_CIRCUIT_BREAKER_OPEN}" == "true" ]]; then
		log_warning "Circuit breaker open; failing fast"
		return 2
	fi

	local attempt=1
	while ((attempt <= max_attempts)); do
		log_debug "Attempt $attempt/$max_attempts: ${cmd[*]}"
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
			sleep_time=$(_compute_sleep "$backoff" "$max_backoff" "${_JITTER_ENABLED}")
			log_debug "Sleeping $sleep_time seconds before retry"
			sleep "$sleep_time"
			# exponential increase
			backoff=$((backoff * 2))
		fi
	done

	# On permanent failure, increment circuit breaker failures and maybe open it
	(( _CIRCUIT_BREAKER_FAILURES++ )) || true
	if ((_CIRCUIT_BREAKER_FAILURES >= ${_CIRCUIT_BREAKER_THRESHOLD})); then
		_CIRCUIT_BREAKER_OPEN="true"
		log_error "Circuit breaker opened after $_CIRCUIT_BREAKER_FAILURES failures"
		push_error 1 "${LINENO}" "retry_with_backoff" "${cmd[*]}" "Circuit breaker opened after repeated failures"
		return 2
	fi

	log_error "Failed after $max_attempts attempts"
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

# retry_curl: retains behavior but uses retry_with_backoff for retrying
# Usage: retry_curl [max_attempts] [initial_backoff] [timeout] [curl_args...]
retry_curl() {
	local max_attempts=${1:-$_MAX_RETRY_ATTEMPTS}
	local initial_backoff=${2:-$_DEFAULT_INITIAL_BACKOFF}
	local timeout=${3:-10}
	shift 3
	local -a curl_args=("$@")

	# inner function to perform curl and return 0 on HTTP 200
	_do_curl() {
		local response
		local RETRY_HTTP_CODE
		response=$(curl -s -w "%{http_code}" --max-time "$timeout" "${curl_args[@]}" 2>/dev/null)
		RETRY_HTTP_CODE=${response: -3}

		if [[ "$RETRY_HTTP_CODE" == "200" ]]; then
			return 0
		elif [[ "$RETRY_HTTP_CODE" =~ ^(401|403)$ ]]; then
			log_error "Authentication error (HTTP $RETRY_HTTP_CODE)"
			return 1
		elif [[ "$RETRY_HTTP_CODE" =~ ^(5[0-9][0-9])$ ]]; then
			log_warning "Server error (HTTP $RETRY_HTTP_CODE)"
			return 1
		else
			log_warning "Network error (HTTP $RETRY_HTTP_CODE)"
			return 1
		fi
	}

	# Use retry_with_backoff to drive retries
	retry_with_backoff "$max_attempts" "$initial_backoff" "$_DEFAULT_MAX_BACKOFF" _do_curl
	local rc=$?
	if [[ "$rc" -eq 2 ]]; then
		# circuit breaker opened
		return 1
	fi
	return $rc
}
