# shellcheck shell=bash
[[ -n "${_LOGGING_SH_LOADED:-}" ]] && return 0
readonly _LOGGING_SH_LOADED=1

# Leveled logging for every setup script: symbol-prefixed, optionally colored lines
# on stderr, optional JSON output, and an optional rotated log file.

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# Documented in README.md#configuration-variables:
# - DEBUG_MODE
# - LOG_FILE
# - LOG_LEVEL
# - STRUCTURED_LOGS
# - NO_COLOR

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

# log_debug <message>: logs at DEBUG level as a detail line, when DEBUG_MODE is true or LOG_LEVEL allows it
# Notes: uses the detail style (tree bar, no symbol) because debug output always explains
#   the primary line above it and is never a conclusion on its own.
log_debug() {
	if [[ "${DEBUG_MODE}" == "true" ]] || should_log "DEBUG"; then
		log_output "DEBUG" "$*" "detail"
	fi
}

# log_error <message>: logs at ERROR level
log_error() {
	log_output "ERROR" "$*"
}

# log_info <message>: logs at INFO level
log_info() {
	log_output "INFO" "$*"
}

# log_success <message>: logs at SUCCESS level
log_success() {
	log_output "SUCCESS" "$*"
}

# log_warning <message>: logs at WARNING level
log_warning() {
	log_output "WARNING" "$*"
}

# log_detail <message>: logs a neutral detail line (tree bar, no symbol) under the preceding primary line, at INFO visibility
log_detail() {
	log_output "INFO" "$*" "detail"
}

# log_item_success <message>: logs an indented line that is itself a success conclusion, such as one row of a list
log_item_success() {
	log_output "SUCCESS" "$*" "item"
}

# log_item_warning <message>: logs an indented line that is itself a warning conclusion, such as one row of a list
log_item_warning() {
	log_output "WARNING" "$*" "item"
}

# log_fatal <message>: logs at FATAL level and exits the process with status 1
log_fatal() {
	log_output "FATAL" "$*"
	exit 1
}

# level_value <level>: prints the numeric priority of a level name, INFO's for an unknown name
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

# module_skip: sets _MODULE_SKIPPED so the current module is reported as having nothing to do; call it before returning 0 when a prerequisite is absent
module_skip() {
	_MODULE_SKIPPED="true"
}

# should_log <level>: succeeds when a message at <level> passes LOG_LEVEL
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

# use_color: succeeds when log output should carry ANSI color, i.e. NO_COLOR is empty
# Notes: no TTY check: setup runs as postCreateCommand, which never attaches a pty,
#   yet the editor renders its output live and in color, so disabling color off a TTY
#   would kill it in the only environment that matters. LOG_FILE output never carries
#   color either way.
use_color() {
	[[ -n "${NO_COLOR:-}" ]] && return 1
	return 0
}

# rotate_log_if_needed: rotates LOG_FILE once it reaches _LOG_MAX_SIZE, keeping _LOG_MAX_FILES - 1 rotated files
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
	if ((size < _LOG_MAX_SIZE)); then
		return 0
	fi

	for ((i = _LOG_MAX_FILES - 1; i >= 1; i--)); do
		if [[ -f "${LOG_FILE}.$i" ]]; then
			mv "${LOG_FILE}.$i" "${LOG_FILE}.$((i + 1))" 2>/dev/null || true
		fi
	done
	if [[ -f "${LOG_FILE}" ]]; then
		mv "${LOG_FILE}" "${LOG_FILE}.1" 2>/dev/null || true
	fi
	maxp=$(( _LOG_MAX_FILES + 0 ))
	if [[ -f "${LOG_FILE}.$maxp" ]]; then
		rm -f "${LOG_FILE}.$maxp" 2>/dev/null || true
	fi
}

# json_quote <string>: prints the string as a quoted JSON string
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
	printf '"%s"' "$(printf "%s" "$input" | sed -e 's/\\/\\\\/g' -e 's/"/\\\"/g' -e ':a;N;s/\n/\\n/g;ta')"
}

# write_log <level> <message> [normal|detail|item]: writes the message to stderr, and to LOG_FILE when set, as JSON or as symbol-prefixed text
# Notes: each non-empty line of a multi-line message gets its own prefix; blank lines
#   are skipped so tools like npm or git print no empty prefixed lines.
write_log() {
	local level="$1"
	local message="$2"
	local style="${3:-normal}"
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
		printf '%s\n' "$json" >&2
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

		while IFS= read -r _line; do
			[[ -z "$_line" ]] && continue
			printf '%s%s  %s\n' "$_prefix" "$_ts_prefix" "$_line" >&2
		done <<< "$message"
		if [[ -n "$LOG_FILE" ]]; then
			while IFS= read -r _line; do
				[[ -z "$_line" ]] && continue
				printf '[%s] [%s] %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$level" "$_line" >>"$LOG_FILE" 2>/dev/null || true
			done <<< "$message"
		fi
	fi
}

# log_output <level> <message> [normal|detail|item]: writes the message when <level> passes LOG_LEVEL, or is DEBUG with DEBUG_MODE true
log_output() {
	local level="$1"
	local message="$2"
	local style="${3:-normal}"
	if [[ "$level" == "DEBUG" && "${DEBUG_MODE}" == "true" ]]; then
		:
	else
		if ! should_log "$level"; then
			return 0
		fi
	fi
	write_log "$level" "$message" "$style"
}

export -f level_value should_log use_color rotate_log_if_needed json_quote write_log log_output log_debug log_error log_info log_success log_warning log_detail log_item_success log_item_warning log_fatal module_skip
