# shellcheck shell=bash

# CORE_NAME="workspaces"
# CORE_DESCRIPTION="Generates the VS Code .code-workspace file for multi-repo and/or extra-folder containers"
# CORE_ENTRY="workspaces_setup"
# CORE_AFTER="git"
# CORE_SECRETS=""

# ----- OVERVIEW ---------------------------------------------------------------
#
# Generates /workspace/<PROJECT_NAME>.code-workspace with each repository and each
# EXTRA_FOLDER_N as a root folder, for two or more repositories or any extra folder.
# An existing file is never overwritten.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../lib" && pwd)/loader.sh"

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# Documented in README.md#configuration-variables:
# - EXTRA_FOLDER_N
# - PROJECT_NAME
# - REPO_SOURCE_N

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_WORKSPACE_DIR="${_WORKSPACE_DIR:-/workspace}"

# ----- HELPER FUNCTIONS -------------------------------------------------------

# build_workspace_json <folder_name...>: prints a .code-workspace JSON document with one root folder per name, relative to the workspace root
# Stdout: the .code-workspace JSON document
build_workspace_json() {
	jq -n --raw-input '{
		folders: [ inputs | { name: ., path: . } ],
		settings: {}
	}' <(printf '%s\n' "$@")
}

# ----- CORE SETUP -------------------------------------------------------------

# workspaces_setup: core entry; writes the .code-workspace file once, skipping for fewer than two repositories and no extra folder
# Notes: one repository clones into $PROJECT_NAME whichever REPO_SOURCE variant it
#   came from, as in git_setup; only two or more use repo_entry_folder_name. The
#   file is written atomically: a partial file would pass the already-exists check
#   on every later run.
workspaces_setup() {
	local -a _entries=()
	local -a _extra_folders=()
	local url folder_name workspace_file
	local -a _folders=()

	collect_numbered_repo_entries _entries
	collect_numbered_extra_folders _extra_folders

	if [[ "${#_entries[@]}" -le 1 && "${#_extra_folders[@]}" -eq 0 ]]; then
		log_debug "Single-repo or no repos, and no extra folders — skipping workspace file generation"
		module_skip 'single repository, no extra folders'
		return 0
	fi

	if [[ -z "${PROJECT_NAME:-}" ]]; then
		log_error "PROJECT_NAME is not set — cannot determine workspace file name"
		return 1
	fi

	workspace_file="${_WORKSPACE_DIR}/${PROJECT_NAME}.code-workspace"

	if [[ -f "$workspace_file" ]]; then
		log_item_success "Workspace file ${workspace_file##*/} already present"
		return 0
	fi

	if [[ "${#_entries[@]}" -ge 2 ]]; then
		for url in "${_entries[@]}"; do
			folder_name="$(repo_entry_folder_name "$url")"
			_folders+=("$folder_name")
		done
	else
		_folders+=("$PROJECT_NAME")
	fi
	_folders+=("${_extra_folders[@]}")

	log_debug "Generating workspace file: ${workspace_file}"
	atomic_write "$workspace_file" build_workspace_json "${_folders[@]}"
	log_item_success "Workspace file ${workspace_file##*/} generated"
}

export -f build_workspace_json workspaces_setup
