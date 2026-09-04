#!/bin/bash
set -euo pipefail

# MODULE_NAME="workspaces"
# MODULE_DESCRIPTION="Generates the VS Code .code-workspace file for multi-repo and/or extra-folder containers"
# MODULE_ENTRY="workspaces_setup"
# MODULE_AFTER="git"

# ----- OVERVIEW ---------------------------------------------------------------
#
# Generates the VS Code /workspace/<PROJECT_NAME>.code-workspace file listing
# each repo and each EXTRA_FOLDER_N as a root folder. Skips silently for a
# single repo with no extra folders; never overwrites an existing file.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../lib" && pwd)/loader.sh"

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# This module uses the following configuration variables:
# - PROJECT_NAME     Container workspace project name (set in remoteEnv); used for the workspace filename.
# - REPO_SOURCE_N    Numbered clone URLs (REPO_SOURCE_1, REPO_SOURCE_2, …); determines multi-repo mode.
# - EXTRA_FOLDER_N   Numbered extra folder names (EXTRA_FOLDER_1, EXTRA_FOLDER_2, …); already bind-mounted
#                    at /workspace/<name> by devcontainer.json.

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
# repos and no extra folders are configured via REPO_SOURCE_N / EXTRA_FOLDER_N.
# Otherwise generates /workspace/<PROJECT_NAME>.code-workspace listing each
# repo and each extra folder as a root folder. Idempotent: an existing
# workspace file is never overwritten.
workspaces_setup() {
	local -a _entries=()
	local -a _extra_folders=()
	local url folder_name workspace_file
	local -a _folders=()
	setup_error_traps

	collect_numbered_repo_entries _entries
	collect_numbered_extra_folders _extra_folders

	if [[ "${#_entries[@]}" -le 1 && "${#_extra_folders[@]}" -eq 0 ]]; then
		log_debug "Single-repo or no repos, and no extra folders — skipping workspace file generation"
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
		log_item_success "Workspace file already exists: ${workspace_file}"
		return 0
	fi

	# Mirrors git.sh's git_setup: exactly one repo (whichever REPO_SOURCE
	# variant it came from) clones into $PROJECT_NAME; only 2+ repos use
	# repo_entry_folder_name per entry.
	if [[ "${#_entries[@]}" -ge 2 ]]; then
		for url in "${_entries[@]}"; do
			folder_name="$(repo_entry_folder_name "$url")"
			_folders+=("$folder_name")
		done
	else
		_folders+=("$PROJECT_NAME")
	fi
	_folders+=("${_extra_folders[@]}")

	log_detail "Generating workspace file: ${workspace_file}"
	build_workspace_json "${_folders[@]}" > "$workspace_file"
	log_item_success "Workspace file generated: ${workspace_file}"
}

export -f build_workspace_json workspaces_setup
