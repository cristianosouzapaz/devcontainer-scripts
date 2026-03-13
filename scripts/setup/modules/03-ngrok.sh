#!/bin/bash
set -euo pipefail

# MODULE_NAME="ngrok"
# MODULE_DESCRIPTION="Configures ngrok authentication token if NGROK_AUTHTOKEN is set"
# MODULE_ENTRY="ngrok_setup"

# Ngrok setup module - Configures ngrok with provided authtoken for tunneling
#
# This module sets up ngrok by adding the authentication token if provided
# via the `NGROK_AUTHTOKEN` environment variable. It uses shared utilities for
# logging, error handling, and command retries.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(dirname "${BASH_SOURCE[0]}")/../shared/loader.sh"

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# This module uses the following configuration variables:
# - NGROK_AUTHTOKEN (from .config/.env)

# ----- CONSTANTS --------------------------------------------------------------

readonly _NGROK_CONFIG_COMMAND="config add-authtoken"

# ----- CORE SETUP -------------------------------------------------------------

# ngrok_setup: Entry point for the ngrok module.
# Registers NGROK_AUTHTOKEN for cleanup, then skips if ngrok is not installed
# or NGROK_AUTHTOKEN is unset. Otherwise applies the authtoken via
# `ngrok config add-authtoken` with retry/backoff.
# Returns: 0 on success or skip, 1 on configuration failure.
ngrok_setup() {
	setup_error_traps || true
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

	log_debug "Configuring ngrok with authtoken"
	retry_command 3 1 "$(command -v ngrok || echo 'ngrok')" ${_NGROK_CONFIG_COMMAND} "${NGROK_AUTHTOKEN}" || {
		push_error "$NETWORK_ERROR" "${LINENO}" "ngrok_setup" "ngrok $_NGROK_CONFIG_COMMAND" "ngrok configuration failed after retries"
		log_error "ngrok configuration failed after retries: check authtoken or network"
		return 1
	}
}
