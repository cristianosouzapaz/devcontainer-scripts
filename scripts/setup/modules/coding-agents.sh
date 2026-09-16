#!/bin/bash
set -euo pipefail

# MODULE_NAME="coding-agents"
# MODULE_DESCRIPTION="Installs and configures the supported coding agent CLIs"
# MODULE_ENTRY="coding_agents_setup"
# MODULE_AFTER="persistent-data"

# ----- OVERVIEW ---------------------------------------------------------------
#
# Installs and configures the supported coding-agent CLIs. Agent-specific
# configuration lives in the smallest helper that owns the relevant tool; the
# entry point installs and configures each agent in document order. Every step
# is idempotent and safe to re-run on a container rebuild.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../lib" && pwd)/loader.sh"

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# This module uses the following configuration variables:
# - CLAUDE_CONFIG_DIR (optional, defaults to the persistent-data managed /root/.claude link)
# - CODEX_HOME (optional, defaults to the persistent-data managed /root/.codex link)
# - PERSISTENT_DATA_HOME (optional path, defaults to /root): home for declarative defaults

# ----- CONSTANTS --------------------------------------------------------------

# Path constants: NOT readonly — test seams per bash rules.
_CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/root/.claude}"
_STATUSLINE_SOURCE="${DEVCONTAINER_ASSETS_DIR}/statusline-command.sh"
_STATUSLINE_DEST="${_CLAUDE_CONFIG_DIR}/statusline-command.sh"
_STATUSLINE_SETTINGS="${_CLAUDE_CONFIG_DIR}/settings.json"
_STATUSLINE_HASH_FILE="${_CLAUDE_CONFIG_DIR}/.statusline-hash"
_CODEX_CONFIG_DIR="${CODEX_HOME:-/root/.codex}"
_CODEX_SETTINGS="${_CODEX_CONFIG_DIR}/config.toml"
_PERSISTENT_DATA_HOME="${PERSISTENT_DATA_HOME:-/root}"
# DEVCONTAINER_ASSETS_DIR is readonly, so a declared defaultsAsset is
# resolved against this seam instead.
_CODING_AGENTS_ASSETS_DIR="${DEVCONTAINER_ASSETS_DIR}"

# ----- HELPER FUNCTIONS -------------------------------------------------------

# codex_settings_with_file_storage: Prints config.toml with file credential storage set.
# TOML keys after a table header belong to that table, so the setting leads the
# file to stay a root-level key; every other line of an existing file follows.
# Returns: 0 on success, grep's status (2) when the existing file cannot be read.
codex_settings_with_file_storage() {
	local rc=0

	printf '%s\n' 'cli_auth_credentials_store = "file"'
	[[ -f "${_CODEX_SETTINGS}" ]] || return 0
	printf '\n'
	# grep exits 1 when no other line is left, which is fine; 2 is a read error,
	# which must stop the rewrite or the developer's configuration is lost.
	grep -Ev '^cli_auth_credentials_store[[:space:]]*=' "${_CODEX_SETTINGS}" || rc=$?
	[[ "$rc" -le 1 ]] || return "$rc"
}

# configure_codex: Ensures Codex stores credentials in auth.json
# under CODEX_HOME, which is mounted on a persistent Docker volume. Rewrites only
# the top-level cli_auth_credentials_store setting and preserves all other config.
configure_codex() {
	mkdir -p "${_CODEX_CONFIG_DIR}"
	if [[ -f "${_CODEX_SETTINGS}" ]] \
		&& grep -Eq '^cli_auth_credentials_store[[:space:]]*=[[:space:]]*"file"[[:space:]]*(#.*)?$' "${_CODEX_SETTINGS}"; then
		log_debug "Codex credential storage already configured for file persistence, skipping"
		return 0
	fi

	atomic_write "${_CODEX_SETTINGS}" codex_settings_with_file_storage
	log_detail "Configured Codex credentials for persistent file storage"
}

# merge_statusline_settings: Merges the statusLine key into settings.json.
# Skips with log_warning when the file exists but contains malformed JSON.
merge_statusline_settings() {
	local current_settings result
	if [[ -f "${_STATUSLINE_SETTINGS}" ]]; then
		if ! jq -e . "${_STATUSLINE_SETTINGS}" > /dev/null 2>&1; then
			log_item_warning "settings.json is malformed — skipping statusline settings merge"
			return 0
		fi
		current_settings=$(< "${_STATUSLINE_SETTINGS}")
	else
		current_settings='{}'
	fi
	result=$(jq --arg cmd "bash ${_STATUSLINE_DEST}" \
		'. + {"statusLine": {"type": "command", "command": $cmd}}' \
		<<< "${current_settings}") || {
		log_item_warning "jq failed to generate statusLine settings — skipping"
		return 0
	}
	atomic_write "${_STATUSLINE_SETTINGS}" printf '%s\n' "${result}"
	log_debug "Merged statusLine into ${_STATUSLINE_SETTINGS}"
}

# configure_claude: Deploys statusline-command.sh to the Claude config dir
# and ensures settings.json contains the statusLine key.
# Uses sha256sum hash to detect changes; re-applies only when needed.
configure_claude() {
	local sha_output source_hash stored_hash
	local hash_differs=false dest_missing=false settings_missing=false

	if [[ ! -f "${_STATUSLINE_SOURCE}" ]]; then
		log_debug "Statusline source not found (${_STATUSLINE_SOURCE}), skipping"
		return 0
	fi

	sha_output=$(sha256sum "${_STATUSLINE_SOURCE}")
	source_hash="${sha_output%% *}"

	stored_hash=""
	if [[ -f "${_STATUSLINE_HASH_FILE}" ]]; then
		stored_hash=$(< "${_STATUSLINE_HASH_FILE}")
	fi

	[[ "${source_hash}" != "${stored_hash}" ]] && hash_differs=true
	# A missing deployed copy is restored; an existing one is never compared,
	# so a developer's edits survive until the shipped version changes.
	[[ ! -f "${_STATUSLINE_DEST}" ]] && dest_missing=true

	if [[ ! -f "${_STATUSLINE_SETTINGS}" ]] \
		|| ! jq -e '.statusLine' "${_STATUSLINE_SETTINGS}" > /dev/null 2>&1; then
		settings_missing=true
	fi

	if [[ "${hash_differs}" == 'false' ]] && [[ "${dest_missing}" == 'false' ]] \
		&& [[ "${settings_missing}" == 'false' ]]; then
		log_debug "Statusline already configured and up to date, skipping"
		return 0
	fi

	log_detail "Configuring Claude Code status line"

	if [[ "${hash_differs}" == 'true' ]] || [[ "${dest_missing}" == 'true' ]]; then
		atomic_write "${_STATUSLINE_DEST}" cat "${_STATUSLINE_SOURCE}"
		atomic_write "${_STATUSLINE_HASH_FILE}" printf '%s\n' "${source_hash}"
		log_debug "Updated statusline script (${source_hash})"
	fi

	# Restoring a deleted copy leaves settings.json alone: the merge overwrites
	# the statusLine key, which may hold a developer's custom command.
	if [[ "${settings_missing}" == 'true' ]] || [[ "${hash_differs}" == 'true' ]]; then
		merge_statusline_settings
	fi
}

# apply_agent_defaults: Fills missing settings without overwriting developer choices.
# Args: agent id. Returns: 0 on success or malformed existing JSON, nonzero on failure.
apply_agent_defaults() {
	local fields config_file defaults_asset defaults current_settings result

	fields=$(provisioning_fields agents "$1" configFile defaultsAsset)
	IFS=$'\x1f' read -r config_file defaults_asset <<<"$fields"
	[[ -n "$config_file" && -n "$defaults_asset" ]] || return 0
	defaults_asset="${_CODING_AGENTS_ASSETS_DIR}/$defaults_asset"
	if ! defaults=$(jq -cse 'select(length == 1 and (.[0] | type == "object")) | .[0]' "$defaults_asset" 2>/dev/null); then
		log_error "Defaults asset is missing or invalid: $defaults_asset"
		return 1
	fi
	config_file="${_PERSISTENT_DATA_HOME}/$config_file"
	if [[ -f "$config_file" ]]; then
		if ! jq -e . "$config_file" >/dev/null 2>&1; then
			log_item_warning "$config_file is malformed — skipping default settings merge"
			return 0
		fi
		current_settings=$(<"$config_file")
	else
		current_settings='{}'
	fi
	# Avoid even an identical rewrite: it would change the file's mtime.
	result=$(jq --argjson defaults "$defaults" \
		'. as $current | $defaults * . | select(. != $current)' <<<"$current_settings")
	[[ -n "$result" ]] || return 0
	mkdir -p "$(dirname "$config_file")"
	atomic_write "$config_file" printf '%s\n' "$result"
}

# configure_pi: Installs only packages absent from Pi's own settings.
configure_pi() {
	local fields pi_command config_file packages package current_settings missing
	local -a missing_packages=()

	fields=$(provisioning_fields agents pi command configFile packages)
	IFS=$'\x1f' read -r pi_command config_file packages <<<"$fields"
	[[ -n "$packages" ]] || return 0
	config_file="${_PERSISTENT_DATA_HOME}/$config_file"
	if [[ -f "$config_file" ]] && ! jq -e . "$config_file" >/dev/null 2>&1; then
		log_item_warning 'Pi settings.json is malformed — skipping Pi packages'
		return 0
	fi
	current_settings='{}'
	if [[ -f "$config_file" ]]; then
		current_settings=$(<"$config_file")
	fi
	# Compute the whole set difference once; -n keeps jq off the caller's stdin.
	missing=$(jq -nr --argjson installed "$current_settings" --argjson catalog "$packages" \
		'$catalog - ($installed.packages // []) | .[]')
	[[ -n "$missing" ]] || return 0
	mapfile -t missing_packages <<<"$missing"
	for package in "${missing_packages[@]}"; do
		log_detail "Installing Pi extension ${package}"
		spinner_stream log_debug "$pi_command" install "$package"
	done
}

# ----- CORE SETUP -------------------------------------------------------------

# coding_agents_setup: Installs and configures each declared agent in document order.
# Args: none. Returns: 0 on success; the first unhandled failure stops the module.
coding_agents_setup() {
	local agent_id cli_command label npm_package exit_code ids fields configure
	local -a agent_ids=()

	ids=$(provisioning_ids agents)
	[[ -n "$ids" ]] || return 0
	mapfile -t agent_ids <<<"$ids"
	for agent_id in "${agent_ids[@]}"; do
		fields=$(provisioning_fields agents "$agent_id" command label npmPackage)
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

export -f codex_settings_with_file_storage configure_codex configure_claude configure_pi apply_agent_defaults \
	merge_statusline_settings coding_agents_setup
