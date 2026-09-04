#!/bin/bash
set -euo pipefail

# MODULE_NAME="ngrok"
# MODULE_DESCRIPTION="Configures ngrok authentication token if NGROK_AUTHTOKEN is set"
# MODULE_ENTRY="ngrok_setup"
# MODULE_AFTER="workspaces"

# ----- OVERVIEW ---------------------------------------------------------------
#
# Opt-in: configures the ngrok authentication token, and only when
# NGROK_AUTHTOKEN is set. Absent the token the module skips silently.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../lib" && pwd)/loader.sh"

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# This module uses the following configuration variables:
# - NGROK_AUTHTOKEN (from .config/.env)

# ----- CONSTANTS --------------------------------------------------------------

readonly _NGROK_CONFIG_COMMAND="config add-authtoken"

# ----- CORE SETUP -------------------------------------------------------------

# ngrok_setup: Module entry point.
# Skips when ngrok is not installed or NGROK_AUTHTOKEN is unset.
# Applies the authtoken with retry/backoff; clears NGROK_AUTHTOKEN on exit.
ngrok_setup() {
	local exit_code
	setup_error_traps
	register_cleanup 'unset NGROK_AUTHTOKEN'

	check_command ngrok || {
		log_debug "ngrok not installed"
		module_skip
		return 0
	}

	check_env_var NGROK_AUTHTOKEN || {
		log_debug "NGROK_AUTHTOKEN not set"
		module_skip
		return 0
	}

	start_spinner "Configuring ngrok with authtoken"
	exit_code=0
	spinner_stream log_debug retry_command 3 1 "$(command -v ngrok || echo 'ngrok')" ${_NGROK_CONFIG_COMMAND} "${NGROK_AUTHTOKEN}" || exit_code=$?
	if [[ $exit_code -ne 0 ]]; then
		push_error "$DEVCONTAINER_NETWORK_ERROR" "${LINENO}" "ngrok_setup" "ngrok $_NGROK_CONFIG_COMMAND" "ngrok configuration failed after retries"
		stop_spinner 1
		return 1
	fi
	stop_spinner 0
}

export -f ngrok_setup
