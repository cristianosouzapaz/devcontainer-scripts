# shellcheck shell=bash
[[ -n "${_EDITOR_SH_LOADED:-}" ]] && return 0
readonly _EDITOR_SH_LOADED=1

# Live editor connection resolver shared by bin/devcontainer-editor and bin/devcontainer-browser.
# An editor's integrated terminal inherits the IPC socket of one window connection and a CLI under
# the server's commit dir; a process that outlives a reconnect or an update keeps both, dead. These
# helpers resolve a live socket and the newest CLI at every call instead. Each editor is described
# by one JSON manifest in the editors dir beside this file (id, serverRoots, socketVariable, socketGlob, cli,
# openUrlArgument), so adding an editor adds a file and no code. DEVCONTAINER_EDITOR_MANIFEST_DIR
# overrides that dir, only so the tests can point it at fixture editors.

# ----- HELPER FUNCTIONS -------------------------------------------------------

# editor_manifest_dir: prints the directory holding one manifest per editor
# Stdout: the manifest directory path, one line
editor_manifest_dir() {
	printf '%s\n' "${DEVCONTAINER_EDITOR_MANIFEST_DIR:-${DEVCONTAINER_LIB_DIR}/editors}"
}

# editor_ids: prints the id of every editor that has a manifest, sorted
# Stdout: one editor id per line
# Returns: 3 with an error naming the file when a manifest is not JSON with a string id
editor_ids() {
	local dir file id
	local -a ids=()
	dir=$(editor_manifest_dir)
	for file in "$dir"/*.json; do
		[[ -e "$file" ]] || continue
		if ! id=$(jq -er '.id | strings' "$file" 2>/dev/null); then
			log_error "Malformed editor manifest: $file"
			return 3
		fi
		ids+=("$id")
	done
	[[ ${#ids[@]} -gt 0 ]] || return 0
	printf '%s\n' "${ids[@]}" | sort
}

# editor_field <id> <field>: prints a field of an editor's manifest, one line per array element
# Stdout: the field value, one line per element, or nothing when the editor or field is absent
editor_field() {
	local dir file
	dir=$(editor_manifest_dir)
	for file in "$dir"/*.json; do
		jq -r --arg id "$1" --arg field "$2" 'select(.id == $id) | .[$field] // empty | if type == "array" then .[] else . end' "$file" 2>/dev/null
	done
}

# editor_socket_is_live <path>: succeeds when the Unix socket accepts a connection within a second
editor_socket_is_live() {
	[[ -S "$1" ]] || return 1
	python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.settimeout(1); s.connect(sys.argv[1])' "$1" 2>/dev/null
}

# editor_newest_cli <id>: prints the most recently modified CLI of the editor under its server roots
# Stdout: the CLI path, one line, or nothing when none is found
editor_newest_cli() {
	local cli root
	local -a roots=()
	cli=$(editor_field "$1" cli)
	[[ -n "$cli" ]] || return 0
	while IFS= read -r root; do
		roots+=("${root/#\~/$HOME}")
	done < <(editor_field "$1" serverRoots)
	[[ ${#roots[@]} -gt 0 ]] || return 0
	find "${roots[@]}" -path "*/$cli" -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n1 | cut -d' ' -f2-
}

# editor_sockets <id...>: prints every socket file matching the editors' globs, newest first
# Stdout: one "<id><TAB><socket>" line per socket
editor_sockets() {
	local id glob
	for id in "$@"; do
		glob=$(editor_field "$id" socketGlob)
		[[ -n "$glob" ]] || continue
		find "${glob%/*}" -maxdepth 1 -type s -name "${glob##*/}" -printf "%T@\t${id}\t%p\n" 2>/dev/null
	done | sort -rn | cut -f2-
}

# editor_search_places <id...>: describes where the resolver looks for the editors' sockets
# Stdout: one line listing each editor's socket variable and glob
editor_search_places() {
	local id
	local -a places=()
	for id in "$@"; do
		places+=("${id}: \$$(editor_field "$id" socketVariable) and $(editor_field "$id" socketGlob)")
	done
	printf '%s\n' "${places[*]}"
}

# editor_resolve <id...>: resolves a live connection among the editors, the inherited socket first, then the newest live one
# Stdout: one "skip<TAB><id><TAB><socket><TAB><reason>" line per candidate passed over, then
#   "use<TAB><id><TAB><socket><TAB><cli>" for the chosen one
# Returns: 0 when a live connection with a CLI is found, 1 otherwise
editor_resolve() {
	local id var sock
	local -a tried=()
	for id in "$@"; do
		var=$(editor_field "$id" socketVariable)
		sock="${var:+${!var:-}}"
		[[ -n "$sock" ]] || continue
		tried+=("$sock")
		editor_candidate "$id" "$sock" "inherited socket not live" && return 0
	done
	while IFS=$'\t' read -r id sock; do
		# why: an inherited socket was already judged above; reporting it twice would read as two candidates
		[[ " ${tried[*]} " == *" $sock "* ]] && continue
		editor_candidate "$id" "$sock" "not live" && return 0
	done < <(editor_sockets "$@")
	return 1
}

# editor_candidate <id> <socket> <dead_reason>: judges one socket of an editor as editor_resolve reports it
# Stdout: one "use" line when the socket is live and the editor has a CLI, else one "skip" line
# Returns: 0 for a "use" line, 1 for a "skip" line
editor_candidate() {
	local cli
	if ! editor_socket_is_live "$2"; then
		printf 'skip\t%s\t%s\t%s\n' "$1" "$2" "$3"
		return 1
	fi
	cli=$(editor_newest_cli "$1")
	if [[ -z "$cli" ]]; then
		printf 'skip\t%s\t%s\t%s\n' "$1" "$2" "no CLI under $(editor_field "$1" serverRoots | paste -sd' ')"
		return 1
	fi
	printf 'use\t%s\t%s\t%s\n' "$1" "$2" "$cli"
}

# editor_select <id>: prints the editors to resolve among: the given id, or every known editor when it is empty
# Stdout: one editor id per line
# Returns: 3 with an error when a manifest is malformed, there is none, or the id has none (naming the known editors)
editor_select() {
	local known
	known=$(editor_ids) || return
	if [[ -z "$known" ]]; then
		log_error "No editor manifest in $(editor_manifest_dir)"
		return 3
	fi
	if [[ -z "$1" ]]; then
		printf '%s\n' "$known"
		return 0
	fi
	if ! grep -qxF -- "$1" <<< "$known"; then
		log_error "Unknown editor '$1'; known editors: $(paste -sd' ' <<< "$known")"
		return 3
	fi
	printf '%s\n' "$1"
}

# editor_run <id> <extra_args_field> <arg...>: runs the editor CLI of a live connection with the arguments
# Returns: 3 when the id is unknown or no live editor is found, 4 when the CLI fails
# Notes: an empty id falls back to DEVCONTAINER_EDITOR, then to every known editor. extra_args_field
#   names a manifest field whose value goes before the arguments (such as openUrlArgument), or is empty.
editor_run() {
	local field="$2" selected resolved id sock cli
	local -a ids=() extra=()
	selected=$(editor_select "${1:-${DEVCONTAINER_EDITOR:-}}") || return
	shift 2
	mapfile -t ids <<< "$selected"
	if ! resolved=$(editor_resolve "${ids[@]}"); then
		log_error "No live editor connection; looked at $(editor_search_places "${ids[@]}")"
		return 3
	fi
	IFS=$'\t' read -r _ id sock cli < <(grep '^use' <<< "$resolved")
	if [[ -n "$field" ]]; then
		mapfile -t extra < <(editor_field "$id" "$field")
	fi
	if ! env "$(editor_field "$id" socketVariable)=$sock" "$cli" "${extra[@]}" "$@"; then
		log_error "The editor rejected the call: $cli $*"
		return 4
	fi
}
