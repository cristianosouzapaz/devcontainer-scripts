#!/bin/bash
set -euo pipefail

# MODULE_NAME="workspaces"
# MODULE_DESCRIPTION="Generates the VS Code .code-workspace file for multi-repo containers"
# MODULE_ENTRY="workspaces_setup"

# VS Code workspace generation module
#
# This module generates a .code-workspace file at /workspace/<PROJECT_NAME>.code-workspace
# when two or more repositories are configured via REPO_SOURCE_N environment variables.
# Single-repo containers are skipped silently — no workspace file is needed.
# The file is idempotent: if it already exists it is left unchanged.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(dirname "${BASH_SOURCE[0]}")/../shared/loader.sh"

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# This module uses the following configuration variables:
# - PROJECT_NAME    Container workspace project name (set in remoteEnv); used for the workspace filename.
# - REPO_SOURCE_N   Numbered clone URLs (REPO_SOURCE_1, REPO_SOURCE_2, …); determines multi-repo mode.

# ----- PATH AND STRUCTURE VARIABLES -------------------------------------------

# Test seam — not readonly so tests can override it
_WORKSPACE_DIR="${_WORKSPACE_DIR:-/workspace}"

# ----- HELPER FUNCTIONS -------------------------------------------------------

# _build_workspace_json <folder_name...>: Writes a .code-workspace JSON document to stdout.
# Each argument is a folder name relative to the workspace root.
_build_workspace_json() {
	local folders_json="" folder sep=""

	for folder in "$@"; do
		folders_json+="${sep}        { \"name\": \"${folder}\", \"path\": \"${folder}\" }"
		sep=$',\n'
	done

	printf '{\n    "folders": [\n%s\n    ],\n    "settings": {}\n}\n' "$folders_json"
}

# _collect_workspace_entries <nameref>: Populates an array with clone URLs from REPO_SOURCE_N env vars.
# Reads REPO_SOURCE_1, REPO_SOURCE_2, … until the first unset or empty variable.
# Does not fall back to REPO_SOURCE — that variable signals single-repo mode, which this module skips.
_collect_workspace_entries() {
	local -n _out_entries="$1"
	local i=1 url var

	while true; do
		var="REPO_SOURCE_${i}"
		url="${!var:-}"
		[[ -z "$url" ]] && break
		_out_entries+=("$url")
		i=$(( i + 1 ))
	done
}

# ----- CORE SETUP -------------------------------------------------------------

# workspaces_setup: Module entry point.
# Skips silently when fewer than two repos are configured via REPO_SOURCE_N.
# Otherwise generates /workspace/<PROJECT_NAME>.code-workspace listing each repo as a root folder.
# Idempotent: an existing workspace file is never overwritten.
workspaces_setup() {
	local -a _entries=()
	local url folder_name workspace_file
	local -a _folders=()
	setup_error_traps || true

	_collect_workspace_entries _entries

	if [[ "${#_entries[@]}" -le 1 ]]; then
		log_debug "Single-repo or no repos configured — skipping workspace file generation"
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

	log_info "Generating workspace file: ${workspace_file}"
	_build_workspace_json "${_folders[@]}" > "$workspace_file"
	log_success "Workspace file generated: ${workspace_file}"
}
