#!/bin/bash

[[ -n "${_VOLUMES_SUMMARY_SH_LOADED:-}" ]] && return 0
readonly _VOLUMES_SUMMARY_SH_LOADED=1

# Volumes summary - Prints the mount and auth status of the persistent auth volumes
#
# Provides one public function:
#   print_volumes_summary - Logs, for the Claude Code and GitHub CLI auth
#                            volumes, whether each is mounted and whether the
#                            tool is actually authenticated (not just whether
#                            credential files are present). Mount data comes
#                            from `docker inspect` against the container's own
#                            ID (read from /etc/hostname); auth data comes from
#                            each tool's own status command, never by parsing
#                            credential files directly.

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_HOSTNAME_PATH="${_HOSTNAME_PATH:-/etc/hostname}"

declare -gA _VOLUMES_OF_INTEREST=(
	[claude-auth-data]="Claude Code"
	[gh-cli-auth-data]="GitHub CLI"
)

declare -gA _VOLUMES_LOGIN_HINT=(
	[claude-auth-data]="claude auth login"
	[gh-cli-auth-data]="gh auth login"
)

declare -gA _VOLUMES_BINARY=(
	[claude-auth-data]="claude"
	[gh-cli-auth-data]="gh"
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
	gh-cli-auth-data) volumes_summary_gh_identity ;;
	*) return 1 ;;
	esac
}

# ----- PUBLIC FUNCTIONS -------------------------------------------------------

# print_volumes_summary: Logs the mount and auth status of the Claude Code and
# GitHub CLI persistent auth volumes as a group — one primary line announcing
# the count, followed by one status-carrying line per volume (indented, each
# with its own success/warning symbol since each row is its own conclusion).
# In plain-text mode a column header and aligned columns are shown; in
# STRUCTURED_LOGS mode the header is omitted and each row is a clean sentence
# instead, so JSON output never carries terminal-only alignment padding.
# Silently does nothing if docker or the container's own inspect data isn't
# available (e.g. Docker feature disabled). A volume's row is skipped
# entirely — not shown as "not mounted" — when its CLI binary isn't
# installed, since that means the feature was never selected rather than a
# broken mount.
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

	for name in "${!_VOLUMES_OF_INTEREST[@]}"; do
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

	log_info "Persistent volumes: ${#row_names[@]}"

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

export -f volumes_summary_list_mounts volumes_summary_claude_identity \
	volumes_summary_gh_identity volumes_summary_identity print_volumes_summary
