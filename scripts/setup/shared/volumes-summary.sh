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
# GitHub CLI persistent auth volumes. Silently does nothing if docker or the
# container's own inspect data isn't available (e.g. Docker feature disabled).
# A volume's row is skipped entirely — not shown as "not mounted" — when its
# CLI binary isn't installed, since that means the feature was never selected
# rather than a broken mount.
# Args: none
# Returns: 0 always
print_volumes_summary() {
	local mounts line name destination label identity hint binary
	local header_shown=false

	mounts="$(volumes_summary_list_mounts)"
	if [[ -z "$mounts" ]]; then
		log_debug "Skipping volumes summary — docker unavailable"
		return 0
	fi

	for name in "${!_VOLUMES_OF_INTEREST[@]}"; do
		binary="${_VOLUMES_BINARY[$name]}"
		command -v "$binary" >/dev/null 2>&1 || continue

		if [[ "$header_shown" == false ]]; then
			log_info "Persistent volumes:"
			header_shown=true
		fi

		label="${_VOLUMES_OF_INTEREST[$name]}"
		hint="${_VOLUMES_LOGIN_HINT[$name]}"
		destination=""
		while IFS='|' read -r line destination; do
			[[ "$line" == "$name" ]] && break
			destination=""
		done <<<"$mounts"

		if [[ -z "$destination" ]]; then
			log_warning "  ${label} (${name}) -> not mounted"
			continue
		fi

		if identity="$(volumes_summary_identity "$name")" && [[ -n "$identity" ]]; then
			log_success "  ${label} (${name}) -> ${destination} — authenticated (${identity})"
		else
			log_warning "  ${label} (${name}) -> ${destination} — not authenticated, run: ${hint}"
		fi
	done

	return 0
}

export -f volumes_summary_list_mounts volumes_summary_claude_identity \
	volumes_summary_gh_identity volumes_summary_identity print_volumes_summary
