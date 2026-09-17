#!/bin/bash
set -euo pipefail

# MODULE_NAME="persistent-data"
# MODULE_DESCRIPTION="Initializes persistent-data storage and managed tool paths"
# MODULE_ENTRY="persistent_data_setup"
# MODULE_AFTER=""
# MODULE_SECRETS=""

# ----- OVERVIEW ---------------------------------------------------------------
#
# Runs before every other module: initializes the persistent-data storage layout
# and the managed home-directory links, so later modules write straight into the
# persistent volumes.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../lib" && pwd)/loader.sh"

# ----- HELPER FUNCTIONS -------------------------------------------------------

# persistent_data_create_category_directories: creates the directory of every registered category
persistent_data_create_category_directories() {
	local ids category_id category_path
	local -a category_ids=()

	# why: captured, not read from < <(...), whose failure status is never seen
	ids=$(provisioning_ids all) || return 1
	[[ -n "$ids" ]] || return 0
	mapfile -t category_ids <<<"$ids"
	for category_id in "${category_ids[@]}"; do
		category_path="$(persistent_data_category_path "$category_id")"
		mkdir -p "$category_path" || return 1
	done
}

# persistent_data_initialize: writes or checks the schema marker of each scope, then creates the category directories, each step under its locks
persistent_data_initialize() {
	with_shared_data_lock persistent_data_schema_initialize shared || return 1
	with_project_data_lock persistent_data_schema_initialize project || return 1
	with_shared_data_lock with_project_data_lock persistent_data_create_category_directories
}

# ----- CORE SETUP -------------------------------------------------------------

# persistent_data_setup: module entry; initializes storage, then ensures each category's managed link in document order
persistent_data_setup() {
	local ids category_id
	local -a category_ids=()

	persistent_data_initialize
	ids=$(provisioning_ids all)
	[[ -n "$ids" ]] || return 0
	mapfile -t category_ids <<<"$ids"
	for category_id in "${category_ids[@]}"; do
		persistent_data_link_ensure "$category_id"
	done
}

export -f persistent_data_create_category_directories \
	persistent_data_initialize persistent_data_setup
