#!/bin/bash

[[ -n "${_SPINNER_SH_LOADED:-}" ]] && return 0
readonly _SPINNER_SH_LOADED=1

# Braille-dot spinner for long-running operations (network calls, package
# installs). Animates whenever STRUCTURED_LOGS is disabled — no TTY check, for
# the same reason use_color() (logging.sh) has none: setup runs as
# postCreateCommand, piped into the editor's terminal-capable output panel
# (renders \r/ANSI like a real terminal even without a pty), which is the
# only environment that matters here. STRUCTURED_LOGS remains the escape
# hatch for anyone who wants clean, non-redraw output (machine consumption,
# or output manually redirected to a plain file). Uses logging.sh's color
# constants and error-handler.sh's cleanup registry, so both must be sourced
# first. Requires `flock` (util-linux) to arbitrate between the background
# draw loop and spinner_stream's line-by-line output — present by default
# on every devcontainer base image this template targets.

# ----- INTERNAL CONSTANTS -----------------------------------------------------

readonly -a _SPINNER_FRAMES=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
_SPINNER_FRAME_DELAY=0.08

# ----- INTERNAL STATE -----------------------------------------------------

_SPINNER_PID=""
_SPINNER_MESSAGE=""
_SPINNER_CLEANUP_REGISTERED=""
_SPINNER_LOCK_FILE=""

# spinner_active: whether the spinner should animate in the current context.
spinner_active() {
	[[ "${STRUCTURED_LOGS}" == "true" ]] && return 1
	return 0
}

# spinner_draw: background loop that redraws the frame on stderr until killed.
# Each frame is drawn under a non-blocking flock on lock_file: when
# spinner_stream holds that lock to print a streamed line, this loop simply
# skips the frame instead of writing, so the animation and the streamed
# line never interleave on the same fd.
# Args: message - the text to show next to the spinner.
#       lock_file - path to the lock file shared with spinner_stream.
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

# spinner_cleanup: kills the background draw loop and restores the cursor.
# Registered via register_cleanup so it also runs on unexpected exit.
spinner_cleanup() {
	if [[ -n "$_SPINNER_PID" ]]; then
		kill "$_SPINNER_PID" 2>/dev/null || true
		wait "$_SPINNER_PID" 2>/dev/null || true
		_SPINNER_PID=""
		printf '\r\033[K' >&2 || true
		tput cnorm 2>/dev/null || true
	fi
	if [[ -n "$_SPINNER_LOCK_FILE" ]]; then
		rm -f "$_SPINNER_LOCK_FILE" 2>/dev/null || true
		_SPINNER_LOCK_FILE=""
	fi
	return 0
}

# start_spinner: begins an animated spinner with the given message.
# Falls back to a single log_info line when STRUCTURED_LOGS is enabled.
# Calling this again before stop_spinner implicitly stops the previous
# spinner first, so no background loop leaks.
# Args: message - the text to show next to the spinner.
# Returns: 0 always.
start_spinner() {
	local message="$1"
	spinner_cleanup
	_SPINNER_MESSAGE="$message"
	if ! spinner_active; then
		log_info "$message"
		return 0
	fi
	_SPINNER_LOCK_FILE=$(mktemp)
	tput civis 2>/dev/null || true
	spinner_draw "$message" "$_SPINNER_LOCK_FILE" &
	_SPINNER_PID=$!
	if [[ -z "$_SPINNER_CLEANUP_REGISTERED" ]]; then
		register_cleanup spinner_cleanup
		_SPINNER_CLEANUP_REGISTERED=true
	fi
}

# stop_spinner: stops the animated spinner and logs the final outcome.
# Args: exit_code - 0 for success, non-zero for failure (default: 0).
# Returns: 0 always.
stop_spinner() {
	local exit_code="${1:-0}"
	spinner_cleanup
	if [[ "$exit_code" -eq 0 ]]; then
		log_item_success "$_SPINNER_MESSAGE"
	else
		log_error "$_SPINNER_MESSAGE"
	fi
}

# spinner_stream <log_function> <command...>: Runs <command...>, logging its
# combined stdout+stderr one line at a time as it's produced — real
# streaming, not a buffer-then-dump-at-the-end. Intended for log_debug. The
# spinner is never stopped for the command's whole duration: instead, each
# streamed line takes the same flock spinner_draw uses, clears whatever
# frame is currently on screen, prints the line, then releases the lock —
# so the animation keeps running between lines and only steps aside for the
# instant it takes to print one. The lock/clear dance only happens when the
# output would actually be visible (DEBUG_MODE=true or LOG_LEVEL=DEBUG);
# never for a command whose output is going to be discarded anyway.
# MUST use process substitution (`< <(...)`), not a pipe (`cmd | while ...`):
# a pipe runs the loop body in a subshell, so any start_spinner spawned
# inside it would orphan its background draw loop once that subshell
# exits — see the warning in retry.sh for the full story.
# Args: log_function - name of a logging.sh function (e.g. log_debug).
#       command... - the command (and args) to run.
# Returns: the command's own exit code.
spinner_stream() {
	local log_function="$1"
	shift
	local line was_active will_log exit_file exit_code lock_file

	was_active="$_SPINNER_PID"
	lock_file="$_SPINNER_LOCK_FILE"
	will_log=false
	if [[ "${DEBUG_MODE}" == "true" ]] || should_log "DEBUG"; then
		will_log=true
	fi

	exit_file=$(mktemp)

	while IFS= read -r line; do
		if [[ -n "$was_active" && "$will_log" == "true" ]]; then
			{
				flock 9
				printf '\r\033[K' >&2
				"$log_function" "$line"
			} 9>"$lock_file"
		else
			"$log_function" "$line"
		fi
	done < <(_cmd_exit_code=0; "$@" 2>&1 || _cmd_exit_code=$?; echo "$_cmd_exit_code" >"$exit_file")

	exit_code=$(<"$exit_file")
	rm -f "$exit_file"

	return "$exit_code"
}

export -f spinner_active spinner_draw spinner_cleanup start_spinner stop_spinner spinner_stream
