#!/bin/bash
set -euo pipefail

# MODULE_NAME="workspaces"
# MODULE_DESCRIPTION="Generates the VS Code .code-workspace file for multi-repo containers"
# MODULE_ENTRY="workspaces_setup"

# VS Code workspace generation module

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(dirname "${BASH_SOURCE[0]}")/../shared/loader.sh"

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# This module uses the following configuration variables:
# - PROJECT_NAME    Container workspace project name (set in remoteEnv); used for the workspace filename.
# - REPO_SOURCE_N   Numbered clone URLs (REPO_SOURCE_1, REPO_SOURCE_2, …); determines multi-repo mode.

# ----- CONSTANTS --------------------------------------------------------------

# Test seam — not readonly so tests can override it
_WORKSPACE_DIR="${_WORKSPACE_DIR:-/workspace}"

# ----- HELPER FUNCTIONS -------------------------------------------------------

# build_workspace_json <folder_name...>: Writes a .code-workspace JSON document to stdout.
# Each argument is a folder name relative to the workspace root.
build_workspace_json() {
	jq -n --raw-input '{
		folders: [ inputs | { name: ., path: . } ],
		settings: {}
	}' <(printf '%s\n' "$@")
}

# ----- CORE SETUP -------------------------------------------------------------

# workspaces_setup: Module entry point. Skips silently when fewer than two
# repos are configured via REPO_SOURCE_N. Otherwise generates
# /workspace/<PROJECT_NAME>.code-workspace listing each repo as a root
# folder. Idempotent: an existing workspace file is never overwritten.
workspaces_setup() {
	local -a _entries=()
	local url folder_name workspace_file
	local -a _folders=()
	setup_error_traps

	collect_numbered_repo_entries _entries

	if [[ "${#_entries[@]}" -le 1 ]]; then
		log_debug "Single-repo or no repos configured — skipping workspace file generation"
		module_skip
		return 0
	fi

	if ! check_command "jq"; then
		log_debug "jq not available, skipping workspace file generation"
		module_skip
		return 0
	fi

	if [[ -z "${PROJECT_NAME:-}" ]]; then
		log_error "PROJECT_NAME is not set — cannot determine workspace file name"
		return 1
	fi

	workspace_file="${_WORKSPACE_DIR}/${PROJECT_NAME}.code-workspace"

	if [[ -f "$workspace_file" ]]; then
		log_debug "Workspace file already exists — skipping: ${workspace_file}"
		return 0
	fi

	for url in "${_entries[@]}"; do
		folder_name="$(repo_entry_folder_name "$url")"
		_folders+=("$folder_name")
	done

	log_detail "Generating workspace file: ${workspace_file}"
	build_workspace_json "${_folders[@]}" > "$workspace_file"
	log_item_success "Workspace file generated: ${workspace_file}"
}

export -f build_workspace_json workspaces_setup
