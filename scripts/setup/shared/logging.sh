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
# - NO_COLOR (community standard: https://no-color.org — presence, any value, disables color)

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_LOG_MAX_FILES=5
_LOG_MAX_SIZE=1048576

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

# log_debug: Logs debug messages if DEBUG_MODE is true. Uses the "detail"
# style (tree bar, no symbol) since debug output is always secondary detail
# nested under whatever primary line it explains — never a conclusion on
# its own.
# Args: message - the text to log.
# Returns: 0 always.
log_debug() {
	# Show debug when DEBUG_MODE true or LOG_LEVEL allows DEBUG
	if [[ "${DEBUG_MODE}" == "true" ]] || should_log "DEBUG"; then
		log_output "DEBUG" "$*" "stderr" "detail"
	fi
}

# log_error: logs at ERROR level. Args: message. Returns: 0 always.
log_error() {
	log_output "ERROR" "$*" "stderr"
}

# log_info: logs at INFO level. Args: message. Returns: 0 always.
log_info() {
	log_output "INFO" "$*" "stderr"
}

# log_success: logs at SUCCESS level. Args: message. Returns: 0 always.
log_success() {
	log_output "SUCCESS" "$*" "stderr"
}

# log_warning: logs at WARNING level. Args: message. Returns: 0 always.
log_warning() {
	log_output "WARNING" "$*" "stderr"
}

# log_detail: Logs a neutral secondary line under the preceding primary log
# line (tree bar, no symbol). For process sub-steps or column headers that
# carry no status of their own. Shares INFO's visibility threshold.
# Args: message - the text to log.
# Returns: 0 always.
log_detail() {
	log_output "INFO" "$*" "stderr" "detail"
}

# log_item_success: Logs a secondary line that is itself a conclusion (e.g.
# one row of an enumerated list), indented under a primary with its own
# success symbol/color.
# Args: message - the text to log.
# Returns: 0 always.
log_item_success() {
	log_output "SUCCESS" "$*" "stderr" "item"
}

# log_item_warning: Logs a secondary line that is itself a conclusion (e.g.
# one row of an enumerated list), indented under a primary with its own
# warning symbol/color.
# Args: message - the text to log.
# Returns: 0 always.
log_item_warning() {
	log_output "WARNING" "$*" "stderr" "item"
}

# log_fatal: Logs fatal error messages and exits.
# Args: message - the text to log.
# Returns: does not return; exits the process with status 1.
log_fatal() {
	log_output "FATAL" "$*" "stderr"
	exit 1
}

# Map log level names to numeric priorities
level_value() {
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

# should_log: determine if a message at given level should be logged
# Return 0 if given level should be logged according to LOG_LEVEL
should_log() {
	local min
	local want
	min=$(level_value "${LOG_LEVEL^^}")
	want=$(level_value "$1")
	if ((want >= min)); then
		return 0
	else
		return 1
	fi
}

# use_color: determines whether ANSI color codes should be emitted. Honors
# the NO_COLOR community standard (presence of the variable, regardless of
# value, disables color). No TTY check: setup runs as postCreateCommand,
# which never attaches a real pty, yet its output is still rendered (and
# colorized) live in the editor's UI — auto-disabling on "not a TTY" would
# silently kill color in the only environment that matters here. LOG_FILE
# output is unaffected either way; it never carries color codes.
# Returns: 0 if color should be used, 1 otherwise.
use_color() {
	[[ -n "${NO_COLOR+x}" ]] && return 1
	return 0
}

# rotate_log_if_needed: rotate log files when exceeding LOG_MAX_SIZE
rotate_log_if_needed() {
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

# json_quote: helper to produce JSON-safe string via jq when available
json_quote() {
	local input="$1"
	local res
	if command -v jq >/dev/null 2>&1; then
		res=$(jq -Rn --arg s "$input" '$s' 2>/dev/null)
		res=${res:-}
		if [[ -n "$res" ]]; then
			printf "%s" "$res"
			return 0
		fi
	fi
	# fallback: escape quotes and backslashes
	printf '"%s"' "$(printf "%s" "$input" | sed -e 's/\\/\\\\/g' -e 's/"/\\\"/g' -e ':a;N;s/\n/\\n/g;ta')"
}

# write_log: outputs either structured JSON or legacy formatted text.
# Supports multi-line messages: each non-empty line is prefixed with the
# level symbol and color; blank lines are skipped to suppress spurious
# empty-prefix output from tools like npm or git.
write_log() {
	local level="$1"
	local message
	local dest
	local style
	local ts
	local msg_quoted
	local json
	local _sym
	local _color
	local _prefix
	local _line
	local _gray
	local _reset
	local _ts_prefix
	shift
	message="$1"
	shift
	dest="${1:-stdout}"
	style="${2:-normal}"
	if [[ -n "$LOG_FILE" ]]; then
		rotate_log_if_needed
	fi

	if [[ "$STRUCTURED_LOGS" == "true" ]]; then
		ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
		msg_quoted=$(json_quote "$message")
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
		_gray="" _reset=""
		if use_color; then
			_gray="$_COLOR_GRAY"
			_reset="$_COLOR_RESET"
		fi

		case "$level" in
		DEBUG)   _sym="$_SYMBOL_DEBUG"   ; _color="$_COLOR_GRAY"     ;;
		INFO)    _sym="$_SYMBOL_INFO"    ; _color="$_COLOR_RESET"    ;;
		SUCCESS) _sym="$_SYMBOL_SUCCESS" ; _color="$_COLOR_GREEN"    ;;
		WARNING) _sym="$_SYMBOL_WARNING" ; _color="$_COLOR_YELLOW"   ;;
		ERROR)   _sym="$_SYMBOL_ERROR"   ; _color="$_COLOR_RED"      ;;
		FATAL)   _sym="$_SYMBOL_FATAL"   ; _color="$_COLOR_RED_BOLD" ;;
		esac
		[[ -z "$_reset" ]] && _color=""

		case "$style" in
		detail) _prefix="$(printf '%b│%b' "$_gray" "$_reset")" ;;
		item)   _prefix="$(printf '│  %b%s%b' "$_color" "$_sym" "$_reset")" ;;
		*)      _prefix="$(printf '%b%s%b' "$_color" "$_sym" "$_reset")" ;;
		esac

		_ts_prefix=""
		if [[ "$DEBUG_MODE" == "true" && "$style" == "normal" ]]; then
			_ts_prefix=" $(printf '%b%s%b' "$_gray" "$(date -u +'%H:%M:%S')" "$_reset")"
		fi

		if [[ "$dest" == "stderr" ]]; then
			while IFS= read -r _line; do
				[[ -z "$_line" ]] && continue
				printf '%s%s  %s\n' "$_prefix" "$_ts_prefix" "$_line" >&2
			done <<< "$message"
		else
			while IFS= read -r _line; do
				[[ -z "$_line" ]] && continue
				printf '%s%s  %s\n' "$_prefix" "$_ts_prefix" "$_line"
			done <<< "$message"
		fi
		if [[ -n "$LOG_FILE" ]]; then
			while IFS= read -r _line; do
				[[ -z "$_line" ]] && continue
				printf '[%s] [%s] %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$level" "$_line" >>"$LOG_FILE" 2>/dev/null || true
			done <<< "$message"
		fi
	fi
}

# log_output: public wrapper that checks level filtering
log_output() {
	local level="$1"
	local message="$2"
	local dest="${3:-stdout}"
	local style="${4:-normal}"
	# Allow DEBUG messages when DEBUG_MODE is explicitly enabled
	if [[ "$level" == "DEBUG" && "${DEBUG_MODE}" == "true" ]]; then
		:
	else
		if ! should_log "$level"; then
			return 0
		fi
	fi
	write_log "$level" "$message" "$dest" "$style"
}

export -f level_value should_log use_color rotate_log_if_needed json_quote write_log log_output log_debug log_error log_info log_success log_warning log_detail log_item_success log_item_warning log_fatal module_skip
