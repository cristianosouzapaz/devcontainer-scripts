# shellcheck shell=bash
[[ -n "${_LOGGING_SH_LOADED:-}" ]] && return 0
readonly _LOGGING_SH_LOADED=1

# Leveled logging for every setup script: symbol-prefixed, optionally colored lines
# on stderr, optional JSON output, and an optional log file holding one run.
#
# The level rule (docs/wiki/setup/log-output.md#the-level-rule) decides what a unit logs at
# the default level and what goes to DEBUG; the convention tests enforce it.

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# Documented in README.md#configuration-variables:
# - LOG_LEVEL
# - STRUCTURED_LOGS
# - NO_COLOR

# ----- INTERNAL STATE ---------------------------------------------------------

# why: set by entry scripts only (setup writes /tmp/setup.log, tests point elsewhere), so a sourced library never picks a log file
_LOG_FILE="${_LOG_FILE:-}"

# why: only the runner sets these, so a unit run on its own logs no unit tag and collects no warnings
_LOG_MODULE="${_LOG_MODULE:-}"
_LOG_WARNINGS_FILE="${_LOG_WARNINGS_FILE:-}"

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

# log_debug <message>: logs at DEBUG level as a detail line, when LOG_LEVEL allows it
# Notes: uses the detail style (tree bar, no symbol) because debug output always explains
#   the primary line above it and is never a conclusion on its own.
log_debug() {
	log_output "DEBUG" "$*" "detail"
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

# log_blank: emits one unstyled blank line on stderr for visual separation
log_blank() {
	printf '\n' >&2
}

# log_item_success <message>: logs an indented line that is itself a success conclusion, such as one row of a list
log_item_success() {
	log_output "SUCCESS" "$*" "item"
}

# log_item_info <message>: logs an indented neutral line, such as a step skipped with its reason or a state left as it was
log_item_info() {
	log_output "INFO" "$*" "item"
}

# log_item_warning <message>: logs an indented line that is itself a warning conclusion, such as one row of a list
log_item_warning() {
	log_output "WARNING" "$*" "item"
}

# log_phase <title>: opens a setup phase: logs a "── <title> ──" header in plain text, and tags every later structured record with a lowercase phase field instead
log_phase() {
	_LOG_PHASE="${1,,}"
	[[ "$STRUCTURED_LOGS" == "true" ]] && return 0
	log_output "INFO" "── $1 ──" "phase"
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

# module_skip [--action <remedy>] <reason>: reports the current unit as skipped for the reason; call it before returning 0 when a prerequisite is absent
# Notes: a module the user did not choose passes "not selected". --action marks a skip the
#   user has to act on: the runner ends the unit with a warning and lists the remedy under
#   Action needed.
module_skip() {
	_MODULE_SKIP_ACTION=''
	if [[ "${1:-}" == '--action' ]]; then
		_MODULE_SKIP_ACTION="${2:-}"
		shift 2
	fi
	_MODULE_SKIPPED="true"
	_MODULE_SKIP_REASON="${1:-}"
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
#   would kill it in the only environment that matters. _LOG_FILE output never carries
#   color either way.
use_color() {
	[[ -n "${NO_COLOR:-}" ]] && return 1
	return 0
}

# log_file_start: starts a fresh _LOG_FILE for a new run, keeping the previous run as _LOG_FILE.1
# Notes: the entry script that owns the file calls it once, before its first line, so the
#   file always holds exactly one run.
log_file_start() {
	[[ -n "${_LOG_FILE:-}" && -f "$_LOG_FILE" ]] || return 0
	mv -f -- "$_LOG_FILE" "${_LOG_FILE}.1" 2>/dev/null || true
}

# log_record_warning <message>: appends a warning to the run's warnings file, prefixed with the unit that logged it, when the runner keeps one
log_record_warning() {
	[[ -n "${_LOG_WARNINGS_FILE:-}" ]] || return 0
	printf '%s\n' "${_LOG_MODULE:+${_LOG_MODULE}: }${1%%$'\n'*}" >>"$_LOG_WARNINGS_FILE" 2>/dev/null || true
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

# write_log_text <level> <message> <style>: writes the message to stderr as symbol-prefixed text, and to _LOG_FILE as timestamped text without color
# Notes: each non-empty line of a multi-line message gets its own prefix; blank lines
#   are skipped so tools like npm or git print no empty prefixed lines.
write_log_text() {
	local level="$1" message="$2" style="$3"
	local _sym _color _prefix _line _gray="" _reset="" _ts_prefix=""

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
	# why: a phase header stands alone, so it carries no level symbol
	phase)  _prefix="" ;;
	*)      _prefix="$(printf '%b%s%b' "$_color" "$_sym" "$_reset")" ;;
	esac

	if [[ "${LOG_LEVEL^^}" == "DEBUG" && "$style" == "normal" ]]; then
		_ts_prefix=" $(printf '%b%s%b' "$_gray" "$(date -u +'%H:%M:%S')" "$_reset")"
	fi

	# why: a running spinner owns the current line; clearing it first keeps the frame out of the logged line
	[[ -z "${_SPINNER_PID:-}" ]] || printf '\r\033[K' >&2
	while IFS= read -r _line; do
		[[ -z "$_line" ]] && continue
		if [[ "$style" == "phase" ]]; then
			printf '%s\n' "$_line" >&2
		else
			printf '%s%s  %s\n' "$_prefix" "$_ts_prefix" "$_line" >&2
		fi
	done <<< "$message"
	if [[ -n "$_LOG_FILE" ]]; then
		while IFS= read -r _line; do
			[[ -z "$_line" ]] && continue
			printf '[%s] [%s] %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$level" "$_line" >>"$_LOG_FILE" 2>/dev/null || true
		done <<< "$message"
	fi
}

# write_log <level> <message> [normal|detail|item|phase]: writes the message to stderr, and to _LOG_FILE when set, as JSON or as symbol-prefixed text, and records a warning for the run
# Notes: while a spinner is drawing, the line is written under its terminal lock, so a
#   frame never lands in the middle of it.
write_log() {
	local level="$1"
	local message="$2"
	local style="${3:-normal}"
	local ts json

	[[ "$level" != 'WARNING' ]] || log_record_warning "$message"
	if [[ "$STRUCTURED_LOGS" == "true" ]]; then
		ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
		json="{\"timestamp\":\"$ts\",\"level\":\"$level\",\"phase\":$(json_quote "${_LOG_PHASE:-}")"
		json+=",\"module\":$(json_quote "${_LOG_MODULE:-}"),\"message\":$(json_quote "$message")}"
		if [[ -n "$_LOG_FILE" ]]; then
			printf '%s\n' "$json" >>"$_LOG_FILE" 2>/dev/null || true
		fi
		printf '%s\n' "$json" >&2
	elif [[ -n "${_SPINNER_PID:-}" && -n "${_SPINNER_LOCK_FILE:-}" ]]; then
		{
			flock 9
			write_log_text "$level" "$message" "$style"
		} 9>"$_SPINNER_LOCK_FILE"
	else
		write_log_text "$level" "$message" "$style"
	fi
}

# log_output <level> <message> [normal|detail|item|phase]: writes the message when <level> passes LOG_LEVEL
log_output() {
	local level="$1"
	local message="$2"
	local style="${3:-normal}"
	should_log "$level" || return 0
	write_log "$level" "$message" "$style"
}

export -f level_value should_log use_color log_file_start log_record_warning json_quote write_log_text write_log log_output log_debug log_error log_info log_success log_warning log_detail log_blank log_item_success log_item_info log_item_warning log_phase log_fatal module_skip
