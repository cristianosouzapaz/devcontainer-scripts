#!/bin/bash

[[ -n "${_PERSISTENT_DATA_SUMMARY_SH_LOADED:-}" ]] && return 0
readonly _PERSISTENT_DATA_SUMMARY_SH_LOADED=1

# Persistent-data summary - Prints a readable, registry-driven view of the
# logical persistent-data categories at the end of setup, grouped by purpose,
# plus the project workspace volume.
#
# Provides one public function:
#   persistent_data_summary_print - Logs the shared physical volume once as the
#                                    common origin, then three groups sourced
#                                    from the central persistent-data registry
#                                    and the container's own mounts:
#                                      Authentication data  (group=authentication)
#                                      Persistent tool data (group=tool)
#                                      Workspace data        (the <project>-data
#                                                             volume on /workspace)
#                                    Authentication rows carry the tool's own
#                                    login status (via its status command, never
#                                    by reading credential files); tool rows only
#                                    report path availability. A category whose
#                                    scope root isn't mounted shows "not mounted".
#
# Mount data comes from `docker inspect` against the container's own ID (read
# from /etc/hostname); the function silently does nothing without Docker access.
# It keeps NO second hardcoded list of categories or volumes — the registry is
# the only category authority.

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_HOSTNAME_PATH="${_HOSTNAME_PATH:-/etc/hostname}"

# Shared physical volume shown once as the common origin (see docs/wiki/setup/library-layer.md).
_PERSISTENT_DATA_SHARED_VOLUME="${_PERSISTENT_DATA_SHARED_VOLUME:-devcontainer-shared-data}"

# Login hints keyed by the registry statusCheck token, for the "not
# authenticated" row of an authentication category.
declare -gA _PERSISTENT_DATA_LOGIN_HINT=(
	[claude]="claude auth login"
	[codex]="codex login"
	[github]="gh auth login"
)

# ----- INTERNAL HELPERS -------------------------------------------------------

# Print "<volume-name>|<destination>" for every named volume mounted on the
# current container, or nothing if docker/the socket is unavailable.
persistent_data_summary_list_mounts() {
	local container_id

	command -v docker >/dev/null 2>&1 || return 0
	[[ -f "$_HOSTNAME_PATH" ]] || return 0
	container_id="$(<"$_HOSTNAME_PATH")"

	docker inspect "$container_id" \
		--format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}|{{.Destination}}
{{end}}{{end}}' 2>/dev/null || true
}

# persistent_data_summary_claude_identity: echoes the authenticated account's email
# via `claude auth status` (never by reading .credentials.json directly).
# Returns: 0 and prints the email if authenticated, 1 otherwise.
persistent_data_summary_claude_identity() {
	local output
	command -v claude >/dev/null 2>&1 || return 1
	output="$(claude auth status --text 2>/dev/null)" || return 1
	sed -n 's/^Email: //p' <<<"$output"
}

# persistent_data_summary_codex_identity: echoes the ChatGPT account email backing the
# stored Codex login. `codex login status` confirms a session exists but exposes
# no account identifier, so the email is read from the id_token JWT in
# ~/.codex/auth.json (CODEX_HOME). Falls back to a neutral "active session"
# description when the session is active but no email can be extracted — e.g. an
# API-key login, which has no id_token.
# Returns: 0 and prints the email (or "active session") if authenticated,
# 1 otherwise.
persistent_data_summary_codex_identity() {
	local auth_file="${CODEX_HOME:-$HOME/.codex}/auth.json"
	local id_token payload email

	command -v codex >/dev/null 2>&1 || return 1
	codex login status > /dev/null 2>&1 || return 1

	if [[ -f "$auth_file" ]] && command -v jq >/dev/null 2>&1; then
		id_token="$(jq -r '.tokens.id_token // empty' "$auth_file" 2>/dev/null)"
		payload="${id_token#*.}"
		payload="${payload%%.*}"
		if [[ -n "$payload" ]]; then
			email="$(jq -rn --arg p "$payload" \
				'($p | gsub("-";"+") | gsub("_";"/")) as $s
				| ($s + ("=" * ((4 - ($s | length) % 4) % 4)))
				| @base64d | fromjson | .email // empty' 2>/dev/null)"
		fi
	fi

	printf '%s\n' "${email:-active session}"
}

# persistent_data_summary_gh_identity: echoes the authenticated account name via
# `gh auth status` (never by reading hosts.yml directly).
# Returns: 0 and prints the account name if authenticated, 1 otherwise.
persistent_data_summary_gh_identity() {
	local output
	command -v gh >/dev/null 2>&1 || return 1
	output="$(gh auth status 2>&1)" || return 1
	sed -n 's/.*Logged in to [^ ]* account \([^ ]*\).*/\1/p' <<<"$output" | head -1
}

# persistent_data_summary_identity <status-check>: dispatches to the tool-specific
# identity check for a registry statusCheck token (claude, codex, github).
# Returns: 0 and prints the identity if authenticated, 1 otherwise.
persistent_data_summary_identity() {
	local status_check="$1"
	case "$status_check" in
	claude) persistent_data_summary_claude_identity ;;
	codex) persistent_data_summary_codex_identity ;;
	github) persistent_data_summary_gh_identity ;;
	*) return 1 ;;
	esac
}

# persistent_data_summary_render <title>: renders one TOOL/CATEGORY/PATH/STATUS
# group from pipe-delimited rows on stdin: "<ok>|<tool>|<category>|<path>|<status>"
# where <ok> is "true" (success symbol) or "false" (warning symbol). Plain-text
# mode prints an aligned column table under an indented header; STRUCTURED_LOGS
# mode drops the header and emits one self-contained sentence per row. Emits
# nothing at all for an empty group.
# Args: $1 - group title.
# Returns: 0 always.
persistent_data_summary_render() {
	local title="$1" ok tool category path status
	local col_tool=4 col_cat=8 col_path=4
	local -a ok_v=() tool_v=() cat_v=() path_v=() status_v=()
	local i header row

	while IFS='|' read -r ok tool category path status; do
		[[ -n "$ok" ]] || continue
		ok_v+=("$ok"); tool_v+=("$tool"); cat_v+=("$category")
		path_v+=("$path"); status_v+=("$status")
		((${#tool} > col_tool)) && col_tool=${#tool}
		((${#category} > col_cat)) && col_cat=${#category}
		((${#path} > col_path)) && col_path=${#path}
	done

	((${#ok_v[@]} == 0)) && return 0

	log_info "${title}: ${#ok_v[@]}"

	if [[ "$STRUCTURED_LOGS" != "true" ]]; then
		printf -v header '%-*s  %-*s  %-*s  %s' "$col_tool" "TOOL" "$col_cat" "CATEGORY" "$col_path" "PATH" "STATUS"
		# 3 leading spaces: the "detail" tree-bar prefix is one column narrower
		# than the "item" tree-bar + symbol prefix used for the rows below.
		log_detail "   ${header}"
	fi

	for i in "${!ok_v[@]}"; do
		if [[ "$STRUCTURED_LOGS" == "true" ]]; then
			row="${tool_v[$i]} (${cat_v[$i]}) -> ${path_v[$i]} — ${status_v[$i]}"
		else
			printf -v row '%-*s  %-*s  %-*s  %s' "$col_tool" "${tool_v[$i]}" "$col_cat" "${cat_v[$i]}" "$col_path" "${path_v[$i]}" "${status_v[$i]}"
		fi
		if [[ "${ok_v[$i]}" == "true" ]]; then
			log_item_success "$row"
		else
			log_item_warning "$row"
		fi
	done

	return 0
}

# persistent_data_summary_render_workspace <title>: renders the VOLUME/MOUNT/STATUS
# group from pipe-delimited rows on stdin: "<ok>|<volume>|<mount>|<status>".
# Same plain-text / STRUCTURED_LOGS behaviour as persistent_data_summary_render.
# Args: $1 - group title.
# Returns: 0 always.
persistent_data_summary_render_workspace() {
	local title="$1" ok volume mount status
	local col_volume=6 col_mount=5
	local -a ok_v=() vol_v=() mount_v=() status_v=()
	local i header row

	while IFS='|' read -r ok volume mount status; do
		[[ -n "$ok" ]] || continue
		ok_v+=("$ok"); vol_v+=("$volume"); mount_v+=("$mount"); status_v+=("$status")
		((${#volume} > col_volume)) && col_volume=${#volume}
		((${#mount} > col_mount)) && col_mount=${#mount}
	done

	((${#ok_v[@]} == 0)) && return 0

	log_info "${title}: ${#ok_v[@]}"

	if [[ "$STRUCTURED_LOGS" != "true" ]]; then
		printf -v header '%-*s  %-*s  %s' "$col_volume" "VOLUME" "$col_mount" "MOUNT" "STATUS"
		# 3 leading spaces — see the matching note in persistent_data_summary_render.
		log_detail "   ${header}"
	fi

	for i in "${!ok_v[@]}"; do
		if [[ "$STRUCTURED_LOGS" == "true" ]]; then
			row="${vol_v[$i]} -> ${mount_v[$i]} — ${status_v[$i]}"
		else
			printf -v row '%-*s  %-*s  %s' "$col_volume" "${vol_v[$i]}" "$col_mount" "${mount_v[$i]}" "${status_v[$i]}"
		fi
		if [[ "${ok_v[$i]}" == "true" ]]; then
			log_item_success "$row"
		else
			log_item_warning "$row"
		fi
	done

	return 0
}

# ----- PUBLIC FUNCTIONS -----------------------------------------------------

# persistent_data_summary_print: Logs the registry-driven persistent-data
# summary — the shared volume line, then the Authentication data, Persistent
# tool data, and Workspace data groups. Categories come from the central
# registry (persistent_data_category_ids); their mount state comes from the
# container's own `docker inspect` mounts. An authentication category whose CLI
# binary isn't installed is omitted entirely (keeps unselected optional tools
# out of the summary). Silently does nothing without Docker access.
# Args: none
# Returns: 0 always
persistent_data_summary_print() {
	local mounts shared_root project_root shared_mounted=false project_mounted=false
	local workspace_volume="" mount_name mount_dest
	local category_id category group label binary status_check scope path
	local identity status ok hint mounted
	local auth_rows="" tool_rows="" workspace_rows=""
	local -a ids=()

	mounts="$(persistent_data_summary_list_mounts)"
	if [[ -z "$mounts" ]]; then
		log_debug "Skipping persistent-data summary — docker unavailable"
		return 0
	fi

	shared_root="$(persistent_data_root shared)" || return 0
	project_root="$(persistent_data_root project)" || return 0

	while IFS='|' read -r mount_name mount_dest; do
		[[ -n "$mount_name" ]] || continue
		case "$mount_dest" in
		"$shared_root") shared_mounted=true ;;
		"$project_root") project_mounted=true; workspace_volume="$mount_name" ;;
		esac
	done <<<"$mounts"

	mapfile -t ids < <(persistent_data_category_ids)

	for category_id in "${ids[@]}"; do
		[[ -n "$category_id" ]] || continue
		category="$(persistent_data_category "$category_id")" || continue
		group="$(jq -r '.group' <<<"$category")"
		label="$(jq -r '.label' <<<"$category")"
		binary="$(jq -r '.binary // ""' <<<"$category")"
		status_check="$(jq -r '.statusCheck' <<<"$category")"
		scope="$(jq -r '.scope' <<<"$category")"
		path="$(persistent_data_category_path "$category_id")" || continue

		if [[ "$scope" == "shared" ]]; then
			mounted="$shared_mounted"
		else
			mounted="$project_mounted"
		fi

		if [[ "$group" == "authentication" ]]; then
			# Every registered authentication category is listed. A missing CLI
			# reports "not installed" (a distinct state from "not authenticated"
			# and "not mounted"), never a false "not authenticated".
			if [[ -n "$binary" ]] && ! command -v "$binary" >/dev/null 2>&1; then
				status="not installed"; ok="false"
			elif [[ "$mounted" != "true" ]]; then
				status="not mounted"; ok="false"
			else
				identity=""
				identity="$(persistent_data_summary_identity "$status_check")" || identity=""
				if [[ -n "$identity" ]]; then
					status="authenticated (${identity})"; ok="true"
				else
					hint="${_PERSISTENT_DATA_LOGIN_HINT[$status_check]:-}"
					status="not authenticated, run: ${hint}"; ok="false"
				fi
			fi
			auth_rows+="${ok}|${label}|${category_id}|${path}|${status}"$'\n'
		else
			if [[ "$mounted" == "true" ]]; then
				status="available"; ok="true"
			else
				status="not mounted"; ok="false"
			fi
			tool_rows+="${ok}|${label}|${category_id}|${path}|${status}"$'\n'
		fi
	done

	if [[ -n "$workspace_volume" ]]; then
		workspace_rows="true|${workspace_volume}|${project_root}|available"$'\n'
	fi

	[[ "$shared_mounted" == "true" ]] &&
		log_info "Shared data volume: ${_PERSISTENT_DATA_SHARED_VOLUME} -> ${shared_root}"

	persistent_data_summary_render "Authentication data" <<<"$auth_rows"
	persistent_data_summary_render "Persistent tool data" <<<"$tool_rows"
	persistent_data_summary_render_workspace "Workspace data" <<<"$workspace_rows"

	return 0
}

export -f persistent_data_summary_list_mounts persistent_data_summary_claude_identity \
	persistent_data_summary_codex_identity persistent_data_summary_gh_identity \
	persistent_data_summary_identity persistent_data_summary_render \
	persistent_data_summary_render_workspace persistent_data_summary_print
