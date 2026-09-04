#!/bin/bash
set -euo pipefail

# MODULE_NAME="persistent-data"
# MODULE_DESCRIPTION="Initializes persistent-data storage and managed tool paths"
# MODULE_ENTRY="persistent_data_setup"
# MODULE_AFTER=""

# ----- OVERVIEW ---------------------------------------------------------------
#
# Runs before every other module: initializes the persistent-data storage
# layout and creates the managed home-directory links (~/.agents, ~/.claude,
# ~/.codex, ~/.config/gh) so later modules write straight into the persistent
# volumes.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(dirname "${BASH_SOURCE[0]}")/../lib/loader.sh"

# ----- HELPER FUNCTIONS -------------------------------------------------------

# Test seams — not readonly so tests can avoid the standard home-directory links.
_PERSISTENT_DATA_AGENTS_LINK="${PERSISTENT_DATA_AGENTS_LINK:-/root/.agents}"
_PERSISTENT_DATA_CLAUDE_LINK="${PERSISTENT_DATA_CLAUDE_LINK:-/root/.claude}"
_PERSISTENT_DATA_CODEX_LINK="${PERSISTENT_DATA_CODEX_LINK:-/root/.codex}"
_PERSISTENT_DATA_GITHUB_LINK="${PERSISTENT_DATA_GITHUB_LINK:-/root/.config/gh}"

# persistent_data_create_category_directories: Creates every registered category directory.
persistent_data_create_category_directories() {
	local category_id category_path

	while IFS= read -r category_id; do
		category_path="$(persistent_data_category_path "$category_id")" || return 1
		mkdir -p "$category_path" || return 1
	done < <(persistent_data_category_ids)
}

# persistent_data_link_standard_path <destination> <category_id>: Ensures a managed link.
persistent_data_link_standard_path() {
	local destination="$1"
	local category_id="$2"
	local source_path current_target entries

	source_path="$(persistent_data_category_path "$category_id")" || return 1
	if [[ -L "$destination" ]]; then
		current_target="$(readlink "$destination")"
		if [[ "$current_target" == "$source_path" ]]; then
			return 0
		fi
		log_error "Persistent-data path is an unmanaged symlink: ${destination}"
		return 1
	fi
	if [[ -e "$destination" ]]; then
		entries=''
		if [[ -d "$destination" ]]; then
			entries="$(find "$destination" -mindepth 1 -print -quit)"
		fi
		if [[ -d "$destination" ]] && [[ -z "$entries" ]]; then
			rmdir "$destination" || return 1
		else
			log_error "Persistent-data path contains unmanaged data: ${destination}"
			return 1
		fi
	fi
	mkdir -p "$(dirname "$destination")" || return 1
	ln -s "$source_path" "$destination"
}

# persistent_data_initialize: Initializes schema markers and category directories.
persistent_data_initialize() {
	with_shared_data_lock persistent_data_schema_initialize shared || return 1
	with_project_data_lock persistent_data_schema_initialize project || return 1
	with_shared_data_lock with_project_data_lock persistent_data_create_category_directories
}

# ----- CORE SETUP -------------------------------------------------------------

# persistent_data_setup: Initializes storage and creates the standard managed links.
# Returns: 0 on success, 1 for incompatible or unmanaged data.
persistent_data_setup() {
	setup_error_traps
	persistent_data_registry_validate || return 1
	persistent_data_initialize || return 1
	persistent_data_link_standard_path "$_PERSISTENT_DATA_AGENTS_LINK" agents || return 1
	persistent_data_link_standard_path "$_PERSISTENT_DATA_CLAUDE_LINK" claude || return 1
	persistent_data_link_standard_path "$_PERSISTENT_DATA_CODEX_LINK" codex || return 1
	persistent_data_link_standard_path "$_PERSISTENT_DATA_GITHUB_LINK" github
}

export -f persistent_data_create_category_directories persistent_data_link_standard_path \
	persistent_data_initialize persistent_data_setup
