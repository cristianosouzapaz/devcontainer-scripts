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
# entry point wires those helpers in install order. Every step is idempotent and
# safe to re-run on a container rebuild.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../lib" && pwd)/loader.sh"

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# This module uses the following configuration variables:
# - CLAUDE_CONFIG_DIR (optional, defaults to the persistent-data managed /root/.claude link)
# - CODEX_HOME (optional, defaults to the persistent-data managed /root/.codex link)
# - PI_CODING_AGENT_DIR (optional, defaults to the persistent-data managed /root/.pi/agent link)

# ----- CONSTANTS --------------------------------------------------------------

# Path constants: NOT readonly — test seams per bash rules.
_CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/root/.claude}"
_STATUSLINE_SOURCE="${DEVCONTAINER_ASSETS_DIR}/statusline-command.sh"
_STATUSLINE_DEST="${_CLAUDE_CONFIG_DIR}/statusline-command.sh"
_STATUSLINE_SETTINGS="${_CLAUDE_CONFIG_DIR}/settings.json"
_STATUSLINE_HASH_FILE="${_CLAUDE_CONFIG_DIR}/.statusline-hash"
_CODEX_CONFIG_DIR="${CODEX_HOME:-/root/.codex}"
_CODEX_SETTINGS="${_CODEX_CONFIG_DIR}/config.toml"
_PI_CONFIG_DIR="${PI_CODING_AGENT_DIR:-/root/.pi/agent}"
_PI_SETTINGS="${_PI_CONFIG_DIR}/settings.json"
_PI_DEFAULTS_CATALOG="${DEVCONTAINER_CONFIG_DIR}/pi-defaults.json"

# ----- HELPER FUNCTIONS -------------------------------------------------------

# install_coding_agent_clis: Installs every catalog CLI via npm when absent.
# Returns: 0 on success, 1 when an installation fails.
install_coding_agent_clis() {
	local agent_id cli_command label npm_package exit_code ids
	local -a agent_ids=()

	ids=$(coding_agents_ids) || return 1
	[[ -n "$ids" ]] || return 0
	mapfile -t agent_ids <<< "$ids"
	for agent_id in "${agent_ids[@]}"; do
		cli_command=$(coding_agents_field "$agent_id" command) || return 1
		label=$(coding_agents_field "$agent_id" label) || return 1
		npm_package=$(coding_agents_field "$agent_id" npmPackage) || return 1
		if check_command "$cli_command"; then
			log_debug "${label} CLI already installed, skipping"
			continue
		fi
		start_spinner "Installing ${label} CLI (${npm_package})"
		exit_code=0
		spinner_stream log_debug npm install -g "$npm_package" || exit_code=$?
		if [[ "$exit_code" -ne 0 ]]; then
			push_error "$DEVCONTAINER_FATAL_ERROR" "${LINENO}" "install_coding_agent_clis" \
				"npm install -g ${npm_package}" "${label} CLI installation failed"
			stop_spinner 1
			return 1
		fi
		stop_spinner 0
	done
}

# configure_codex_auth_storage: Ensures Codex stores credentials in auth.json
# under CODEX_HOME, which is mounted on a persistent Docker volume. Rewrites only
# the top-level cli_auth_credentials_store setting and preserves all other config.
configure_codex_auth_storage() {
	local tmp_file

	mkdir -p "${_CODEX_CONFIG_DIR}"
	if [[ -f "${_CODEX_SETTINGS}" ]] \
		&& grep -Eq '^cli_auth_credentials_store[[:space:]]*=[[:space:]]*"file"[[:space:]]*(#.*)?$' "${_CODEX_SETTINGS}"; then
		log_debug "Codex credential storage already configured for file persistence, skipping"
		return 0
	fi

	tmp_file=$(mktemp)
	# TOML keys after a table header belong to that table. Keep this setting at the
	# start of the file so it is always a root-level Codex configuration key.
	printf '%s\n' 'cli_auth_credentials_store = "file"' > "${tmp_file}"
	if [[ -f "${_CODEX_SETTINGS}" ]]; then
		printf '\n' >> "${tmp_file}"
		grep -Ev '^cli_auth_credentials_store[[:space:]]*=' "${_CODEX_SETTINGS}" >> "${tmp_file}" || true
	fi
	mv "${tmp_file}" "${_CODEX_SETTINGS}"
	log_detail "Configured Codex credentials for persistent file storage"
}

# merge_statusline_settings: Merges the statusLine key into settings.json.
# Skips with log_warning when the file exists but contains malformed JSON.
merge_statusline_settings() {
	local current_settings result tmp_file
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
	tmp_file=$(mktemp)
	printf '%s\n' "${result}" > "${tmp_file}"
	mv "${tmp_file}" "${_STATUSLINE_SETTINGS}"
	log_debug "Merged statusLine into ${_STATUSLINE_SETTINGS}"
}

# configure_statusline: Deploys statusline-command.sh to the Claude config dir
# and ensures settings.json contains the statusLine key.
# Uses sha256sum hash to detect changes; re-applies only when needed.
configure_statusline() {
	local sha_output source_hash stored_hash
	local hash_differs=false dest_missing=false settings_missing=false

	if [[ ! -f "${_STATUSLINE_SOURCE}" ]]; then
		log_debug "Statusline source not found (${_STATUSLINE_SOURCE}), skipping"
		return 0
	fi

	if ! check_command "jq"; then
		log_debug "jq not available, skipping statusline configuration"
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
		cp "${_STATUSLINE_SOURCE}" "${_STATUSLINE_DEST}"
		printf '%s\n' "${source_hash}" > "${_STATUSLINE_HASH_FILE}"
		log_debug "Updated statusline script (${source_hash})"
	fi

	# Restoring a deleted copy leaves settings.json alone: the merge overwrites
	# the statusLine key, which may hold a developer's custom command.
	if [[ "${settings_missing}" == 'true' ]] || [[ "${hash_differs}" == 'true' ]]; then
		merge_statusline_settings
	fi
}

# configure_pi_defaults: Applies the Pi default package catalog and settings.
# Package installs go through Pi so its managed npm tree is populated; settings
# are merged so existing developer choices win over shipped defaults.
configure_pi_defaults() {
	local catalog_packages catalog_settings current_settings installed_packages result tmp_file package pi_command
	local -a missing_packages=()

	pi_command=$(coding_agents_field pi command) || return 1
	if [[ ! -f "${_PI_DEFAULTS_CATALOG}" ]]; then
		log_error "Pi defaults catalog is missing: ${_PI_DEFAULTS_CATALOG}"
		return 1
	fi
	if ! jq -e '(.packages | type == "array") and (.settings | type == "object")' "${_PI_DEFAULTS_CATALOG}" >/dev/null 2>&1; then
		log_error "Pi defaults catalog is invalid: ${_PI_DEFAULTS_CATALOG}"
		return 1
	fi
	if [[ -f "${_PI_SETTINGS}" ]] && ! jq -e . "${_PI_SETTINGS}" >/dev/null 2>&1; then
		log_item_warning "Pi settings.json is malformed — skipping Pi defaults"
		return 0
	fi

	mkdir -p "${_PI_CONFIG_DIR}"
	catalog_packages=$(jq -c '.packages' "${_PI_DEFAULTS_CATALOG}")
	catalog_settings=$(jq -c '.settings' "${_PI_DEFAULTS_CATALOG}")
	if [[ -f "${_PI_SETTINGS}" ]]; then
		current_settings=$(< "${_PI_SETTINGS}")
	else
		current_settings='{}'
	fi
	installed_packages=$(jq -c '.packages // []' <<< "${current_settings}")
	# -n: no input document; without it jq blocks on the caller's open stdin.
	mapfile -t missing_packages < <(jq -nr --argjson catalog "${catalog_packages}" \
		--argjson installed "${installed_packages}" '$catalog - $installed | .[]')

	for package in "${missing_packages[@]}"; do
		log_detail "Installing Pi extension ${package}"
		spinner_stream log_debug "${pi_command}" install "${package}" || return 1
	done

	if [[ -f "${_PI_SETTINGS}" ]]; then
		current_settings=$(< "${_PI_SETTINGS}")
	else
		current_settings='{}'
	fi
	# Rewriting an up-to-date file would still bump its mtime and break idempotency.
	if jq -e --argjson defaults "${catalog_settings}" '($defaults * .) == .' <<< "${current_settings}" >/dev/null; then
		log_debug "Pi default settings already applied, skipping"
		return 0
	fi
	result=$(jq --argjson defaults "${catalog_settings}" '$defaults * .' <<< "${current_settings}") || return 1
	tmp_file=$(mktemp)
	printf '%s\n' "${result}" > "${tmp_file}"
	mv "${tmp_file}" "${_PI_SETTINGS}"
	log_debug "Merged Pi default settings into ${_PI_SETTINGS}"
}

# ----- CORE SETUP -------------------------------------------------------------

# coding_agents_setup: Module entry point. Ensures each supported coding-agent
# CLI is installed and its persistent defaults are configured. Every step is
# idempotent and safe to re-run on container rebuilds.
coding_agents_setup() {
	setup_error_traps
	install_coding_agent_clis || return 1
	configure_statusline
	configure_codex_auth_storage
	configure_pi_defaults
}

export -f install_coding_agent_clis configure_codex_auth_storage configure_pi_defaults \
	merge_statusline_settings configure_statusline coding_agents_setup
