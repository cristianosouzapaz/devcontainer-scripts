#!/bin/bash

[[ -n "${_PERSISTENT_DATA_LOCKS_SH_LOADED:-}" ]] && return 0
readonly _PERSISTENT_DATA_LOCKS_SH_LOADED=1

# Bounded flock locks that serialize structural changes to persistent data, taken shared before project.

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_PERSISTENT_DATA_LOCK_TIMEOUT="${PERSISTENT_DATA_LOCK_TIMEOUT:-30}"

# why: tracks the scopes this shell holds, to enforce the shared-before-project order
_PERSISTENT_DATA_LOCKS_HELD=''

# ----- FUNCTIONS --------------------------------------------------------------

# persistent_data_lock_path <shared|project>: prints the lock file path of a scope
persistent_data_lock_path() {
	local root

	root=$(persistent_data_root "$1") || return 1
	printf '%s\n' "$root/.persistent-data.lock"
}

# with_persistent_data_lock <shared|project> <command...>: runs the command while holding the scope's lock, waiting at most _PERSISTENT_DATA_LOCK_TIMEOUT seconds
# Returns: the command's status, or 1 when the lock cannot be acquired or the shared
#   lock is requested while the project lock is held.
# Notes: the command runs bare and its status is read on the next line: under live
#   errexit a failure stops the process, and the fd closing on exit releases the
#   lock; under a caller's if or ||, errexit is off, so the status is captured and
#   the lock and the held-scope list are still restored.
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
	"$@"
	command_status=$?
	_PERSISTENT_DATA_LOCKS_HELD="$locks_held_before"
	flock -u "$lock_fd"
	exec {lock_fd}>&-
	return "$command_status"
}

# with_shared_data_lock <command...>: runs the command while holding the shared-data lock
with_shared_data_lock() {
	with_persistent_data_lock shared "$@"
}

# with_project_data_lock <command...>: runs the command while holding the project-data lock
with_project_data_lock() {
	with_persistent_data_lock project "$@"
}

export -f persistent_data_lock_path with_persistent_data_lock with_shared_data_lock with_project_data_lock
