#!/bin/bash

[[ -n "${_PERSISTENT_DATA_LINKS_SH_LOADED:-}" ]] && return 0
readonly _PERSISTENT_DATA_LINKS_SH_LOADED=1

# Managed home-directory links for persistent-data categories whose owning tool
# cannot be pointed at the volume. They live in lib/ because the setup orchestrator
# creates them and bin/devcontainer-data verifies and repairs them. A category
# without a homeLink has no managed link.

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# - PERSISTENT_DATA_HOME: home directory the managed links live under (default /root)

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_PERSISTENT_DATA_HOME="${PERSISTENT_DATA_HOME:-/root}"

# ----- FUNCTIONS --------------------------------------------------------------

# persistent_data_link_path <category_id>: prints the managed link path of a category
# Returns: 1 also for a category with no managed link.
persistent_data_link_path() {
	local category_id="$1" home_link home_root

	home_link=$(provisioning_fields all "$category_id" homeLink) || return 1
	[[ -n "$home_link" ]] || return 1
	home_root="${PERSISTENT_DATA_HOME:-$_PERSISTENT_DATA_HOME}"
	printf '%s/%s\n' "$home_root" "$home_link"
}

# persistent_data_link_state <category_id>: prints the state of a category's managed link without touching it: none, ok, missing, foreign or unmanaged
# Notes: the read-only counterpart of persistent_data_link_standard_path, deciding the
#   same cases. ok points at the category directory, foreign is a symlink elsewhere,
#   unmanaged is a file or directory at the link path; an empty directory counts as
#   unmanaged, since only persistent_data_link_standard_path may replace one. The
#   category path is resolved first because persistent_data_link_path fails both for
#   an unknown category and for one with no managed link.
persistent_data_link_state() {
	local category_id="$1" destination source_path current_target

	source_path="$(persistent_data_category_path "$category_id")" || return 1
	destination="$(persistent_data_link_path "$category_id")" || {
		printf '%s\n' 'none'
		return 0
	}

	if [[ -L "$destination" ]]; then
		current_target="$(readlink "$destination")"
		if [[ "$current_target" == "$source_path" ]]; then
			printf '%s\n' 'ok'
		else
			printf '%s\n' 'foreign'
		fi
		return 0
	fi
	if [[ -e "$destination" ]]; then
		printf '%s\n' 'unmanaged'
		return 0
	fi
	printf '%s\n' 'missing'
}

# persistent_data_link_standard_path <destination> <category_id>: links destination to the category directory, replacing only an empty directory and refusing a foreign symlink or unmanaged data
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

# persistent_data_link_ensure <category_id>: ensures the managed link of a category, succeeding without action for a category that has none
persistent_data_link_ensure() {
	local category_id="$1" destination

	provisioning_entry all "$category_id" >/dev/null || return 1
	destination="$(persistent_data_link_path "$category_id")" || return 0
	persistent_data_link_standard_path "$destination" "$category_id"
}

export -f persistent_data_link_path persistent_data_link_state \
	persistent_data_link_standard_path persistent_data_link_ensure
