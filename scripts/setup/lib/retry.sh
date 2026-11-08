# shellcheck shell=bash
[[ -n "${_RETRY_SH_LOADED:-}" ]] && return 0
readonly _RETRY_SH_LOADED=1

# Retries a command with exponential backoff, optionally bounding each attempt with a
# timeout, behind a circuit breaker that stops retrying once failures persist.
#
# Each failed attempt that will be retried leaves one default-level line naming the
# operation, the attempt and the cause, so a slow step is explained. Starts no spinner:
# the caller owns it, and logs its own conclusion from the return code, RETRY_RETRIES
# and RETRY_LAST_CAUSE.

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_CIRCUIT_BREAKER_FAILURES=0
_CIRCUIT_BREAKER_THRESHOLD=5
_DEFAULT_INITIAL_BACKOFF=1
_MAX_RETRY_ATTEMPTS=3

_CIRCUIT_BREAKER_OPEN="false"

# ----- PUBLIC STATE -----------------------------------------------------------

# why: read by the caller after retry_command returns, to say how the operation went
RETRY_RETRIES=0
RETRY_LAST_CAUSE=''

# ----- FUNCTIONS --------------------------------------------------------------

# retry_attempt_cause <exit_code> <timeout>: prints why an attempt failed, from its exit code
# Stdout: the cause, one line
retry_attempt_cause() {
	if [[ -n "$2" && "$1" -eq 124 ]]; then
		printf 'timed out after %ss\n' "$2"
	else
		printf 'failed with exit code %s\n' "$1"
	fi
}

# retry_suffix: prints " (after N retries)" when the last retry_command needed retries, nothing otherwise
# Stdout: the suffix for a success line, possibly empty
retry_suffix() {
	case "$RETRY_RETRIES" in
	0) ;;
	1) printf ' (after 1 retry)' ;;
	*) printf ' (after %s retries)' "$RETRY_RETRIES" ;;
	esac
}

# retry_command [--timeout <seconds>] [--label <operation>] [max_attempts] [initial_backoff] <command...>: runs the command until it succeeds, doubling the wait between attempts
# Returns: 1 when every attempt failed, 2 when the circuit breaker is open.
# Notes: --timeout bounds each attempt of an external command; for
#   `spinner_stream <log_function> <command...>` it bounds the streamed command, so the
#   stream keeps this shell's logging state. --label names the operation in the retry
#   lines, the command's first word otherwise. Sets RETRY_RETRIES to the retries made
#   and RETRY_LAST_CAUSE to the last failure's cause. Never call it inside
#   spinner_stream, whose output is re-logged at DEBUG and would hide the retry lines:
#   wrap spinner_stream in it instead. The breaker opens after
#   _CIRCUIT_BREAKER_THRESHOLD consecutive failed calls and stays open for the rest of
#   the run.
retry_command() {
	local timeout='' label=''
	local max_attempts backoff attempt=1 rc
	local -a cmd=() run=()

	while [[ "${1:-}" == --timeout || "${1:-}" == --label ]]; do
		case "$1" in
		--timeout) timeout="$2" ;;
		--label) label="$2" ;;
		esac
		shift 2
	done
	max_attempts=${1:-${_MAX_RETRY_ATTEMPTS}}
	backoff=${2:-${_DEFAULT_INITIAL_BACKOFF}}
	cmd=("${@:3}")
	label="${label:-${cmd[0]}}"
	RETRY_RETRIES=0
	RETRY_LAST_CAUSE=''

	if [[ "${_CIRCUIT_BREAKER_OPEN}" == "true" ]]; then
		RETRY_LAST_CAUSE='skipped: too many failed network calls'
		return 2
	fi

	run=("${cmd[@]}")
	if [[ -n "$timeout" && "${cmd[0]}" == spinner_stream ]]; then
		run=(spinner_stream "${cmd[1]}" timeout "$timeout" "${cmd[@]:2}")
	elif [[ -n "$timeout" ]]; then
		run=(timeout "$timeout" "${cmd[@]}")
	fi

	while ((attempt <= max_attempts)); do
		rc=0
		"${run[@]}" || rc=$?
		if [[ "$rc" -eq 0 ]]; then
			_CIRCUIT_BREAKER_FAILURES=0
			return 0
		fi
		RETRY_LAST_CAUSE="$(retry_attempt_cause "$rc" "$timeout")"

		if ((attempt < max_attempts)); then
			log_item_info "${label}: attempt ${attempt}/${max_attempts} ${RETRY_LAST_CAUSE}, retrying"
			sleep "$backoff"
			backoff=$((backoff * 2))
			(( RETRY_RETRIES++ )) || true
		fi
		(( attempt++ )) || true
	done

	(( _CIRCUIT_BREAKER_FAILURES++ )) || true
	if ((_CIRCUIT_BREAKER_FAILURES >= _CIRCUIT_BREAKER_THRESHOLD)); then
		_CIRCUIT_BREAKER_OPEN="true"
		RETRY_LAST_CAUSE="${RETRY_LAST_CAUSE}; too many failed network calls, later ones skipped"
		push_error 1 "${LINENO}" "retry_command" "$label" "Circuit breaker opened after repeated failures"
		return 2
	fi

	push_error 1 "${LINENO}" "retry_command" "$label" "Command failed after $max_attempts attempts: ${RETRY_LAST_CAUSE}"
	return 1
}

export -f retry_attempt_cause retry_suffix retry_command
