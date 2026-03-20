#!/bin/bash
set -euo pipefail

# MODULE_NAME="claude-ai"
# MODULE_DESCRIPTION="Installs the Claude AI CLI via npm if not already present"
# MODULE_ENTRY="claude_ai_setup"

# Claude AI CLI installer module
#
# This module ensures that the Claude AI command‑line client is installed in the
# devcontainer environment. Installation is mandatory: if the install fails,
# setup is aborted. Shared utilities provide logging, error handling, and
# dependency checks.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(dirname "${BASH_SOURCE[0]}")/../shared/loader.sh"

# ----- CONSTANTS --------------------------------------------------------------

readonly _CLAUDE_CLI_COMMAND="claude"
readonly _CLAUDE_INSTALL_NAME="@anthropic-ai/claude-code"

# ----- HELPER FUNCTIONS -------------------------------------------------------

# _log_auth_status: logs whether Claude OAuth credentials are present in the
# shared volume mounted at /root/.claude. Informational only; does not fail.
_log_auth_status() {
	local creds_file="/root/.claude/.credentials.json"
	if [[ -f "${creds_file}" ]]; then
		log_info "Claude credentials found in shared volume — authentication pre-loaded"
	else
		log_warning "Claude credentials not found — run 'claude login' to authenticate"
	fi
}

# ----- CORE SETUP -------------------------------------------------------------

# claude_ai_setup: Module entry point.
# Skips when the claude CLI is already present. Fails hard on install failure.
# Logs whether OAuth credentials exist in the shared volume after install/skip.
claude_ai_setup() {
	local npm_output
	setup_error_traps || true

	check_command "${_CLAUDE_CLI_COMMAND}" && {
		log_debug "Claude CLI already installed, skipping"
		_log_auth_status
		return 0
	}

	log_info "Installing Claude CLI (${_CLAUDE_INSTALL_NAME})"
	npm_output=$(npm install -g "${_CLAUDE_INSTALL_NAME}" 2>&1) || {
		push_error "$FATAL_ERROR" "${LINENO}" "claude_ai_setup" "npm install -g ${_CLAUDE_INSTALL_NAME}" "Claude CLI installation failed"
		log_error "Claude CLI installation failed"
		log_debug "${npm_output}"
		return 1
	}
	log_debug "${npm_output}"
	_log_auth_status
}
