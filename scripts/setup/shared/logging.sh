#!/bin/bash

[[ -n "${_LOGGING_SH_LOADED:-}" ]] && return 0
readonly _LOGGING_SH_LOADED=1

# Shared logging functions for all setup scripts
#
# This module provides consistent logging functions (debug, info, success, warning, error, fatal)
# with support for log levels, log rotation, structured JSON output, and optional debug mode.

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# This module uses the following configuration variables:
# - DEBUG_MODE
# - LOG_FILE
# - LOG_LEVEL
# - STRUCTURED_LOGS

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_LOG_MAX_FILES=5
_LOG_MAX_SIZE=1048576
_PYTHON_BIN="python3"

# ----- COLOR CONSTANTS --------------------------------------------------------

readonly _COLOR_GRAY='\033[0;90m'
readonly _COLOR_GREEN='\033[0;32m'
readonly _COLOR_RED='\033[0;31m'
readonly _COLOR_RED_BOLD='\033[1;31m'
readonly _COLOR_RESET='\033[0m'
readonly _COLOR_YELLOW='\033[0;33m'

# ----- SYMBOL CONSTANTS -------------------------------------------------------

readonly _SYMBOL_DEBUG='⚙'
readonly _SYMBOL_INFO='→'
readonly _SYMBOL_SUCCESS='✔'
readonly _SYMBOL_WARNING='⚠'
readonly _SYMBOL_ERROR='✖'
readonly _SYMBOL_FATAL='✖'

# ----- FUNCTIONS --------------------------------------------------------------

# log_debug: Logs debug messages if DEBUG_MODE is true
log_debug() {
	# Show debug when DEBUG_MODE true or LOG_LEVEL allows DEBUG
	if [[ "${DEBUG_MODE}" == "true" ]] || _should_log "DEBUG"; then
		_log_output "DEBUG" "$*"
	fi
}

# log_error: Logs error messages
log_error() {
	_log_output "ERROR" "$*" "stderr"
}

# log_info: Logs informational messages
log_info() {
	_log_output "INFO" "$*"
}

# log_success: Logs success messages
log_success() {
	_log_output "SUCCESS" "$*"
}

# log_warning: Logs warning messages
log_warning() {
	_log_output "WARNING" "$*"
}

# log_fatal: Logs fatal error messages and exits
log_fatal() {
	_log_output "FATAL" "$*" "stderr"
	exit 1
}

# Map log level names to numeric priorities
_level_value() {
	case "$1" in
	DEBUG) echo 10 ;;
	INFO) echo 20 ;;
	SUCCESS) echo 25 ;;
	WARNING) echo 30 ;;
	ERROR) echo 40 ;;
	FATAL) echo 50 ;;
	*) echo 20 ;;
	esac
}

# module_skip: marks the current module as having nothing to do;
# call this before returning 0 when prerequisite conditions are absent.
module_skip() {
	_MODULE_SKIPPED="true"
}

# _should_log: determine if a message at given level should be logged
# Return 0 if given level should be logged according to LOG_LEVEL
_should_log() {
	local min
	local want
	min=$(_level_value "${LOG_LEVEL^^}")
	want=$(_level_value "$1")
	if ((want >= min)); then
		return 0
	else
		return 1
	fi
}

# _rotate_log_if_needed: rotate log files when exceeding LOG_MAX_SIZE
_rotate_log_if_needed() {
	local size
	local i
	local maxp
	if [[ -z "${LOG_FILE}" ]]; then
		return 0
	fi
	if [[ ! -f "${LOG_FILE}" ]]; then
		return 0
	fi
	size=$(stat -c%s "${LOG_FILE}" 2>/dev/null || echo 0)
	if ((size < ${_LOG_MAX_SIZE})); then
		return 0
	fi

	# remove oldest if max reached
	if [[ "${_LOG_MAX_FILES}" -le 1 ]]; then
		rm -f "${LOG_FILE}" 2>/dev/null || true
		return 0
	fi

	for ((i = ${_LOG_MAX_FILES} - 1; i >= 1; i--)); do
		if [[ -f "${LOG_FILE}.$i" ]]; then
			mv "${LOG_FILE}.$i" "${LOG_FILE}.$((i + 1))" 2>/dev/null || true
		fi
	done
	if [[ -f "${LOG_FILE}" ]]; then
		mv "${LOG_FILE}" "${LOG_FILE}.1" 2>/dev/null || true
	fi
	# Trim beyond max files
	maxp=$(( _LOG_MAX_FILES + 0 ))
	if [[ -f "${LOG_FILE}.$maxp" ]]; then
		rm -f "${LOG_FILE}.$maxp" 2>/dev/null || true
	fi
}

# _json_quote: helper to produce JSON-safe string via Python when available
_json_quote() {
	local input="$1"
	if command -v "$_PYTHON_BIN" >/dev/null 2>&1; then
		local res
		res=$(printf "%s" "$input" | "$_PYTHON_BIN" -c 'import json,sys
data=sys.stdin.read()
try:
    print(json.dumps(data))
except Exception:
    sys.exit(1)
' 2>/dev/null)
		res=${res:-}
		if [[ -n "$res" ]]; then
			printf "%s" "$res"
			return 0
		fi
	fi
	# fallback: escape quotes and backslashes
	printf '"%s"' "$(printf "%s" "$input" | sed -e 's/\\/\\\\/g' -e 's/"/\\\"/g' -e ':a;N;s/\n/\\n/g;ta')"
}

# _write_log: outputs either structured JSON or legacy formatted text
_write_log() {
	local level="$1"
	local message
	local dest
	local ts
	local msg_quoted
	local json
	local _sym
	local _color
	shift
	message="$1"
	shift
	dest="${1:-stdout}"
	if [[ -n "$LOG_FILE" ]]; then
		_rotate_log_if_needed
	fi

	if [[ "$STRUCTURED_LOGS" == "true" ]]; then
		ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
		msg_quoted=$(_json_quote "$message")
		json="{\"timestamp\":\"$ts\",\"level\":\"$level\",\"message\":${msg_quoted}}"
		if [[ -n "$LOG_FILE" ]]; then
			printf '%s\n' "$json" >>"$LOG_FILE" 2>/dev/null || true
		fi
		if [[ "$dest" == "stderr" ]]; then
			printf '%s\n' "$json" >&2
		else
			printf '%s\n' "$json"
		fi
	else
		case "$level" in
		DEBUG)   _sym="$_SYMBOL_DEBUG"   ; _color="$_COLOR_GRAY"     ;;
		INFO)    _sym="$_SYMBOL_INFO"    ; _color="$_COLOR_RESET"    ;;
		SUCCESS) _sym="$_SYMBOL_SUCCESS" ; _color="$_COLOR_GREEN"    ;;
		WARNING) _sym="$_SYMBOL_WARNING" ; _color="$_COLOR_YELLOW"   ;;
		ERROR)   _sym="$_SYMBOL_ERROR"   ; _color="$_COLOR_RED"      ;;
		FATAL)   _sym="$_SYMBOL_FATAL"   ; _color="$_COLOR_RED_BOLD" ;;
		esac
		if [[ "$dest" == "stderr" ]]; then
			printf '%b%s%b  %s\n' "$_color" "$_sym" "$_COLOR_RESET" "$message" >&2
		else
			printf '%b%s%b  %s\n' "$_color" "$_sym" "$_COLOR_RESET" "$message"
		fi
		if [[ -n "$LOG_FILE" ]]; then
			printf '[%s] [%s] %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$level" "$message" >>"$LOG_FILE" 2>/dev/null || true
		fi
	fi
}

# _log_output: public wrapper that checks level filtering
_log_output() {
	local level="$1"
	shift
	local message="$*"
	local dest="${LOG_DEST:-stdout}"
	# Allow DEBUG messages when DEBUG_MODE is explicitly enabled
	if [[ "$level" == "DEBUG" && "${DEBUG_MODE}" == "true" ]]; then
		:
	else
		if ! _should_log "$level"; then
			return 0
		fi
	fi
	_write_log "$level" "$message" "$dest"
}
