#!/bin/bash

[[ -n "${_VOLUMES_SUMMARY_SH_LOADED:-}" ]] && return 0
readonly _VOLUMES_SUMMARY_SH_LOADED=1

# Volumes summary - Prints the mount status of the container's named volumes,
# split into two independently-logged groups.
#
# Provides two public functions:
#   print_volumes_summary      - Logs, for the Claude Code, Codex CLI, and
#                                 GitHub CLI auth volumes, whether each is
#                                 mounted and whether the tool is actually
#                                 authenticated (not just whether credential
#                                 files are present). Auth data comes from each
#                                 tool's own status command, never by parsing
#                                 credential files directly.
#   print_data_volumes_summary - Logs every *other* named volume mounted on the
#                                 container (workspace source, the shared
#                                 agent-assets store, anything the user added in
#                                 docker-compose.yml) with its destination path
#                                 and, when the name is recognised, a friendly
#                                 label.
#
# Both read mount data from `docker inspect` against the container's own ID
# (read from /etc/hostname) and silently do nothing without Docker access.

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_HOSTNAME_PATH="${_HOSTNAME_PATH:-/etc/hostname}"

declare -gA _VOLUMES_OF_INTEREST=(
	[claude-auth-data]="Claude Code"
	[codex-auth-data]="Codex CLI"
	[gh-cli-auth-data]="GitHub CLI"
)

declare -gA _VOLUMES_LOGIN_HINT=(
	[claude-auth-data]="claude auth login"
	[codex-auth-data]="codex login"
	[gh-cli-auth-data]="gh auth login"
)

declare -gA _VOLUMES_BINARY=(
	[claude-auth-data]="claude"
	[codex-auth-data]="codex"
	[gh-cli-auth-data]="gh"
)

# Alphabetical iteration order — associative-array key order is hash-dependent,
# and every place volumes are listed (docker-compose.yml, devcontainer.json
# mounts) is kept sorted. Keep this list sorted when adding a volume.
declare -ga _VOLUMES_ORDER=(
	claude-auth-data
	codex-auth-data
	gh-cli-auth-data
)

# Friendly labels for the "Data volumes" group, keyed by exact volume name. The
# per-project workspace volumes are matched separately (see data_volume_label)
# because their names embed the project slug. A mounted volume that matches
# neither is still listed, with a "-" in the detail column. Auth volumes never
# reach this lookup.
declare -gA _DATA_VOLUME_LABELS=(
	[agents-data]="global agent assets"
)

# ----- INTERNAL HELPERS -------------------------------------------------------

# Print "<volume-name>|<destination>" for every named volume mounted on the
# current container, or nothing if docker/the socket is unavailable.
volumes_summary_list_mounts() {
	local container_id

	command -v docker >/dev/null 2>&1 || return 0
	[[ -f "$_HOSTNAME_PATH" ]] || return 0
	container_id="$(<"$_HOSTNAME_PATH")"

	docker inspect "$container_id" \
		--format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}|{{.Destination}}
{{end}}{{end}}' 2>/dev/null || true
}

# volumes_summary_claude_identity: echoes the authenticated account's email
# via `claude auth status` (never by reading .credentials.json directly).
# Returns: 0 and prints the email if authenticated, 1 otherwise.
volumes_summary_claude_identity() {
	local output
	command -v claude >/dev/null 2>&1 || return 1
	output="$(claude auth status --text 2>/dev/null)" || return 1
	sed -n 's/^Email: //p' <<<"$output"
}

# volumes_summary_codex_identity: Confirms Codex has an active stored login
# via `codex login status`. The CLI does not expose a stable account identifier,
# so this deliberately returns a neutral description rather than parsing output.
# Returns: 0 and prints a status description if authenticated, 1 otherwise.
volumes_summary_codex_identity() {
	command -v codex >/dev/null 2>&1 || return 1
	codex login status > /dev/null 2>&1 || return 1
	printf '%s\n' "active session"
}

# volumes_summary_gh_identity: echoes the authenticated account name via
# `gh auth status` (never by reading hosts.yml directly).
# Returns: 0 and prints the account name if authenticated, 1 otherwise.
volumes_summary_gh_identity() {
	local output
	command -v gh >/dev/null 2>&1 || return 1
	output="$(gh auth status 2>&1)" || return 1
	sed -n 's/.*Logged in to [^ ]* account \([^ ]*\).*/\1/p' <<<"$output" | head -1
}

# volumes_summary_identity <volume_name>: dispatches to the tool-specific
# identity check for the given volume name.
# Returns: 0 and prints the identity if authenticated, 1 otherwise.
volumes_summary_identity() {
	local name="$1"
	case "$name" in
	claude-auth-data) volumes_summary_claude_identity ;;
	codex-auth-data) volumes_summary_codex_identity ;;
	gh-cli-auth-data) volumes_summary_gh_identity ;;
	*) return 1 ;;
	esac
}

# data_volume_label <volume_name>: echoes a friendly description for a data
# volume. An exact match in _DATA_VOLUME_LABELS wins; otherwise the two
# per-project volumes named by project-init.ps1 — "<PROJECT_NAME>-workspace"
# (docker-compose.yml) and "<PROJECT_NAME>-data" (the devcontainer.json
# workspaceMount) — are recognised via PROJECT_NAME. Prints nothing (still
# returns 0) for anything else; the caller renders that as a "-".
data_volume_label() {
	local name="$1"
	if [[ -n "${_DATA_VOLUME_LABELS[$name]:-}" ]]; then
		printf '%s\n' "${_DATA_VOLUME_LABELS[$name]}"
		return 0
	fi
	if [[ -n "${PROJECT_NAME:-}" ]] &&
		{ [[ "$name" == "${PROJECT_NAME}-workspace" ]] || [[ "$name" == "${PROJECT_NAME}-data" ]]; }; then
		printf '%s\n' "workspace source"
		return 0
	fi
	return 0
}

# ----- PUBLIC FUNCTIONS -------------------------------------------------------

# print_volumes_summary: Logs the mount and auth status of the Claude Code,
# Codex CLI, and GitHub CLI auth volumes as a group — one primary
# line announcing the count, followed by one status-carrying line per volume
# (indented, each with its own success/warning symbol since each row is its own
# conclusion).
# In plain-text mode a column header and aligned columns are shown; in
# STRUCTURED_LOGS mode the header is omitted and each row is a clean sentence
# instead, so JSON output never carries terminal-only alignment padding.
# Silently does nothing if docker or the container's own inspect data isn't
# available (e.g. Docker feature disabled). A volume's row is skipped
# entirely — not shown as "not mounted" — when its CLI binary isn't
# installed. This keeps optional tools that were not selected out of the
# summary and avoids reporting a misleading mount status when a CLI is
# unavailable.
# Args: none
# Returns: 0 always
print_volumes_summary() {
	local mounts line name destination label identity hint binary
	local col_tool=4 col_volume=6 col_mount=5
	local -a row_names=() row_labels=() row_mounts=() row_ok=() row_details=()
	local i header row mount_val ok_val detail_val

	mounts="$(volumes_summary_list_mounts)"
	if [[ -z "$mounts" ]]; then
		log_debug "Skipping volumes summary — docker unavailable"
		return 0
	fi

	for name in "${_VOLUMES_ORDER[@]}"; do
		binary="${_VOLUMES_BINARY[$name]}"
		command -v "$binary" >/dev/null 2>&1 || continue

		label="${_VOLUMES_OF_INTEREST[$name]}"
		hint="${_VOLUMES_LOGIN_HINT[$name]}"
		destination=""
		while IFS='|' read -r line destination; do
			[[ "$line" == "$name" ]] && break
			destination=""
		done <<<"$mounts"

		if [[ -z "$destination" ]]; then
			mount_val="-"; ok_val="false"; detail_val="not mounted"
		elif identity="$(volumes_summary_identity "$name")" && [[ -n "$identity" ]]; then
			mount_val="$destination"; ok_val="true"; detail_val="authenticated (${identity})"
		else
			mount_val="$destination"; ok_val="false"; detail_val="not authenticated, run: ${hint}"
		fi
		row_names+=("$name"); row_labels+=("$label")
		row_mounts+=("$mount_val"); row_ok+=("$ok_val"); row_details+=("$detail_val")

		((${#label} > col_tool)) && col_tool=${#label}
		((${#name} > col_volume)) && col_volume=${#name}
		((${#destination} > col_mount)) && col_mount=${#destination}
	done

	((${#row_names[@]} == 0)) && return 0

	log_info "Auth volumes: ${#row_names[@]}"

	if [[ "$STRUCTURED_LOGS" != "true" ]]; then
		printf -v header '%-*s  %-*s  %-*s  %s' "$col_tool" "TOOL" "$col_volume" "VOLUME" "$col_mount" "MOUNT" "STATUS"
		# 3 leading spaces, not 2: the "detail" style's tree-bar prefix renders one
		# column narrower than the "item" style's tree-bar + symbol prefix used for
		# the rows below, so the header needs the extra space to line up under them.
		log_detail "   ${header}"
	fi

	for i in "${!row_names[@]}"; do
		if [[ "$STRUCTURED_LOGS" == "true" ]]; then
			if [[ "${row_mounts[$i]}" == "-" ]]; then
				row="${row_labels[$i]} (${row_names[$i]}) — ${row_details[$i]}"
			else
				row="${row_labels[$i]} (${row_names[$i]}) -> ${row_mounts[$i]} — ${row_details[$i]}"
			fi
		else
			printf -v row '%-*s  %-*s  %-*s  %s' "$col_tool" "${row_labels[$i]}" "$col_volume" "${row_names[$i]}" "$col_mount" "${row_mounts[$i]}" "${row_details[$i]}"
		fi
		if [[ "${row_ok[$i]}" == "true" ]]; then
			log_item_success "$row"
		else
			log_item_warning "$row"
		fi
	done

	return 0
}

# print_data_volumes_summary: Logs every named volume mounted on the container
# that is NOT one of the auth volumes handled by print_volumes_summary —
# workspace source, the shared agent-assets store, and anything the user added
# to docker-compose.yml. Renders as its own tree group: one primary line with
# the count, then one line per volume ("<name>  <mount>  <label>"), each a
# conclusion of its own (always a success symbol — the volume is mounted).
# Recognised names get a friendly label from data_volume_label; the rest show a
# "-". In STRUCTURED_LOGS mode the column header is dropped and each row becomes
# a clean sentence. Silently does nothing without Docker access, or when no
# non-auth volume is mounted.
# Args: none
# Returns: 0 always
print_data_volumes_summary() {
	local mounts sorted name destination label header row i
	local col_volume=6 col_mount=5
	local -a row_names=() row_mounts=() row_labels=()

	mounts="$(volumes_summary_list_mounts)"
	if [[ -z "$mounts" ]]; then
		log_debug "Skipping data volumes summary — docker unavailable"
		return 0
	fi

	# `docker inspect` mount order is not stable — sort by name so the group
	# reads identically across runs, matching print_volumes_summary's explicit
	# ordering. Auth-volume and blank lines are skipped in the loop below.
	sorted="$(sort <<<"$mounts")"

	while IFS='|' read -r name destination; do
		[[ -n "$name" ]] || continue
		# Auth volumes have their own summary — never list them here.
		[[ -n "${_VOLUMES_OF_INTEREST[$name]:-}" ]] && continue

		label="$(data_volume_label "$name")"
		row_names+=("$name"); row_mounts+=("$destination"); row_labels+=("$label")

		((${#name} > col_volume)) && col_volume=${#name}
		((${#destination} > col_mount)) && col_mount=${#destination}
	done <<<"$sorted"

	((${#row_names[@]} == 0)) && return 0

	log_info "Data volumes: ${#row_names[@]}"

	if [[ "$STRUCTURED_LOGS" != "true" ]]; then
		printf -v header '%-*s  %-*s  %s' "$col_volume" "VOLUME" "$col_mount" "MOUNT" "DETAIL"
		# 3 leading spaces — see the matching note in print_volumes_summary.
		log_detail "   ${header}"
	fi

	for i in "${!row_names[@]}"; do
		if [[ "$STRUCTURED_LOGS" == "true" ]]; then
			row="${row_names[$i]} -> ${row_mounts[$i]}"
			[[ -n "${row_labels[$i]}" ]] && row="${row} — ${row_labels[$i]}"
		else
			printf -v row '%-*s  %-*s  %s' "$col_volume" "${row_names[$i]}" "$col_mount" "${row_mounts[$i]}" "${row_labels[$i]:--}"
		fi
		log_item_success "$row"
	done

	return 0
}

export -f volumes_summary_list_mounts volumes_summary_claude_identity \
	volumes_summary_codex_identity volumes_summary_gh_identity \
	volumes_summary_identity data_volume_label print_volumes_summary \
	print_data_volumes_summary
