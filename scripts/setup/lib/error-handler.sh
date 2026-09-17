# shellcheck shell=bash
[[ -n "${_ERROR_HANDLER_SH_LOADED:-}" ]] && return 0
readonly _ERROR_HANDLER_SH_LOADED=1

# Error stack, cleanup registries, and the ERR/EXIT/INT/TERM trap handlers that feed
# and drain them.

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# Documented in README.md#configuration-variables:
# - DUMP_ERROR_STACK

# ----- ERROR CODE CONSTANTS ---------------------------------------------------

readonly DEVCONTAINER_FATAL_ERROR=1
# shellcheck disable=SC2034 # consumed by modules/git.sh
readonly DEVCONTAINER_VALIDATION_ERROR=2
# shellcheck disable=SC2034 # consumed by modules/git.sh
readonly DEVCONTAINER_AUTH_ERROR=4
# shellcheck disable=SC2034 # consumed by modules/ngrok.sh
readonly DEVCONTAINER_NETWORK_ERROR=8

# ----- INTERNAL STATE ---------------------------------------------------------

declare -a _ERROR_STACK=()
declare -a _CLEANUP_HANDLERS=()
declare -a _MODULE_CLEANUP_HANDLERS=()
_ERROR_LAST_DEPTH=0
_ERROR_LAST_CODE=0
_ERROR_LAST_LINE=0

# ----- FUNCTIONS --------------------------------------------------------------

# register_cleanup <handler>: adds a function name or command to the process-wide cleanups run on exit
register_cleanup() {
	local handler="$1"
	_CLEANUP_HANDLERS+=("$handler")
}

# run_cleanup_handlers: runs the process-wide cleanups in LIFO order, recording a failing one with push_error and going on
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

# register_module_cleanup <handler>: adds a function name or command to the cleanups of the current module
# Notes: run_module runs them in the parent right after the module's subshell ends,
#   whatever its status, then clears them, so a module's secrets (a clone token, an
#   auth token, a signing key) never reach the next module. on_exit runs any still
#   pending, for a signal delivered to the parent mid-module.
register_module_cleanup() {
	local handler="$1"
	_MODULE_CLEANUP_HANDLERS+=("$handler")
}

# run_module_cleanup_handlers: runs the module cleanups like run_cleanup_handlers, then clears them so each runs at most once
run_module_cleanup_handlers() {
	local i handler rc
	if [[ "${#_MODULE_CLEANUP_HANDLERS[@]}" -eq 0 ]]; then
		return 0
	fi
	for ((i = ${#_MODULE_CLEANUP_HANDLERS[@]} - 1; i >= 0; i--)); do
		handler="${_MODULE_CLEANUP_HANDLERS[$i]}"
		if declare -F "$handler" >/dev/null 2>&1; then
			"$handler" || rc=$?
		else
			eval "$handler" || rc=$?
		fi
		if [[ -n "${rc:-}" && "$rc" -ne 0 ]]; then
			push_error "$rc" "${LINENO}" "MODULE_CLEANUP:${handler}" "${handler}" "cleanup failed"
			rc=0
		fi
	done
	_MODULE_CLEANUP_HANDLERS=()
	return 0
}

# push_error [code] [lineno] [func] [cmd] [message...]: appends a code|lineno|func|cmd|message entry to _ERROR_STACK
# Notes: code defaults to DEVCONTAINER_FATAL_ERROR, lineno to 0 and func to MAIN. It
#   also records the caller's depth, call site and status, so handle_error does not
#   record the same failure again as it propagates to that call site.
push_error() {
	local code lineno func cmd msg
	code="${1:-$DEVCONTAINER_FATAL_ERROR}"
	shift || true
	lineno="${1:-0}"
	shift || true
	func="${1:-MAIN}"
	shift || true
	cmd="${1:-}"
	shift || true
	msg="${*:-}"
	_ERROR_STACK+=("${code}|${lineno}|${func}|${cmd}|${msg}")
	_ERROR_LAST_DEPTH=${#FUNCNAME[@]}
	_ERROR_LAST_LINE=${BASH_LINENO[1]:-0}
	_ERROR_LAST_CODE=$code
}

# dump_error_stack: logs each _ERROR_STACK entry as a numbered error line with its code, lineno, func, cmd and message
dump_error_stack() {
	local i entry code lineno func cmd msg line

	if [[ "${#_ERROR_STACK[@]}" -eq 0 ]]; then
		return 0
	fi
	for i in "${!_ERROR_STACK[@]}"; do
		entry="${_ERROR_STACK[$i]}"
		IFS='|' read -r code lineno func cmd msg <<<"$entry"
		line=$(printf '%s: code=%s lineno=%s func=%s cmd=%s msg=%s' "$((i + 1))" "$code" "$lineno" "$func" "$cmd" "${msg:-}")
		log_error "$line"
	done
}

# handle_error: ERR trap handler; records the failing command with its context in _ERROR_STACK
# Notes: a failure already recorded one frame down is skipped when it reaches the
#   tracked caller site with the same status; every ERR, skipped or not, moves the
#   tracked depth, site and status. Nothing is recorded while run_module waits on a
#   module subshell: the registry imports the origin from the child, not the subshell
#   command.
handle_error() {
	local exit_code=$? depth
	[[ "${module_waiting:-false}" != true ]] || return 0
	depth=${#FUNCNAME[@]}
	if [[ "$depth" -ne $(( _ERROR_LAST_DEPTH - 1 )) ||
		"${BASH_LINENO[0]:-0}" != "$_ERROR_LAST_LINE" ||
		"$exit_code" != "$_ERROR_LAST_CODE" ]]; then
		push_error "$exit_code" "${BASH_LINENO[0]:-0}" "${FUNCNAME[1]:-MAIN}" "${BASH_COMMAND:-}" ""
	fi
	_ERROR_LAST_DEPTH=$depth
	_ERROR_LAST_LINE=${BASH_LINENO[1]:-0}
	_ERROR_LAST_CODE=$exit_code
}

# on_sigint: INT trap handler; records SIGINT and exits 130, so the EXIT trap runs the cleanups
on_sigint() {
	push_error 130 "${LINENO}" "SIGINT" "SIGINT received"
	exit 130
}

# on_sigterm: TERM trap handler; records SIGTERM and exits 143, so the EXIT trap runs the cleanups
on_sigterm() {
	push_error 143 "${LINENO}" "SIGTERM" "SIGTERM received"
	exit 143
}

# on_exit: EXIT trap handler; runs pending module cleanups, then process-wide cleanups, then logs the error stack when DUMP_ERROR_STACK is true
# Notes: module cleanups run here as a backstop: run_module normally runs them after
#   the module subshell ends, which a signal or fatal exit mid-module skips. Always
#   returns 0 so it never blocks the EXIT trap chain.
on_exit() {
	run_module_cleanup_handlers || true
	run_cleanup_handlers || true

	if [[ "${DUMP_ERROR_STACK}" == "true" && "${#_ERROR_STACK[@]}" -gt 0 ]]; then
		dump_error_stack
	fi
	return 0
}

# setup_error_traps: turns on errtrace and installs handle_error on ERR, on_exit on EXIT, on_sigint on INT and on_sigterm on TERM; call once at startup
setup_error_traps() {
	set -E
	trap 'handle_error' ERR
	trap 'on_exit' EXIT
	trap 'on_sigint' INT
	trap 'on_sigterm' TERM
}

export -f push_error dump_error_stack handle_error setup_error_traps on_sigint on_sigterm on_exit register_cleanup run_cleanup_handlers register_module_cleanup run_module_cleanup_handlers
