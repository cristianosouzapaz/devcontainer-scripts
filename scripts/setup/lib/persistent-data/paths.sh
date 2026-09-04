#!/bin/bash

[[ -n "${_PERSISTENT_DATA_PATHS_SH_LOADED:-}" ]] && return 0
readonly _PERSISTENT_DATA_PATHS_SH_LOADED=1

# Paths resolved from the persistent-data registry.

_PERSISTENT_DATA_SHARED_ROOT="${PERSISTENT_DATA_SHARED_ROOT:-/var/lib/devcontainer}"
_PERSISTENT_DATA_PROJECT_ROOT="${PERSISTENT_DATA_PROJECT_ROOT:-/workspace}"

# persistent_data_root: Prints the root for a persistent-data scope.
# Args: shared or project.
# Returns: 0 when recognized, 1 otherwise.
persistent_data_root() {
	case "$1" in
	shared) printf '%s\n' "$_PERSISTENT_DATA_SHARED_ROOT" ;;
	project) printf '%s\n' "$_PERSISTENT_DATA_PROJECT_ROOT" ;;
	*)
		log_error "Unknown persistent-data scope: $1"
		return 1
		;;
	esac
}

# persistent_data_category_path: Prints the absolute path for a registered category.
# Args: category id.
# Returns: 0 when found, 1 otherwise.
persistent_data_category_path() {
	local category_id="$1" category scope relative_path root

	category=$(persistent_data_category "$category_id") || return 1
	scope=$(jq -r '.scope' <<<"$category")
	relative_path=$(jq -r '.relativePath' <<<"$category")
	root=$(persistent_data_root "$scope") || return 1
	printf '%s/%s\n' "$root" "$relative_path"
}

export -f persistent_data_root persistent_data_category_path
