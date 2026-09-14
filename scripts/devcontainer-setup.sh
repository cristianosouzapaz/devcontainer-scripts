#!/bin/bash
set -euo pipefail

# DevContainer Setup Orchestrator
#
# This script loads shared utilities and dynamically discovers and executes
# all setup modules found in the modules directory.

# ----- INITIALIZATION ---------------------------------------------------------

# Check for --debug flag and override DEBUG_MODE if provided
[[ "${1:-}" == "--debug" ]] && DEBUG_MODE=true

# Resolve script directory (either local workspace mount or container copy)
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# ----- SHARED UTILITIES LOADING -----------------------------------------------

# The loader publishes the absolute script tree anchors (DEVCONTAINER_LIB_DIR, DEVCONTAINER_MODULES_DIR, …)
# used below, so this is the only path this script has to spell out itself.
source "$SCRIPT_DIR/setup/lib/loader.sh"

# ----- FUNCTIONS --------------------------------------------------------------

# cleanup_temp_files: removes what an interrupted installer run left behind, in the same
# temp dir install.sh stages into (${TMPDIR:-/tmp}).
cleanup_temp_files() {
	rm -rf "${TMPDIR:-/tmp}"/devcontainer-* 2>/dev/null || true
	return 0
}

# ----- CORE SETUP -------------------------------------------------------------

# main: Orchestrates the full devcontainer setup sequence.
# Installs error traps, registers temp-file cleanup, loads environment
# variables, and runs all discovered modules in dependency order.
# Exits fatally if any module fails.
# Returns: 0 on success (does not return on fatal module failure).
main() {
	setup_error_traps
	register_cleanup cleanup_temp_files

	local script_version="unknown"
	[[ -f "$SCRIPT_DIR/VERSION" ]] && script_version="$(<"$SCRIPT_DIR/VERSION")"
	log_info "Starting setup in $(pwd) - version ${script_version}"

	load_env_file
	persist_env_vars

	if [[ "${DEBUG_MODE}" == "true" ]]; then
		log_debug "User: ${GIT_USER}"
		log_debug "Context: $(pwd)"
	fi

	if ! run_all_modules "$DEVCONTAINER_MODULES_DIR"; then
		log_fatal "One or more setup modules failed"
	fi

	persistent_data_summary_print

	log_success "Setup completed"
}

export -f cleanup_temp_files main

# ----- ENTRY POINT ------------------------------------------------------------

main "$@"
