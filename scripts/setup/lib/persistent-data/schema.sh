# shellcheck shell=bash
[[ -n "${_PERSISTENT_DATA_SCHEMA_SH_LOADED:-}" ]] && return 0
readonly _PERSISTENT_DATA_SCHEMA_SH_LOADED=1

# Schema version markers that tie each persistent-data root to the layout version
# recorded in the layout-version file beside this library, which image-bootstrap.sh also seeds into the image.

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_PERSISTENT_DATA_LAYOUT_VERSION_FILE="${PERSISTENT_DATA_LAYOUT_VERSION_FILE:-${DEVCONTAINER_LIB_DIR}/persistent-data/layout-version}"

# ----- FUNCTIONS --------------------------------------------------------------

# persistent_data_layout_version: prints the persistent-data layout version, failing when it is not a positive integer
# Stdout: the layout version, one line
persistent_data_layout_version() {
	local version=''

	[[ -r "$_PERSISTENT_DATA_LAYOUT_VERSION_FILE" ]] && version=$(<"$_PERSISTENT_DATA_LAYOUT_VERSION_FILE")
	if [[ ! "$version" =~ ^[1-9][0-9]*$ ]]; then
		log_error "Invalid persistent-data layout version in $_PERSISTENT_DATA_LAYOUT_VERSION_FILE"
		return 1
	fi
	printf '%s\n' "$version"
}

# persistent_data_schema_marker <shared|project>: prints the schema marker path of a scope
# Stdout: the marker file path, one line
persistent_data_schema_marker() {
	local root

	root=$(persistent_data_root "$1") || return 1
	if [[ "$1" == 'project' ]]; then
		printf '%s\n' "$root/.metadata/.schema-version"
	else
		printf '%s\n' "$root/.schema-version"
	fi
}

# persistent_data_schema_state <shared|project>: prints the compatibility state of a scope: empty, data, valid or invalid
# Stdout: the state word, one line
# Notes: empty holds nothing beyond the marker directory and lock file; data holds
#   content without a marker; valid and invalid carry a marker that does or does not
#   match the layout version.
persistent_data_schema_state() {
	local scope="$1" root marker marker_dir lock_file entries version

	root=$(persistent_data_root "$scope") || return 1
	marker=$(persistent_data_schema_marker "$scope") || return 1
	marker_dir=$(dirname "$marker")
	lock_file=$(persistent_data_lock_path "$scope") || return 1
	if [[ -f "$marker" ]]; then
		version=$(persistent_data_layout_version) || return 1
		if cmp -s <(printf '%s\n' "$version") "$marker"; then
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

# persistent_data_schema_initialize <shared|project>: writes the layout marker into an empty scope, failing when the scope holds unmarked data or a mismatched marker
persistent_data_schema_initialize() {
	local scope="$1" state marker marker_dir version

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
	version=$(persistent_data_layout_version) || return 1
	atomic_write "$marker" printf '%s\n' "$version"
}

export -f persistent_data_layout_version persistent_data_schema_marker persistent_data_schema_state persistent_data_schema_initialize
