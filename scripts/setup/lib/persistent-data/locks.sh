#!/bin/bash

[[ -n "${_PERSISTENT_DATA_LOCKS_SH_LOADED:-}" ]] && return 0
readonly _PERSISTENT_DATA_LOCKS_SH_LOADED=1

# Bounded locks for persistent-data structural changes.

_PERSISTENT_DATA_LOCK_TIMEOUT="${PERSISTENT_DATA_LOCK_TIMEOUT:-30}"

# Space-padded list of scopes currently held by this shell, to enforce acquisition order.
_PERSISTENT_DATA_LOCKS_HELD=''

# persistent_data_lock_path: Prints the lock-file path for a scope.
# Args: shared or project.
# Returns: 0 when recognized, 1 otherwise.
persistent_data_lock_path() {
	local root

	root=$(persistent_data_root "$1") || return 1
	printf '%s\n' "$root/.persistent-data.lock"
}

# with_persistent_data_lock: Runs a command while holding the scope's bounded lock.
# Args: scope, command and its arguments.
# Returns: wrapped command status, or 1 when the lock cannot be acquired.
with_persistent_data_lock() {
	local scope="$1" lock_file lock_dir lock_fd command_status=0 locks_held_before
	shift || true
	if [[ "$#" -eq 0 ]]; then
		log_error 'Persistent-data lock requires a command'
		return 1
	fi
	if [[ "$scope" == 'shared' && " $_PERSISTENT_DATA_LOCKS_HELD " == *' project '* ]]; then
		log_error 'Persistent-data shared lock must be acquired before the project lock'
		return 1
	fi
	if ! command -v flock >/dev/null 2>&1; then
		log_error 'Persistent-data locks require flock'
		return 1
	fi
	lock_file=$(persistent_data_lock_path "$scope") || return 1
	lock_dir=$(dirname "$lock_file")
	mkdir -p "$lock_dir" || return 1
	exec {lock_fd}>"$lock_file"
	if ! flock -w "$_PERSISTENT_DATA_LOCK_TIMEOUT" "$lock_fd"; then
		exec {lock_fd}>&-
		log_error "Timed out waiting for persistent-data $scope lock"
		return 1
	fi
	locks_held_before="$_PERSISTENT_DATA_LOCKS_HELD"
	_PERSISTENT_DATA_LOCKS_HELD="$_PERSISTENT_DATA_LOCKS_HELD $scope"
	"$@" || command_status=$?
	_PERSISTENT_DATA_LOCKS_HELD="$locks_held_before"
	flock -u "$lock_fd"
	exec {lock_fd}>&-
	return "$command_status"
}

# with_shared_data_lock: Runs a command while holding the shared-data lock.
# Args: command and its arguments.
# Returns: wrapped command status, or 1 when the lock cannot be acquired.
with_shared_data_lock() {
	with_persistent_data_lock shared "$@"
}

# with_project_data_lock: Runs a command while holding the project-data lock.
# Args: command and its arguments.
# Returns: wrapped command status, or 1 when the lock cannot be acquired.
with_project_data_lock() {
	with_persistent_data_lock project "$@"
}

export -f persistent_data_lock_path with_persistent_data_lock with_shared_data_lock with_project_data_lock
