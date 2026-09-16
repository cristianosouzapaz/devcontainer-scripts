#!/bin/bash

[[ -n "${_PERSISTENT_DATA_SUMMARY_SH_LOADED:-}" ]] && return 0
readonly _PERSISTENT_DATA_SUMMARY_SH_LOADED=1

# Logs a registry-driven summary of the persistent-data categories at the end of
# setup: the shared volume once, then authentication data, persistent tool data and
# the workspace volume.
#
# Mounts come from `docker inspect` on the container's own ID, so without Docker
# access the summary is silently skipped. Categories come only from the provisioning
# document; no second list of categories or volumes is kept here.

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# Documented in README.md#configuration-variables:
# - STRUCTURED_LOGS
# - CODEX_HOME: Codex's own state directory holding auth.json (default ~/.codex)
# - PI_CODING_AGENT_DIR: Pi's own agent directory holding auth.json (default ~/.pi/agent)

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_HOSTNAME_PATH="${_HOSTNAME_PATH:-/etc/hostname}"
_PERSISTENT_DATA_SHARED_VOLUME="${_PERSISTENT_DATA_SHARED_VOLUME:-devcontainer-shared-data}"

# ----- INTERNAL HELPERS -------------------------------------------------------

# persistent_data_summary_list_mounts: prints "<volume>|<destination>" for each named volume mounted on this container, nothing without Docker access
persistent_data_summary_list_mounts() {
	local container_id

	command -v docker >/dev/null 2>&1 || return 0
	[[ -f "$_HOSTNAME_PATH" ]] || return 0
	container_id="$(<"$_HOSTNAME_PATH")"

	docker inspect "$container_id" \
		--format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}|{{.Destination}}
{{end}}{{end}}' 2>/dev/null || true
}

# persistent_data_summary_claude_identity: prints the account email from claude auth status, failing when not authenticated
# Notes: asks the CLI rather than reading .credentials.json.
persistent_data_summary_claude_identity() {
	local output
	command -v claude >/dev/null 2>&1 || return 1
	output="$(claude auth status --text 2>/dev/null)" || return 1
	sed -n 's/^Email: //p' <<<"$output"
}

# persistent_data_summary_codex_identity: prints the ChatGPT account email behind the Codex login, or "active session", failing when not logged in
# Notes: codex login status confirms a session but exposes no account, so the email
#   is decoded from the id_token JWT in $CODEX_HOME/auth.json; an API-key login has
#   no id_token and prints "active session".
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

# persistent_data_summary_github_identity: prints the account name from gh auth status, failing when not authenticated
# Notes: asks the CLI rather than reading hosts.yml.
persistent_data_summary_github_identity() {
	local output
	command -v gh >/dev/null 2>&1 || return 1
	output="$(gh auth status 2>&1)" || return 1
	sed -n 's/.*Logged in to [^ ]* account \([^ ]*\).*/\1/p' <<<"$output" | head -1
}

# persistent_data_summary_pi_identity: prints the providers in Pi's auth file that pi auth check reports ready, failing when none is
# Notes: readiness comes from the JSON payload, not the command's exit status.
persistent_data_summary_pi_identity() {
	local auth_file="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/auth.json"
	local provider output status ready_providers=""

	command -v pi >/dev/null 2>&1 || return 1
	[[ -f "$auth_file" ]] || return 1
	command -v jq >/dev/null 2>&1 || return 1

	while IFS= read -r provider; do
		[[ -n "$provider" ]] || continue
		output="$(pi auth check --provider "$provider" --json --no-refresh 2>/dev/null || true)"
		status="$(jq -r '.status // empty' <<<"$output" 2>/dev/null || true)"
		[[ "$status" == 'ready' ]] || continue
		if [[ -n "$ready_providers" ]]; then
			ready_providers+=", "
		fi
		ready_providers+="$provider"
	done < <(jq -r 'keys[]' "$auth_file" 2>/dev/null)

	[[ -n "$ready_providers" ]] || return 1
	printf '%s\n' "$ready_providers"
}

# persistent_data_summary_identity <identity>: prints the result of the persistent_data_summary_<identity>_identity check, failing for an unknown identity or when not authenticated
persistent_data_summary_identity() {
	local probe="$1" identity_function

	identity_function="persistent_data_summary_${probe}_identity"
	declare -F "$identity_function" >/dev/null || return 1
	"$identity_function"
}

# persistent_data_summary_log_header <header>: logs a table header aligned with the rows below it
# Notes: indented by 3 spaces because the detail prefix (tree bar) is 3 columns
#   narrower than the item prefix (tree bar, 2 spaces, symbol) the rows carry.
persistent_data_summary_log_header() {
	log_detail "   $1"
}

# persistent_data_summary_render <title>: logs one TOOL/PATH/STATUS group from "<ok>|<tool>|<category>|<path>|<status>" rows on stdin, nothing for an empty group
# Notes: <ok> true picks the success symbol, false the warning one. Plain text logs an
#   aligned table under a header; STRUCTURED_LOGS drops the header and logs one
#   self-contained sentence per row, where the category id is a stable parsing key.
persistent_data_summary_render() {
	local title="$1" ok tool category path status
	local col_tool=4 col_path=4
	local -a ok_v=() tool_v=() cat_v=() path_v=() status_v=()
	local i header row

	while IFS='|' read -r ok tool category path status; do
		[[ -n "$ok" ]] || continue
		ok_v+=("$ok"); tool_v+=("$tool"); cat_v+=("$category")
		path_v+=("$path"); status_v+=("$status")
		((${#tool} > col_tool)) && col_tool=${#tool}
		((${#path} > col_path)) && col_path=${#path}
	done

	((${#ok_v[@]} == 0)) && return 0

	log_info "${title}: ${#ok_v[@]}"

	if [[ "$STRUCTURED_LOGS" != "true" ]]; then
		printf -v header '%-*s  %-*s  %s' "$col_tool" "TOOL" "$col_path" "PATH" "STATUS"
		persistent_data_summary_log_header "$header"
	fi

	for i in "${!ok_v[@]}"; do
		if [[ "$STRUCTURED_LOGS" == "true" ]]; then
			row="${tool_v[$i]} (${cat_v[$i]}) -> ${path_v[$i]} — ${status_v[$i]}"
		else
			printf -v row '%-*s  %-*s  %s' "$col_tool" "${tool_v[$i]}" "$col_path" "${path_v[$i]}" "${status_v[$i]}"
		fi
		if [[ "${ok_v[$i]}" == "true" ]]; then
			log_item_success "$row"
		else
			log_item_warning "$row"
		fi
	done

	return 0
}

# persistent_data_summary_render_workspace <title>: logs the VOLUME/MOUNT/STATUS group from "<volume>|<mount>|<status>" rows on stdin, like persistent_data_summary_render
# Notes: a listed workspace volume is always mounted, so every row is a success.
persistent_data_summary_render_workspace() {
	local title="$1" volume mount status
	local col_volume=6 col_mount=5
	local -a vol_v=() mount_v=() status_v=()
	local i header row

	while IFS='|' read -r volume mount status; do
		[[ -n "$volume" ]] || continue
		vol_v+=("$volume"); mount_v+=("$mount"); status_v+=("$status")
		((${#volume} > col_volume)) && col_volume=${#volume}
		((${#mount} > col_mount)) && col_mount=${#mount}
	done

	((${#vol_v[@]} == 0)) && return 0

	log_info "${title}: ${#vol_v[@]}"

	if [[ "$STRUCTURED_LOGS" != "true" ]]; then
		printf -v header '%-*s  %-*s  %s' "$col_volume" "VOLUME" "$col_mount" "MOUNT" "STATUS"
		persistent_data_summary_log_header "$header"
	fi

	for i in "${!vol_v[@]}"; do
		if [[ "$STRUCTURED_LOGS" == "true" ]]; then
			row="${vol_v[$i]} -> ${mount_v[$i]} — ${status_v[$i]}"
		else
			printf -v row '%-*s  %-*s  %s' "$col_volume" "${vol_v[$i]}" "$col_mount" "${mount_v[$i]}" "${status_v[$i]}"
		fi
		log_item_success "$row"
	done

	return 0
}

# ----- PUBLIC FUNCTIONS -------------------------------------------------------

# persistent_data_summary_print: logs the shared volume line, then the Authentication data, Persistent tool data and Workspace data groups
# Notes: an authentication category whose CLI is missing reports "not installed",
#   distinct from "not authenticated" and "not mounted", never a false "not
#   authenticated".
persistent_data_summary_print() {
	local mounts shared_root project_root shared_mounted=false project_mounted=false
	local workspace_volume="" mount_name mount_dest
	local category_id fields label binary probe scope relative_path path
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

	mapfile -t ids < <(provisioning_ids all)

	for category_id in "${ids[@]}"; do
		[[ -n "$category_id" ]] || continue
		fields=$(provisioning_fields all "$category_id" label binary identity loginHint scope relativePath) || continue
		IFS=$'\x1f' read -r label binary probe hint scope relative_path <<<"$fields"

		# why: provisioning_validate allows only the shared and project scopes
		if [[ "$scope" == "shared" ]]; then
			mounted="$shared_mounted"; path="$shared_root/$relative_path"
		else
			mounted="$project_mounted"; path="$project_root/$relative_path"
		fi

		if [[ -n "$probe" ]]; then
			if [[ -n "$binary" ]] && ! command -v "$binary" >/dev/null 2>&1; then
				status="not installed"; ok="false"
			elif [[ "$mounted" != "true" ]]; then
				status="not mounted"; ok="false"
			else
				identity=""
				identity="$(persistent_data_summary_identity "$probe")" || identity=""
				if [[ -n "$identity" ]]; then
					status="authenticated (${identity})"; ok="true"
				else
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
		workspace_rows="${workspace_volume}|${project_root}|available"$'\n'
	fi

	[[ "$shared_mounted" == "true" ]] &&
		log_info "Shared data volume: ${_PERSISTENT_DATA_SHARED_VOLUME} -> ${shared_root}"

	persistent_data_summary_render "Authentication data" <<<"$auth_rows"
	persistent_data_summary_render "Persistent tool data" <<<"$tool_rows"
	persistent_data_summary_render_workspace "Workspace data" <<<"$workspace_rows"

	return 0
}

export -f persistent_data_summary_list_mounts persistent_data_summary_claude_identity \
	persistent_data_summary_codex_identity persistent_data_summary_github_identity \
	persistent_data_summary_pi_identity persistent_data_summary_identity \
	persistent_data_summary_log_header persistent_data_summary_render \
	persistent_data_summary_render_workspace persistent_data_summary_print
