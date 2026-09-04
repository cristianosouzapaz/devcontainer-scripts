#!/bin/bash

[[ -n "${_PERSISTENT_DATA_SCHEMA_SH_LOADED:-}" ]] && return 0
readonly _PERSISTENT_DATA_SCHEMA_SH_LOADED=1

# Schema markers for persistent-data roots.

_PERSISTENT_DATA_SCHEMA_VERSION=1

# persistent_data_schema_marker: Prints the schema marker for a scope.
# Args: shared or project.
# Returns: 0 when recognized, 1 otherwise.
persistent_data_schema_marker() {
	local root

	root=$(persistent_data_root "$1") || return 1
	if [[ "$1" == 'project' ]]; then
		printf '%s\n' "$root/.metadata/.schema-version"
	else
		printf '%s\n' "$root/.schema-version"
	fi
}

# persistent_data_schema_state: Prints the compatibility state of a persistent-data scope.
# Args: shared or project.
# Returns: 0 and one of empty, data, valid, or invalid; 1 for an unknown scope.
persistent_data_schema_state() {
	local scope="$1" root marker marker_dir lock_file entries

	root=$(persistent_data_root "$scope") || return 1
	marker=$(persistent_data_schema_marker "$scope") || return 1
	marker_dir=$(dirname "$marker")
	lock_file=$(persistent_data_lock_path "$scope") || return 1
	if [[ -f "$marker" ]]; then
		if cmp -s <(printf '%s\n' "$_PERSISTENT_DATA_SCHEMA_VERSION") "$marker"; then
			printf '%s\n' 'valid'
		else
			printf '%s\n' 'invalid'
		fi
		return 0
	fi
	entries=''
	if [[ -d "$root" ]]; then
		entries=$(find "$root" -mindepth 1 ! -path "$marker" ! -path "$marker_dir" ! -path "$lock_file" -print -quit)
	fi
	if [[ -n "$entries" ]]; then
		printf '%s\n' 'data'
	else
		printf '%s\n' 'empty'
	fi
}

# persistent_data_schema_initialize: Initializes an empty scope or verifies its marker.
# Args: shared or project.
# Returns: 0 when compatible, 1 when the area holds unrecognized data or an invalid marker.
persistent_data_schema_initialize() {
	local scope="$1" state marker marker_dir

	state=$(persistent_data_schema_state "$scope") || return 1
	case "$state" in
	valid) return 0 ;;
	invalid)
		log_error "Unsupported persistent-data $scope schema marker"
		return 1
		;;
	data)
		log_error "Persistent-data $scope area holds an unrecognized layout; recreate the volume or restore it from a backup"
		return 1
		;;
	esac
	marker=$(persistent_data_schema_marker "$scope") || return 1
	marker_dir=$(dirname "$marker")
	mkdir -p "$marker_dir" || return 1
	printf '%s\n' "$_PERSISTENT_DATA_SCHEMA_VERSION" >"$marker"
}

export -f persistent_data_schema_marker persistent_data_schema_state persistent_data_schema_initialize
