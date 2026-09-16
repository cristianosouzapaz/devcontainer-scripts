#!/bin/bash

[[ -n "${_PERSISTENT_DATA_PATHS_SH_LOADED:-}" ]] && return 0
readonly _PERSISTENT_DATA_PATHS_SH_LOADED=1

# Resolves persistent-data scope roots and category paths from the provisioning document.

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_PERSISTENT_DATA_SHARED_ROOT="${PERSISTENT_DATA_SHARED_ROOT:-/var/lib/devcontainer}"
_PERSISTENT_DATA_PROJECT_ROOT="${PERSISTENT_DATA_PROJECT_ROOT:-/workspace}"

# ----- FUNCTIONS --------------------------------------------------------------

# persistent_data_root <shared|project>: prints the root directory of a persistent-data scope
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

# persistent_data_category_path <category_id>: prints the absolute path of a registered category
persistent_data_category_path() {
	local category_id="$1" fields scope relative_path root

	fields=$(provisioning_fields all "$category_id" scope relativePath) || return 1
	IFS=$'\x1f' read -r scope relative_path <<<"$fields"
	root=$(persistent_data_root "$scope") || return 1
	printf '%s/%s\n' "$root" "$relative_path"
}

export -f persistent_data_root persistent_data_category_path
