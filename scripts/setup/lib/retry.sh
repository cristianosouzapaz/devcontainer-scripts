# shellcheck shell=bash
[[ -n "${_RETRY_SH_LOADED:-}" ]] && return 0
readonly _RETRY_SH_LOADED=1

# Retries a command with exponential backoff, behind a circuit breaker that stops
# retrying once failures persist.
#
# Starts no spinner and logs nothing beyond push_error: callers run it inside a
# subshell (a $(...) capture, spinner_stream's process substitution), where a
# spinner's draw loop would be orphaned when the subshell exits, and they re-log
# its captured output, which would double already-formatted lines. The caller logs
# its own conclusion from the return code.

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_CIRCUIT_BREAKER_FAILURES=0
_CIRCUIT_BREAKER_THRESHOLD=5
_DEFAULT_INITIAL_BACKOFF=1
_MAX_RETRY_ATTEMPTS=3

_CIRCUIT_BREAKER_OPEN="false"

# ----- FUNCTIONS --------------------------------------------------------------

# retry_command [max_attempts] [initial_backoff] <command...>: runs the command until it succeeds, doubling the wait between attempts
# Returns: 1 when every attempt failed, 2 when the circuit breaker is open.
# Notes: the breaker opens after _CIRCUIT_BREAKER_THRESHOLD consecutive failed calls
#   and stays open for the rest of the run.
retry_command() {
	local max_attempts=${1:-${_MAX_RETRY_ATTEMPTS}} backoff=${2:-${_DEFAULT_INITIAL_BACKOFF}}
	local -a cmd=("${@:3}")
	local attempt=1
	shift 2

	if [[ "${_CIRCUIT_BREAKER_OPEN}" == "true" ]]; then
		return 2
	fi

	while ((attempt <= max_attempts)); do
		if "${cmd[@]}"; then
			_CIRCUIT_BREAKER_FAILURES=0
			return 0
		fi

		(( attempt++ )) || true
		if ((attempt <= max_attempts)); then
			sleep "$backoff"
			backoff=$((backoff * 2))
		fi
	done

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
