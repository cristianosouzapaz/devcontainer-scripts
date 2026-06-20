#!/bin/bash
set -euo pipefail

# MODULE_NAME="claude-ai"
# MODULE_DESCRIPTION="Installs the Claude CLI and configures the Code status line"
# MODULE_ENTRY="claude_ai_setup"

# Claude AI CLI installer and status-line configurator module
#
# Ensures the Claude CLI is installed and that the status-line script is
# deployed to the Claude config dir with its settings.json entry merged in.
# Both steps are idempotent and safe to re-run on every container rebuild.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(dirname "${BASH_SOURCE[0]}")/../shared/loader.sh"

# ----- CONSTANTS --------------------------------------------------------------

readonly _CLAUDE_CLI_COMMAND="claude"
readonly _CLAUDE_INSTALL_NAME="@anthropic-ai/claude-code"

# Path constants: NOT readonly — test seams per bash rules.
_CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/root/.claude}"
_STATUSLINE_SOURCE="/opt/devcontainer/setup/assets/statusline-command.sh"
_STATUSLINE_DEST="${_CLAUDE_CONFIG_DIR}/statusline-command.sh"
_STATUSLINE_SETTINGS="${_CLAUDE_CONFIG_DIR}/settings.json"
_STATUSLINE_HASH_FILE="${_CLAUDE_CONFIG_DIR}/.statusline-hash"

# ----- INTERNAL HELPERS -------------------------------------------------------

# _install_claude_cli: Installs Claude CLI via npm if not already present.
# Fails hard on install failure.
_install_claude_cli() {
	local npm_output
	check_command "${_CLAUDE_CLI_COMMAND}" && {
		log_debug "Claude CLI already installed, skipping"
		return 0
	}
	log_info "Installing Claude CLI (${_CLAUDE_INSTALL_NAME})"
	npm_output=$(npm install -g "${_CLAUDE_INSTALL_NAME}" 2>&1) || {
		push_error "$FATAL_ERROR" "${LINENO}" "_install_claude_cli" \
			"npm install -g ${_CLAUDE_INSTALL_NAME}" "Claude CLI installation failed"
		log_error "Claude CLI installation failed"
		log_debug "${npm_output}"
		return 1
	}
	log_debug "${npm_output}"
}

# _merge_statusline_settings: Merges the statusLine key into settings.json.
# Skips with log_warning when the file exists but contains malformed JSON.
_merge_statusline_settings() {
	local current_settings result tmp_file
	if [[ -f "${_STATUSLINE_SETTINGS}" ]]; then
		if ! jq -e . "${_STATUSLINE_SETTINGS}" > /dev/null 2>&1; then
			log_warning "settings.json is malformed — skipping statusline settings merge"
			return 0
		fi
		current_settings=$(< "${_STATUSLINE_SETTINGS}")
	else
		current_settings='{}'
	fi
	result=$(jq --arg cmd "bash ${_STATUSLINE_DEST}" \
		'. + {"statusLine": {"type": "command", "command": $cmd}}' \
		<<< "${current_settings}") || {
		log_warning "jq failed to generate statusLine settings — skipping"
		return 0
	}
	tmp_file=$(mktemp)
	printf '%s\n' "${result}" > "${tmp_file}"
	mv "${tmp_file}" "${_STATUSLINE_SETTINGS}"
	log_debug "Merged statusLine into ${_STATUSLINE_SETTINGS}"
}

# _configure_statusline: Deploys statusline-command.sh to the Claude config dir
# and ensures settings.json contains the statusLine key.
# Uses sha256sum hash to detect changes; re-applies only when needed.
_configure_statusline() {
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

	log_info "Configuring Claude Code status line"

	if [[ "${hash_differs}" == 'true' ]]; then
		cp "${_STATUSLINE_SOURCE}" "${_STATUSLINE_DEST}"
		printf '%s\n' "${source_hash}" > "${_STATUSLINE_HASH_FILE}"
		log_debug "Updated statusline script (${source_hash})"
	fi

	if [[ "${settings_missing}" == 'true' ]] || [[ "${hash_differs}" == 'true' ]]; then
		_merge_statusline_settings
	fi
}

# ----- ENTRY POINT ------------------------------------------------------------

# claude_ai_setup: Module entry point.
# Installs the Claude CLI and configures the Code status line.
claude_ai_setup() {
	setup_error_traps || true
	_install_claude_cli || return 1
	_configure_statusline
}
