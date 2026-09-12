#!/bin/bash

[[ -n "${_PERSISTENT_DATA_LINKS_SH_LOADED:-}" ]] && return 0
readonly _PERSISTENT_DATA_LINKS_SH_LOADED=1

# Managed home-directory links for persistent-data categories.
#
# Some registered categories are reached through a fixed path in the home
# directory because the tool that owns them has no way to be pointed at the
# volume. Those paths live in the registry rather than in the setup module
# because both the setup orchestrator and bin/devcontainer-data need them: the
# orchestrator creates the links, the CLI verifies and repairs them.
#
# A category with homeLink null or no homeLink is reached through its own
# configuration and has no managed link at all.

# Test seam — not readonly so tests can avoid the real home directory.
_PERSISTENT_DATA_HOME="${PERSISTENT_DATA_HOME:-/root}"

# persistent_data_link_path <category_id>: Prints the managed link path of a category.
# Returns: 0 and the path for a linked category, 1 for one with no managed link.
persistent_data_link_path() {
	local category_id="$1" category home_link home_root

	category=$(persistent_data_category "$category_id") || return 1
	home_link=$(jq -r '.homeLink // empty' <<<"$category") || return 1
	[[ -n "$home_link" ]] || return 1
	home_root="${PERSISTENT_DATA_HOME:-$_PERSISTENT_DATA_HOME}"
	printf '%s/%s\n' "$home_root" "$home_link"
}

# persistent_data_link_state <category_id>: Reports the state of a managed link
# without touching it. The read-only counterpart of
# persistent_data_link_standard_path, which decides the same cases in order to act.
# Prints one of:
#   none      - the category has no managed link
#   ok        - the link exists and points at the category directory
#   missing   - nothing exists at the link path
#   foreign   - a symlink pointing somewhere other than the category directory
#   unmanaged - a file or a non-empty directory sits at the link path
# Returns: 0 when a state was determined, 1 when the category is unknown.
persistent_data_link_state() {
	local category_id="$1" destination source_path current_target

	destination="$(persistent_data_link_path "$category_id")" || {
		printf '%s\n' 'none'
		return 0
	}
	source_path="$(persistent_data_category_path "$category_id")" || return 1

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
		# An empty directory counts as unmanaged here; only
		# persistent_data_link_standard_path may replace one, and it says so.
		printf '%s\n' 'unmanaged'
		return 0
	fi
	printf '%s\n' 'missing'
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

# persistent_data_link_ensure <category_id>: Ensures the managed link of one
# category, and succeeds silently for a category that has none.
# Returns: 0 when the link is in place, 1 when it cannot be created.
persistent_data_link_ensure() {
	local category_id="$1" destination

	destination="$(persistent_data_link_path "$category_id")" || return 0
	persistent_data_link_standard_path "$destination" "$category_id"
}

export -f persistent_data_link_path persistent_data_link_state \
	persistent_data_link_standard_path persistent_data_link_ensure
