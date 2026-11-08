# shellcheck shell=bash

# CORE_NAME="coding-agents"
# CORE_DESCRIPTION="Installs and configures the coding agent CLIs CODING_AGENTS lists"
# CORE_ENTRY="coding_agents_setup"
# CORE_AFTER="persistent-data"
# CORE_SECRETS=""
# CORE_PERSIST="agents"

# ----- OVERVIEW ---------------------------------------------------------------
#
# Installs and configures the coding-agent CLIs CODING_AGENTS lists (the packs
# marked default when unset), one pack folder each under coding-agents/, in pack
# ID order; an ID with no pack stops the setup. Each pack's merge-json assets are
# applied the same way for every agent; anything its agent.json cannot express
# runs from the pack's agent_<id>_configure hook. Every step is safe to re-run on
# a container rebuild.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../lib" && pwd)/loader.sh"

# ----- HELPER FUNCTIONS -------------------------------------------------------

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
		log_error "Pack asset is not a JSON object: ${source}"
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

# apply_agent_defaults <agent_id>: merges every merge-json asset of the agent's pack
apply_agent_defaults() {
	local agent_id="$1" assets asset source destination

	assets=$(inventory_assets "${agent_id}") || return 1
	[[ -n "${assets}" ]] || return 0
	while IFS= read -r asset; do
		[[ -n "${asset}" ]] || continue
		[[ "$(jq -r '.type' <<<"${asset}")" == 'merge-json' ]] || continue
		source=$(inventory_asset_source "${agent_id}" "${asset}")
		destination=$(asset_target "${agent_id}" "${asset}")
		merge_json_asset "${source}" "${destination}"
	done <<<"${assets}"
}

# ----- CORE SETUP -------------------------------------------------------------

# coding_agents_setup: core entry; installs each selected pack's agent CLI missing from PATH, then applies its defaults and its agent_<id>_configure hook, in pack ID order
# Notes: one outcome line per agent, its label as is: installed, or already installed.
coding_agents_setup() {
	local agent_id cli_command label npm_package exit_code ids fields configure
	local -a agent_ids=()

	if ! inventory_check_selection; then
		push_error "$DEVCONTAINER_FATAL_ERROR" "${LINENO}" 'coding_agents_setup' \
			"CODING_AGENTS=${CODING_AGENTS:-}" 'CODING_AGENTS lists an unknown coding agent'
		return 1
	fi
	ids=$(inventory_selected_ids)
	if [[ -z "$ids" ]]; then
		log_item_info "No coding agent declared"
		return 0
	fi
	mapfile -t agent_ids <<<"$ids"
	for agent_id in "${agent_ids[@]}"; do
		fields=$(inventory_fields agents "$agent_id" command label npmPackage)
		IFS=$'\x1f' read -r cli_command label npm_package <<<"$fields"
		if check_command "$cli_command"; then
			log_item_info "${label} already installed"
		else
			start_spinner "Installing ${label} (${npm_package})"
			exit_code=0
			# why: a registry hiccup must not fail the setup, and a hung install must not stall it forever
			retry_command --timeout 600 --label "npm install -g ${npm_package}" 3 1 \
				spinner_stream log_debug npm install -g "$npm_package" || exit_code=$?
			if [[ "$exit_code" -ne 0 ]]; then
				push_error "$DEVCONTAINER_FATAL_ERROR" "${LINENO}" 'coding_agents_setup' \
					"npm install -g ${npm_package}" "${label} installation failed"
				stop_spinner 1 "${label} installation failed"
				return 1
			fi
			stop_spinner 0 "${label} installed"
		fi
		apply_agent_defaults "$agent_id"
		configure="agent_${agent_id}_configure"
		if declare -F "$configure" >/dev/null; then
			"$configure"
		fi
	done
}

export -f deploy_managed_file merge_json_asset apply_agent_defaults coding_agents_setup
