# shellcheck shell=bash
[[ -n "${_SPINNER_SH_LOADED:-}" ]] && return 0
readonly _SPINNER_SH_LOADED=1

# Braille-dot spinner for long-running operations (network calls, package installs).
#
# Animates whenever STRUCTURED_LOGS is off, with no TTY check for the reason in
# use_color's Notes; STRUCTURED_LOGS is the escape hatch for clean, non-redraw
# output. Needs logging.sh and error-handler.sh sourced first, and flock
# (util-linux, on every targeted base image) to keep the draw loop and the lines
# write_log prints meanwhile from interleaving.

# ----- INTERNAL CONSTANTS -----------------------------------------------------

readonly -a _SPINNER_FRAMES=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
_SPINNER_FRAME_DELAY=0.08

# ----- INTERNAL STATE ---------------------------------------------------------

_SPINNER_PID=""
_SPINNER_CLEANUP_REGISTERED=""
_SPINNER_LOCK_FILE=""
_SPINNER_EXIT_FILE=""
_SPINNER_EXIT_CLEANUP_REGISTERED=""

# spinner_active: succeeds when the spinner should animate, i.e. STRUCTURED_LOGS is not true
spinner_active() {
	[[ "${STRUCTURED_LOGS}" == "true" ]] && return 1
	return 0
}

# spinner_draw <message> <lock_file>: redraws the spinner frame on stderr in a loop until killed
# Notes: each frame takes a non-blocking flock on lock_file and is skipped while
#   spinner_stream holds it to print a line, so the two never interleave on stderr.
spinner_draw() {
	local message="$1"
	local lock_file="$2"
	local i=0
	local frame
	local color=""
	local reset=""
	if use_color; then
		color="$_COLOR_GRAY"
		reset="$_COLOR_RESET"
	fi
	while true; do
		frame="${_SPINNER_FRAMES[$((i % ${#_SPINNER_FRAMES[@]}))]}"
		{
			flock -n 9 && printf '\r%b%s%b %s' "$color" "$frame" "$reset" "$message" >&2
		} 9>"$lock_file"
		i=$((i + 1))
		sleep "$_SPINNER_FRAME_DELAY"
	done
}

# spinner_cleanup: kills the draw loop, clears its line, restores the cursor and removes the lock file
# Notes: registered with register_cleanup so it also runs on an unexpected exit.
spinner_cleanup() {
	if [[ -n "$_SPINNER_PID" ]]; then
		kill "$_SPINNER_PID" 2>/dev/null || true
		wait "$_SPINNER_PID" 2>/dev/null || true
		_SPINNER_PID=""
		printf '\r\033[K' >&2 || true
		if command -v tput >/dev/null 2>&1; then
			tput cnorm >&2 2>/dev/null || true
		fi
	fi
	if [[ -n "$_SPINNER_LOCK_FILE" ]]; then
		rm -f "$_SPINNER_LOCK_FILE" 2>/dev/null || true
		_SPINNER_LOCK_FILE=""
	fi
	return 0
}

# spinner_exit_file_cleanup: removes the command-status file when setup exits before spinner_stream can do so
spinner_exit_file_cleanup() {
	if [[ -n "$_SPINNER_EXIT_FILE" ]]; then
		rm -f "$_SPINNER_EXIT_FILE" 2>/dev/null || true
		_SPINNER_EXIT_FILE=""
	fi
}

# start_spinner <message>: starts the spinner in the background with a present-tense message, such as "Installing Codex CLI (@openai/codex)"; with STRUCTURED_LOGS on, logs the message at DEBUG instead
# Notes: stops a spinner still running first, so no draw loop leaks. The running message
#   is never written to the log file: only the outcome stop_spinner logs is.
start_spinner() {
	local message="$1"
	spinner_cleanup
	if ! spinner_active; then
		log_debug "$message"
		return 0
	fi
	_SPINNER_LOCK_FILE=$(mktemp)
	if command -v tput >/dev/null 2>&1; then
		tput civis >&2 2>/dev/null || true
	fi
	spinner_draw "$message" "$_SPINNER_LOCK_FILE" &
	_SPINNER_PID=$!
	if [[ -z "$_SPINNER_CLEANUP_REGISTERED" ]]; then
		register_cleanup spinner_cleanup
		_SPINNER_CLEANUP_REGISTERED=true
	fi
}

# stop_spinner <exit_code> <outcome>: stops the spinner and logs the past-tense outcome, such as "Codex CLI installed", as a success item for 0, as an error otherwise
stop_spinner() {
	local exit_code="$1" outcome="$2"
	spinner_cleanup
	if [[ "$exit_code" -eq 0 ]]; then
		log_item_success "$outcome"
	else
		log_error "$outcome"
	fi
}

# spinner_stream <log_function> <command...>: runs the command and logs each line of its combined output through <log_function> as it arrives
# Returns: the command's exit status.
# Notes: the spinner keeps running: write_log takes spinner_draw's lock for each line it
#   shows, so the animation steps aside only for that instant. The loop reads a process
#   substitution, not a pipe: a pipe runs the loop body in a subshell, where a
#   start_spinner would orphan its draw loop when the subshell exits. The command's stdin is
#   /dev/null so a prompting CLI fails on EOF instead of blocking on the lifecycle
#   hook's open, silent stdin. Never call retry_command inside it: its retry lines would
#   be re-logged through <log_function>; run spinner_stream inside retry_command instead.
spinner_stream() {
	local log_function="$1" line exit_file exit_code
	shift

	exit_file=$(mktemp)
	_SPINNER_EXIT_FILE="$exit_file"
	if [[ -z "$_SPINNER_EXIT_CLEANUP_REGISTERED" ]]; then
		register_cleanup spinner_exit_file_cleanup
		_SPINNER_EXIT_CLEANUP_REGISTERED=true
	fi

	while IFS= read -r line; do
		"$log_function" "$line"
	done < <(_cmd_exit_code=0; "$@" </dev/null 2>&1 || _cmd_exit_code=$?; echo "$_cmd_exit_code" >"$exit_file")

	exit_code=$(<"$exit_file")
	rm -f "$exit_file"
	_SPINNER_EXIT_FILE=""

	return "$exit_code"
}

export -f spinner_active spinner_draw spinner_cleanup start_spinner stop_spinner spinner_stream
