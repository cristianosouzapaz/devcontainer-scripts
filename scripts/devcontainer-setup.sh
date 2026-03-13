#!/bin/bash
set -euo pipefail

# DevContainer Setup Orchestrator
#
# This script loads shared utilities and dynamically discovers and executes
# all setup modules found in the modules directory.

# ----- PATH AND STRUCTURE VARIABLES -------------------------------------------

_SETUP_MODULES_DIR="setup/modules"
_SETUP_SHARED_DIR="setup/shared"

# ----- INITIALIZATION ---------------------------------------------------------

# Check for --debug flag and override DEBUG_MODE if provided
[[ "${1:-}" == "--debug" ]] && DEBUG_MODE=true

# Resolve script directory (either local workspace mount or container copy)
SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"
[[ "$SCRIPT_DIR" == "." ]] && SCRIPT_DIR="$(pwd)"

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$SCRIPT_DIR/$_SETUP_SHARED_DIR/loader.sh"

# ----- FUNCTIONS --------------------------------------------------------------

# cleanup_temp_files: basic cleanup for ephemeral files created during setup
cleanup_temp_files() {
	rm -rf /tmp/devcontainer-* 2>/dev/null || true
	return 0
}

# ----- CORE SETUP -------------------------------------------------------------

# main: Orchestrates the full devcontainer setup sequence.
# Installs error traps, registers temp-file cleanup, loads environment
# variables, and runs all discovered modules in numeric order.
# Exits fatally if any module fails.
# Returns: 0 on success (does not return on fatal module failure).
main() {
	setup_error_traps || true
	register_cleanup cleanup_temp_files

	log_info "Starting setup in $(pwd)"

	load_env_file

	if [[ "${DEBUG_MODE}" == "true" ]]; then
		log_debug "User: ${GITHUB_USER}"
		log_debug "Context: $(pwd)"
	fi

	if ! run_all_modules "$SCRIPT_DIR/$_SETUP_MODULES_DIR"; then
		log_fatal "One or more setup modules failed"
	fi

	log_success "Setup completed"
}

# ----- ENTRY POINT ------------------------------------------------------------

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
	main "$@"
fi
