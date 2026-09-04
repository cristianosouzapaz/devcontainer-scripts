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

# persistent_data_schema_mark_migrated: Atomically records the version after a verified migration.
# Args: shared or project.
# Returns: 0 when the marker is valid or has been written, 1 for an invalid marker.
persistent_data_schema_mark_migrated() {
	local scope="$1" marker marker_dir marker_tmp state

	state=$(persistent_data_schema_state "$scope") || return 1
	if [[ "$state" == 'valid' ]]; then
		return 0
	fi
	if [[ "$state" == 'invalid' ]]; then
		log_error "Unsupported persistent-data $scope schema marker"
		return 1
	fi
	marker=$(persistent_data_schema_marker "$scope") || return 1
	marker_dir=$(dirname "$marker")
	mkdir -p "$marker_dir" || return 1
	marker_tmp=$(mktemp "$marker_dir/.schema-version.XXXXXX") || return 1
	printf '%s\n' "$_PERSISTENT_DATA_SCHEMA_VERSION" >"$marker_tmp" || return 1
	mv -f "$marker_tmp" "$marker"
}

# persistent_data_schema_initialize: Initializes an empty scope or verifies its marker.
# Args: shared or project.
# Returns: 0 when compatible, 1 when migration is required or the marker is invalid.
persistent_data_schema_initialize() {
	local scope="$1" root marker marker_dir lock_file entries

	root=$(persistent_data_root "$scope") || return 1
	marker=$(persistent_data_schema_marker "$scope") || return 1
	marker_dir=$(dirname "$marker")
	lock_file=$(persistent_data_lock_path "$scope") || return 1
	if [[ -f "$marker" ]]; then
		if cmp -s <(printf '%s\n' "$_PERSISTENT_DATA_SCHEMA_VERSION") "$marker"; then
			return 0
		fi
		log_error "Unsupported persistent-data $scope schema marker"
		return 1
	fi

	if [[ -d "$root" ]]; then
		entries=$(find "$root" -mindepth 1 ! -path "$marker" ! -path "$marker_dir" ! -path "$lock_file" -print -quit)
		if [[ -n "$entries" ]]; then
			log_error "Persistent-data $scope area has data without a schema marker; migrate it manually"
			return 1
		fi
	fi
	mkdir -p "$marker_dir" || return 1
	printf '%s\n' "$_PERSISTENT_DATA_SCHEMA_VERSION" >"$marker"
}

export -f persistent_data_schema_marker persistent_data_schema_state persistent_data_schema_mark_migrated persistent_data_schema_initialize
