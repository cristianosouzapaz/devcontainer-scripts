#!/bin/bash

[[ -n "${_PERSISTENT_DATA_COPY_SH_LOADED:-}" ]] && return 0
readonly _PERSISTENT_DATA_COPY_SH_LOADED=1

# Verified filesystem copy support for persistent-data migration.

# persistent_data_copy_verified: Copies a directory tree and verifies its resulting content.
# Args: source directory, destination directory.
# Returns: 0 when the trees match, 1 otherwise.
persistent_data_copy_verified() {
	local source="$1" destination="$2" source_real destination_real diff_output diff_line

	if [[ ! -d "$source" ]]; then
		log_error "Persistent-data copy source is not a directory: $source"
		return 1
	fi
	source_real=$(cd "$source" && pwd -P)
	destination_real=$(realpath -m "$destination") || return 1
	if [[ "$destination_real" == "$source_real" || "$destination_real" == "$source_real/"* ]]; then
		log_error 'Persistent-data copy destination must not be inside its source'
		return 1
	fi
	mkdir -p "$destination" || return 1
	find "$source" -mindepth 1 -maxdepth 1 ! -path "$source/.persistent-data.lock" -exec cp -a -- {} "$destination/" \; || return 1
	diff_output=$(diff -qr --no-dereference "$source" "$destination" 2>&1) || true
	while IFS= read -r diff_line; do
		[[ -z "$diff_line" || "$diff_line" == "Only in $source: .persistent-data.lock" || "$diff_line" == "Only in $destination: .persistent-data.lock" ]] && continue
		log_error 'Persistent-data copy verification failed'
		return 1
	done <<<"$diff_output"
	return 0
}

export -f persistent_data_copy_verified
