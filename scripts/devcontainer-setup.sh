#!/bin/bash
set -euo pipefail

# Setup orchestrator: loads the shared utilities, then runs every setup module found in
# the modules directory in dependency order.

# ----- INITIALIZATION ---------------------------------------------------------

[[ "${1:-}" == "--debug" ]] && DEBUG_MODE=true

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# ----- SHARED UTILITIES LOADING -----------------------------------------------

# why: the loader publishes the script tree anchors, so this is the only path spelled out here
source "$SCRIPT_DIR/setup/lib/loader.sh"

# ----- FUNCTIONS --------------------------------------------------------------

# cleanup_temp_files: removes the devcontainer-* directories an interrupted installer run left in ${TMPDIR:-/tmp}
cleanup_temp_files() {
	rm -rf "${TMPDIR:-/tmp}"/devcontainer-* 2>/dev/null || true
	return 0
}

# ----- CORE SETUP -------------------------------------------------------------

# main: runs the full setup (error traps, environment, every module in dependency order, persistent-data summary), exiting when a module fails
main() {
	local script_version="unknown" result errexit=false

	setup_error_traps
	register_cleanup cleanup_temp_files

	[[ -f "$SCRIPT_DIR/VERSION" ]] && script_version="$(<"$SCRIPT_DIR/VERSION")"
	log_info "Starting setup in $(pwd) - version ${script_version}"

	discover_modules "$DEVCONTAINER_MODULES_DIR"
	load_env_file
	persist_env_vars

	if [[ "${DEBUG_MODE}" == "true" ]]; then
		log_debug "User: ${GIT_USER}"
		log_debug "Context: $(pwd)"
	fi

	[[ "$-" != *e* ]] || errexit=true
	set +e
	run_all_modules "$DEVCONTAINER_MODULES_DIR"
	result=$?
	if "$errexit"; then set -e; else set +e; fi
	if [[ "$result" -ne 0 ]]; then
		log_fatal "One or more setup modules failed"
	fi

	persistent_data_summary_print

	log_success "Setup completed"
}

export -f cleanup_temp_files main

# ----- ENTRY POINT ------------------------------------------------------------

main "$@"
