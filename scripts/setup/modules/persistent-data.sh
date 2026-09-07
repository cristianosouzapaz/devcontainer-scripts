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
# ~/.codex, ~/.config/gh, ~/.local/share/pnpm) so later modules write straight
# into the persistent volumes.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../lib" && pwd)/loader.sh"

# ----- HELPER FUNCTIONS -------------------------------------------------------

# persistent_data_create_category_directories: Creates every registered category directory.
persistent_data_create_category_directories() {
	local category_id category_path

	while IFS= read -r category_id; do
		category_path="$(persistent_data_category_path "$category_id")" || return 1
		mkdir -p "$category_path" || return 1
	done < <(persistent_data_category_ids)
}

# persistent_data_initialize: Initializes schema markers and category directories.
persistent_data_initialize() {
	with_shared_data_lock persistent_data_schema_initialize shared || return 1
	with_project_data_lock persistent_data_schema_initialize project || return 1
	with_shared_data_lock with_project_data_lock persistent_data_create_category_directories
}

# ----- CORE SETUP -------------------------------------------------------------

# persistent_data_setup: Initializes storage and creates the standard managed links.
# Walks the registry in declaration order; a category with no managed link
# (see setup/lib/persistent-data/links.sh) is skipped.
# Returns: 0 on success, 1 for incompatible or unmanaged data.
persistent_data_setup() {
	local category_id

	setup_error_traps
	persistent_data_registry_validate || return 1
	persistent_data_initialize || return 1
	while IFS= read -r category_id; do
		persistent_data_link_ensure "$category_id" || return 1
	done < <(persistent_data_category_ids)
}

export -f persistent_data_create_category_directories \
	persistent_data_initialize persistent_data_setup
