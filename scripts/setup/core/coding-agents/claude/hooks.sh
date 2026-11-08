# shellcheck shell=bash

# Claude Code's pack hooks: what its agent.json cannot express. Sourced by the
# inventory library, so every consumer of the inventory sees them.

# ----- HOOKS ------------------------------------------------------------------

# agent_claude_merge_statusline <settings_file> <statusline_path>: sets the statusLine command in Claude's settings.json, warning and skipping when the file is malformed JSON
agent_claude_merge_statusline() {
	local settings_file="$1" statusline_path="$2" current_settings result

	if [[ -f "${settings_file}" ]]; then
		if ! jq -e . "${settings_file}" > /dev/null 2>&1; then
			log_item_warning "settings.json is malformed — skipping statusline settings merge"
			return 0
		fi
		current_settings=$(< "${settings_file}")
	else
		current_settings='{}'
	fi
	result=$(jq --arg cmd "bash ${statusline_path}" \
		'. + {"statusLine": {"type": "command", "command": $cmd}}' \
		<<< "${current_settings}") || {
		log_item_warning "jq failed to generate statusLine settings — skipping"
		return 0
	}
	mkdir -p "${settings_file%/*}"
	atomic_write "${settings_file}" printf '%s\n' "${result}"
	log_debug "Merged statusLine into ${settings_file}"
}

# agent_claude_configure: deploys the pack's statusline script and points the statusLine key at it
# Notes: the key is merged again only when the shipped script changed or the key is
#   missing, so a developer's custom command survives a restored copy of the script.
agent_claude_configure() {
	local asset source statusline_path settings_file changed=false settings_missing=false

	asset=$(agent_asset claude statusline)
	if [[ -z "${asset}" ]]; then
		log_debug 'No Claude statusline asset declared, skipping'
		return 0
	fi
	source=$(inventory_asset_source claude "${asset}")
	statusline_path=$(asset_target claude "${asset}")
	settings_file="$(persistent_data_category_path claude)/settings.json"
	if [[ ! -f "${settings_file}" ]] || ! jq -e '.statusLine' "${settings_file}" > /dev/null 2>&1; then
		settings_missing=true
	fi
	deploy_managed_file "${source}" "${statusline_path}" changed
	if [[ "${changed}" == 'false' && "${settings_missing}" == 'false' ]]; then
		log_debug 'Statusline already configured and up to date, skipping'
		return 0
	fi
	log_debug 'Configuring Claude Code status line'
	agent_claude_merge_statusline "${settings_file}" "${statusline_path}"
}

# agent_claude_identity: prints the account email from claude auth status
# Stdout: the account email, one line
# Returns: 1 when not authenticated; the probe's status when it timed out.
# Notes: asks the CLI rather than reading .credentials.json.
agent_claude_identity() {
	local output rc=0 email

	output=$(agent_probe claude auth status --text 2>/dev/null) || rc=$?
	[[ "$rc" -eq 0 ]] || return "$rc"
	email=$(sed -n 's/^Email: //p' <<<"$output" | head -n1)
	[[ -n "$email" ]] || return 1
	printf '%s\n' "$email"
}

export -f agent_claude_merge_statusline agent_claude_configure agent_claude_identity
