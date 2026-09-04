#!/bin/bash
set -euo pipefail

# MODULE_NAME="coding-agents"
# MODULE_DESCRIPTION="Installs and configures the supported coding agent CLIs"
# MODULE_ENTRY="coding_agents_setup"
# MODULE_AFTER="persistent-data"

# ----- OVERVIEW ---------------------------------------------------------------
#
# Installs and configures the supported coding-agent CLIs — Claude Code and the
# Codex CLI — including the Claude statusline and Codex credential storage.
# Every step is idempotent and safe to re-run on a container rebuild.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../lib" && pwd)/loader.sh"

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# This module uses the following configuration variables:
# - CLAUDE_CONFIG_DIR (optional, defaults to the persistent-data managed /root/.claude link)
# - CODEX_HOME (optional, defaults to the persistent-data managed /root/.codex link)

# ----- CONSTANTS --------------------------------------------------------------

readonly _CLAUDE_CLI_COMMAND="claude"
readonly _CLAUDE_INSTALL_NAME="@anthropic-ai/claude-code"
readonly _CODEX_CLI_COMMAND="codex"
readonly _CODEX_INSTALL_NAME="@openai/codex"

# Path constants: NOT readonly — test seams per bash rules.
_CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/root/.claude}"
_STATUSLINE_SOURCE="${DEVCONTAINER_ASSETS_DIR}/statusline-command.sh"
_STATUSLINE_DEST="${_CLAUDE_CONFIG_DIR}/statusline-command.sh"
_STATUSLINE_SETTINGS="${_CLAUDE_CONFIG_DIR}/settings.json"
_STATUSLINE_HASH_FILE="${_CLAUDE_CONFIG_DIR}/.statusline-hash"
_CODEX_CONFIG_DIR="${CODEX_HOME:-/root/.codex}"
_CODEX_SETTINGS="${_CODEX_CONFIG_DIR}/config.toml"

# ----- HELPER FUNCTIONS -------------------------------------------------------

# install_claude_cli: Installs Claude CLI via npm if not already present.
# Fails hard on install failure.
install_claude_cli() {
	local exit_code
	check_command "${_CLAUDE_CLI_COMMAND}" && {
		log_debug "Claude CLI already installed, skipping"
		return 0
	}
	start_spinner "Installing Claude CLI (${_CLAUDE_INSTALL_NAME})"
	exit_code=0
	spinner_stream log_debug npm install -g "${_CLAUDE_INSTALL_NAME}" || exit_code=$?
	if [[ $exit_code -ne 0 ]]; then
		push_error "$DEVCONTAINER_FATAL_ERROR" "${LINENO}" "install_claude_cli" \
			"npm install -g ${_CLAUDE_INSTALL_NAME}" "Claude CLI installation failed"
		stop_spinner 1
		return 1
	fi
	stop_spinner 0
}

# install_codex_cli: Installs Codex CLI via npm if not already present.
# Fails hard on install failure.
install_codex_cli() {
	local exit_code
	check_command "${_CODEX_CLI_COMMAND}" && {
		log_debug "Codex CLI already installed, skipping"
		return 0
	}
	start_spinner "Installing Codex CLI (${_CODEX_INSTALL_NAME})"
	exit_code=0
	spinner_stream log_debug npm install -g "${_CODEX_INSTALL_NAME}" || exit_code=$?
	if [[ $exit_code -ne 0 ]]; then
		push_error "$DEVCONTAINER_FATAL_ERROR" "${LINENO}" "install_codex_cli" \
			"npm install -g ${_CODEX_INSTALL_NAME}" "Codex CLI installation failed"
		stop_spinner 1
		return 1
	fi
	stop_spinner 0
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
	local hash_differs=false settings_missing=false

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

	if [[ ! -f "${_STATUSLINE_SETTINGS}" ]] \
		|| ! jq -e '.statusLine' "${_STATUSLINE_SETTINGS}" > /dev/null 2>&1; then
		settings_missing=true
	fi

	if [[ "${hash_differs}" == 'false' ]] && [[ "${settings_missing}" == 'false' ]]; then
		log_debug "Statusline already configured and up to date, skipping"
		return 0
	fi

	log_detail "Configuring Claude Code status line"

	if [[ "${hash_differs}" == 'true' ]]; then
		cp "${_STATUSLINE_SOURCE}" "${_STATUSLINE_DEST}"
		printf '%s\n' "${source_hash}" > "${_STATUSLINE_HASH_FILE}"
		log_debug "Updated statusline script (${source_hash})"
	fi

	if [[ "${settings_missing}" == 'true' ]] || [[ "${hash_differs}" == 'true' ]]; then
		merge_statusline_settings
	fi
}

# ----- CORE SETUP -------------------------------------------------------------

# coding_agents_setup: Module entry point. Ensures Claude Code and Codex CLI
# are installed and configured. Every step is idempotent and safe to re-run on
# container rebuilds.
coding_agents_setup() {
	setup_error_traps
	install_claude_cli || return 1
	configure_statusline
	install_codex_cli || return 1
	configure_codex_auth_storage
}

export -f install_claude_cli install_codex_cli configure_codex_auth_storage \
	merge_statusline_settings configure_statusline coding_agents_setup
