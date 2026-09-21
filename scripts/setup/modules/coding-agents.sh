#!/bin/bash
set -euo pipefail

# MODULE_NAME="coding-agents"
# MODULE_DESCRIPTION="Installs and configures the supported coding agent CLIs"
# MODULE_ENTRY="coding_agents_setup"
# MODULE_AFTER="persistent-data"
# MODULE_SECRETS=""

# ----- OVERVIEW ---------------------------------------------------------------
#
# Installs and configures the coding-agent CLIs declared in the inventory,
# in document order. Each catalogued asset is written the way its type
# prescribes, under the owning entry's persistent-data category, and every step is
# safe to re-run on a container rebuild.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../lib" && pwd)/loader.sh"

# ----- INTERNAL CONSTANTS -----------------------------------------------------

# why: DEVCONTAINER_ASSETS_DIR is readonly, so tests point catalogued assets elsewhere through this seam
_CODING_AGENTS_ASSETS_DIR="${DEVCONTAINER_ASSETS_DIR}"

# ----- HELPER FUNCTIONS -------------------------------------------------------

# agent_asset <agent_id> <asset_id>: prints the agent's catalogued asset as compact JSON, empty when it declares none under that id
agent_asset() {
	inventory_assets agents "$1" | jq -c --arg id "$2" 'select(.id == $id)'
}

# asset_source <asset_json>: prints the shipped file the asset is written from
# Returns: 1 with the path logged when the shipped file is missing, so every asset kind
#   reports a missing source the same way.
asset_source() {
	local source

	source="${_CODING_AGENTS_ASSETS_DIR}/$(jq -r '.source' <<<"$1")"
	if [[ ! -f "${source}" ]]; then
		log_error "Catalogued asset source is missing: ${source}"
		return 1
	fi
	printf '%s\n' "${source}"
}

# asset_target <entry_id> <asset_json>: prints the absolute path the asset is written to
# Notes: every target resolves under the owning entry's persistent-data category, the one
#   base that exists for agents and categories alike. The managed home link points at that
#   directory, so a CLI reading through the link sees the file this module wrote.
asset_target() {
	local category_path

	category_path=$(persistent_data_category_path "$1") || return 1
	printf '%s/%s\n' "${category_path}" "$(jq -r '.target' <<<"$2")"
}

# deploy_managed_file <source> <destination> <changed_var>: writes a managed asset when the shipped file changed, setting <changed_var> to whether it did
# Notes: the fingerprint of the last deployed version lives next to the destination, as
#   .<basename>.sha256, so nothing has to be declared for it. A destination without that
#   state file is adopted — the shipped fingerprint is recorded and the file is left
#   alone — because state and destination are written together, so a destination without
#   state can only come from outside this module, where overwriting would lose data.
deploy_managed_file() {
	local source="$1" destination="$2" source_hash hash_file stored_hash=''
	local -n _managed_changed="$3"

	_managed_changed=false
	hash_file="${destination%/*}/.${destination##*/}.sha256"
	source_hash="$(sha256sum "${source}")"
	source_hash="${source_hash%% *}"
	if [[ -f "${hash_file}" ]]; then
		stored_hash="$(< "${hash_file}")"
	fi
	mkdir -p "${destination%/*}"
	if [[ ! -f "${hash_file}" && -f "${destination}" ]]; then
		atomic_write "${hash_file}" printf '%s\n' "${source_hash}"
		log_debug "Adopted an unmanaged ${destination}"
		return 0
	fi
	if [[ "${source_hash}" == "${stored_hash}" && -f "${destination}" ]]; then
		return 0
	fi
	atomic_write "${destination}" cat "${source}"
	atomic_write "${hash_file}" printf '%s\n' "${source_hash}"
	[[ "${source_hash}" != "${stored_hash}" ]] && _managed_changed=true
	return 0
}

# merge_json_asset <source> <destination>: fills in the JSON settings the developer has not set, existing values winning
merge_json_asset() {
	local source="$1" destination="$2" defaults current_settings result

	if ! defaults=$(jq -cse 'select(length == 1 and (.[0] | type == "object")) | .[0]' "${source}" 2>/dev/null); then
		log_error "Catalogued asset is not a JSON object: ${source}"
		return 1
	fi
	if [[ -f "${destination}" ]]; then
		if ! jq -e . "${destination}" >/dev/null 2>&1; then
			log_item_warning "${destination} is malformed — skipping default settings merge"
			return 0
		fi
		current_settings=$(<"${destination}")
	else
		current_settings='{}'
	fi
	result=$(jq --argjson defaults "${defaults}" '. as $current | $defaults * . | select(. != $current)' <<<"${current_settings}")
	[[ -n "${result}" ]] || return 0
	mkdir -p "${destination%/*}"
	atomic_write "${destination}" printf '%s\n' "${result}"
}

# merge_statusline_settings <settings_file> <statusline_path>: sets the statusLine command in Claude's settings.json, warning and skipping when the file is malformed JSON
merge_statusline_settings() {
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

# codex_settings_with_defaults <defaults_file> <config_file>: prints the Codex configuration with the catalogued root-level defaults filled in and file credential storage enforced
# Returns: grep's status when the existing configuration cannot be read, so the caller
#   aborts before replacing it.
# Notes: the credential line and the defaults lead the output, so a root-level key can
#   never land inside an existing [table]. The "already set" probe covers only the
#   root-level region, above the first table header, so a same-named key inside a table
#   does not mask a default the developer has not actually set.
codex_settings_with_defaults() {
	local defaults_file="$1" config_file="$2" existing='' root_keys='' line key rc=0

	printf '%s\n' 'cli_auth_credentials_store = "file"'
	if [[ -f "${config_file}" ]]; then
		existing=$(grep -Ev '^cli_auth_credentials_store[[:space:]]*=' "${config_file}") || rc=$?
		[[ "${rc}" -le 1 ]] || return "${rc}"
		root_keys=$(sed -n '/^[[:space:]]*\[/q; s/^\([A-Za-z_][A-Za-z0-9_-]*\)[[:space:]]*=.*/\1/p' <<<"${existing}")
	fi
	while IFS= read -r line; do
		[[ "${line}" =~ ^([A-Za-z_][A-Za-z0-9_-]*)[[:space:]]*= ]] || continue
		key="${BASH_REMATCH[1]}"
		if grep -qxF "${key}" <<<"${root_keys}"; then
			continue
		fi
		printf '%s\n' "${line}"
	done < "${defaults_file}"
	[[ -z "${existing}" ]] || printf '%s\n' "${existing}"
}

# apply_agent_defaults <agent_id>: merges every catalogued merge-json asset of the agent
apply_agent_defaults() {
	local agent_id="$1" assets asset source destination

	assets=$(inventory_assets agents "${agent_id}") || return 1
	[[ -n "${assets}" ]] || return 0
	while IFS= read -r asset; do
		[[ -n "${asset}" ]] || continue
		[[ "$(jq -r '.type' <<<"${asset}")" == 'merge-json' ]] || continue
		source=$(asset_source "${asset}")
		destination=$(asset_target "${agent_id}" "${asset}")
		merge_json_asset "${source}" "${destination}"
	done <<<"${assets}"
}

# configure_claude: deploys the catalogued statusline script and points the statusLine key at it
# Notes: the key is merged again only when the shipped script changed or the key is
#   missing, so a developer's custom command survives a restored copy of the script.
configure_claude() {
	local asset source statusline_path settings_file changed=false settings_missing=false

	asset=$(agent_asset claude statusline)
	if [[ -z "${asset}" ]]; then
		log_debug 'No Claude statusline asset declared, skipping'
		return 0
	fi
	source=$(asset_source "${asset}")
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
	log_detail 'Configuring Claude Code status line'
	merge_statusline_settings "${settings_file}" "${statusline_path}"
}

# configure_codex: merges the catalogued Codex defaults and enforces file credential storage
# Notes: the configuration lives on a persistent volume, so the merged result survives
#   rebuilds; it is rewritten only when it would actually change.
configure_codex() {
	local asset source config_file current desired

	asset=$(agent_asset codex config)
	if [[ -z "${asset}" ]]; then
		log_debug 'No Codex config asset declared, skipping defaults'
		return 0
	fi
	source=$(asset_source "${asset}")
	config_file=$(asset_target codex "${asset}")
	mkdir -p "${config_file%/*}"
	desired=$(codex_settings_with_defaults "${source}" "${config_file}")
	if [[ -f "${config_file}" ]]; then
		current=$(<"${config_file}")
		[[ "${current}" == "${desired}" ]] && return 0
	fi
	atomic_write "${config_file}" printf '%s\n' "${desired}"
	log_detail 'Configured Codex settings from catalogued defaults'
}

# configure_pi: deploys Pi's catalogued managed files and installs the catalogued packages Pi does not carry yet
configure_pi() {
	local pi_command assets asset settings_asset settings_file source destination changed=false
	local current_settings missing package
	local -a packages=() missing_packages=()

	pi_command=$(inventory_fields agents pi command)
	assets=$(inventory_assets agents pi) || return 1
	while IFS= read -r asset; do
		[[ -n "${asset}" ]] || continue
		case "$(jq -r '.type' <<<"${asset}")" in
		package) packages+=("$(jq -r '.source' <<<"${asset}")") ;;
		managed-file)
			source=$(asset_source "${asset}")
			destination=$(asset_target pi "${asset}")
			deploy_managed_file "${source}" "${destination}" changed
			;;
		esac
	done <<<"${assets}"
	settings_asset=$(agent_asset pi settings)
	if [[ -z "${settings_asset}" ]]; then
		log_debug 'No Pi settings asset declared, skipping Pi packages'
		return 0
	fi
	settings_file=$(asset_target pi "${settings_asset}")
	if [[ -f "${settings_file}" ]] && ! jq -e . "${settings_file}" >/dev/null 2>&1; then
		log_item_warning 'Pi settings.json is malformed — skipping Pi packages'
		return 0
	fi
	[[ ${#packages[@]} -gt 0 ]] || return 0
	current_settings='{}'
	if [[ -f "${settings_file}" ]]; then
		current_settings=$(<"${settings_file}")
	fi
	# why: -n keeps jq off the caller's stdin
	missing=$(jq -nr --argjson installed "${current_settings}" --argjson catalog "$(printf '%s\n' "${packages[@]}" | jq -R . | jq -s .)" \
		'$catalog - ($installed.packages // []) | .[]')
	[[ -n "${missing}" ]] || return 0
	mapfile -t missing_packages <<<"${missing}"
	for package in "${missing_packages[@]}"; do
		log_detail "Installing Pi extension ${package}"
		spinner_stream log_debug "${pi_command}" install "${package}"
	done
}

# ----- CORE SETUP -------------------------------------------------------------

# coding_agents_setup: module entry; installs each declared agent CLI missing from PATH, then applies its defaults and its configure_<id> step, in document order
coding_agents_setup() {
	local agent_id cli_command label npm_package exit_code ids fields configure
	local -a agent_ids=()

	ids=$(inventory_ids agents)
	[[ -n "$ids" ]] || return 0
	mapfile -t agent_ids <<<"$ids"
	for agent_id in "${agent_ids[@]}"; do
		fields=$(inventory_fields agents "$agent_id" command label npmPackage)
		IFS=$'\x1f' read -r cli_command label npm_package <<<"$fields"
		if check_command "$cli_command"; then
			log_debug "${label} CLI already installed, skipping"
		else
			start_spinner "Installing ${label} CLI (${npm_package})"
			exit_code=0
			spinner_stream log_debug npm install -g "$npm_package" || exit_code=$?
			if [[ "$exit_code" -ne 0 ]]; then
				push_error "$DEVCONTAINER_FATAL_ERROR" "${LINENO}" 'coding_agents_setup' \
					"npm install -g ${npm_package}" "${label} CLI installation failed"
				stop_spinner 1
				return 1
			fi
			stop_spinner 0
		fi
		apply_agent_defaults "$agent_id"
		configure="configure_${agent_id}"
		if declare -F "$configure" >/dev/null; then
			"$configure"
		fi
	done
}

export -f agent_asset asset_source asset_target deploy_managed_file merge_json_asset \
	merge_statusline_settings codex_settings_with_defaults apply_agent_defaults \
	configure_claude configure_codex configure_pi coding_agents_setup
