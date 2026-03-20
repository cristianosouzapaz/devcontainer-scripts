#!/bin/bash
set -euo pipefail

# MODULE_NAME="claude-ai"
# MODULE_DESCRIPTION="Installs the Claude AI CLI via npm if not already present"
# MODULE_ENTRY="claude_ai_setup"

# Claude AI CLI installer module
#
# Installs the Claude CLI via npm. Links ~/.claude.json into the shared volume
# so that onboarding state persists alongside the OAuth credentials written
# there by claude at login — both survive container rebuilds.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(dirname "${BASH_SOURCE[0]}")/../shared/loader.sh"

# ----- CONSTANTS --------------------------------------------------------------

readonly _CLAUDE_CLI_COMMAND="claude"
readonly _CLAUDE_INSTALL_NAME="@anthropic-ai/claude-code"

_CLAUDE_CONFIG_LINK="/root/.claude.json"
_CLAUDE_CONFIG_TARGET="/root/.claude/.claude.json"
_CLAUDE_CREDS_FILE="/root/.claude/.credentials.json"

# ----- HELPER FUNCTIONS -------------------------------------------------------

# _link_claude_config: symlinks ~/.claude.json into the shared volume.
# Moves an existing plain file into the volume before linking.
_link_claude_config() {
	if [[ -L "${_CLAUDE_CONFIG_LINK}" ]]; then
		log_debug "Claude config symlink already in place — skipping"
		return 0
	fi

	if [[ -f "${_CLAUDE_CONFIG_LINK}" ]]; then
		log_debug "Moving existing ~/.claude.json into shared volume"
		mv "${_CLAUDE_CONFIG_LINK}" "${_CLAUDE_CONFIG_TARGET}"
	fi

	ln -s "${_CLAUDE_CONFIG_TARGET}" "${_CLAUDE_CONFIG_LINK}"
	log_info "Linked ~/.claude.json → shared volume (onboarding state will persist across rebuilds)"
}

# _log_auth_status: logs whether OAuth credentials are present in the shared volume.
_log_auth_status() {
	if [[ -f "${_CLAUDE_CREDS_FILE}" ]]; then
		log_info "Claude credentials found in shared volume — authentication pre-loaded"
	else
		log_warning "Claude credentials not found — run 'claude login' to authenticate"
	fi
}


# ----- CORE SETUP -------------------------------------------------------------

# claude_ai_setup: Module entry point. Installs the Claude CLI and links config.
claude_ai_setup() {
	local npm_output
	setup_error_traps || true

	if ! check_command "${_CLAUDE_CLI_COMMAND}"; then
		log_info "Installing Claude CLI (${_CLAUDE_INSTALL_NAME})"
		npm_output=$(npm install -g "${_CLAUDE_INSTALL_NAME}" 2>&1) || {
			push_error "$FATAL_ERROR" "${LINENO}" "claude_ai_setup" "npm install -g ${_CLAUDE_INSTALL_NAME}" "Claude CLI installation failed"
			log_error "Claude CLI installation failed"
			log_debug "${npm_output}"
			return 1
		}
		log_debug "${npm_output}"
	else
		log_debug "Claude CLI already installed, skipping"
	fi

	_link_claude_config
	_log_auth_status
}
