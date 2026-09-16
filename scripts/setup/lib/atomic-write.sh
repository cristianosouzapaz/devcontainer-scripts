#!/bin/bash

[[ -n "${_ATOMIC_WRITE_SH_LOADED:-}" ]] && return 0
readonly _ATOMIC_WRITE_SH_LOADED=1

# Whole-file writes that a reader sees either as they were or as they end up,
# never half-written. Setup trusts a file's presence or content on the next run
# (an existing config is kept, a schema marker is compared), so a file truncated
# by a failed or interrupted write would otherwise be taken as done forever.

# ----- FUNCTIONS --------------------------------------------------------------

# atomic_write: Replaces a file with a command's standard output, in one rename.
# Usage: atomic_write <target> <command...>
# The temp file is created next to the target (resolved through a symlink, so the
# link survives): the targets live on persistent-data volumes, where a mv from
# /tmp would be a copy, not a rename. An existing target keeps its mode; a new one
# gets the mode a plain redirect would give it. Anything but a regular file (a
# device, a FIFO, a directory) is refused, never replaced. The command runs in a
# condition, so its own status decides, not errexit inside it.
# Returns: 0 on success; the command's status, or 1 for a refused target, a
# temp-file or a rename failure — the target is then untouched and no temp file
# is left behind.
atomic_write() {
	local target tmp_file rc=0

	target=$(readlink -m -- "$1") || return 1
	shift
	if [[ -e "$target" && ! -f "$target" ]]; then
		log_error "Not a regular file, refusing to replace it: $target"
		return 1
	fi
	tmp_file=$(mktemp "${target}.XXXXXX") || return 1
	"$@" >"$tmp_file" || rc=$?
	if [[ "$rc" -eq 0 ]]; then
		if [[ -e "$target" ]]; then
			chmod --reference="$target" -- "$tmp_file" || rc=1
		else
			chmod "$(printf '%o' $(( 0666 & ~0$(umask) )))" -- "$tmp_file" || rc=1
		fi
	fi
	if [[ "$rc" -eq 0 ]]; then
		mv -f -- "$tmp_file" "$target" || rc=1
	fi
	if [[ "$rc" -ne 0 ]]; then
		rm -f -- "$tmp_file"
		return "$rc"
	fi
}

export -f atomic_write
