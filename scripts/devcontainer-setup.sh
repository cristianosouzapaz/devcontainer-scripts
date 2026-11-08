#!/bin/bash
set -euo pipefail

# Setup orchestrator: loads the shared utilities, then runs three phases: Core (every
# unit of the core directory, in dependency order), Modules (every optional module of
# the modules directory) and Summary. It is the only writer of the setup log file,
# which holds exactly one run.

# ----- INITIALIZATION ---------------------------------------------------------

[[ "${1:-}" == "--debug" ]] && LOG_LEVEL=DEBUG

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# why: setup owns this file; an empty _LOG_FILE (as the test suite sets it) still means stderr only
_LOG_FILE="${_LOG_FILE-/tmp/setup.log}"

# ----- SHARED UTILITIES LOADING -----------------------------------------------

# why: the loader publishes the script tree anchors, so this is the only path spelled out here
source "$SCRIPT_DIR/setup/lib/loader.sh"

# ----- HELPER FUNCTIONS -------------------------------------------------------

# format_duration <seconds>: prints a duration as "<s>s" under a minute, else "<m>m <ss>s"
# Stdout: the duration, one line
format_duration() {
	local seconds="$1"
	if ((seconds < 60)); then
		printf '%ss\n' "$seconds"
	else
		printf '%sm %02ds\n' "$((seconds / 60))" "$((seconds % 60))"
	fi
}

# ----- CORE SETUP -------------------------------------------------------------

# main: runs the full setup (error traps, environment, the Core, Modules and Summary phases) between an opening line and a closing line with the outcome and duration, exiting when a unit fails
main() {
	local script_version="unknown" result errexit=false

	SECONDS=0
	setup_error_traps
	log_file_start

	[[ -f "$SCRIPT_DIR/VERSION" ]] && script_version="$(<"$SCRIPT_DIR/VERSION")"
	log_info "devcontainer setup ${script_version} · ${PROJECT_NAME:-${PWD##*/}}"
	log_debug "Context: $(pwd), user: ${GIT_USER:-unset}"

	registry_warnings_file_start
	discover_modules "$DEVCONTAINER_CORE_DIR" "$DEVCONTAINER_MODULES_DIR"
	warn_if_env_file_missing
	load_env_file
	persist_env_vars

	[[ "$-" != *e* ]] || errexit=true
	set +e
	run_all_modules "$DEVCONTAINER_CORE_DIR" "$DEVCONTAINER_MODULES_DIR"
	result=$?
	if "$errexit"; then set -e; else set +e; fi
	if [[ "$result" -ne 0 ]]; then
		# why: the closing line must stay the last one, so the error stack is printed before it
		dump_error_stack
		_ERROR_STACK=()
		log_fatal "Setup failed${FAILED_MODULE:+ in ${FAILED_MODULE}} (see above)"
	fi

	log_phase "Summary"
	persistent_data_summary_data
	print_module_states
	persistent_data_summary_sign_ins
	print_action_needed "${SIGN_IN_ACTIONS[@]+"${SIGN_IN_ACTIONS[@]}"}"

	log_success "Setup completed in $(format_duration "$SECONDS")"
}

export -f format_duration main

# ----- ENTRY POINT ------------------------------------------------------------

main "$@"
