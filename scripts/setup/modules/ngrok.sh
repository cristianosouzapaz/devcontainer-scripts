#!/bin/bash
set -euo pipefail

# MODULE_NAME="ngrok"
# MODULE_DESCRIPTION="Configures ngrok authentication token if NGROK_AUTHTOKEN is set"
# MODULE_ENTRY="ngrok_setup"
# MODULE_AFTER="workspaces"
# MODULE_SECRETS="NGROK_AUTHTOKEN"

# ----- OVERVIEW ---------------------------------------------------------------
#
# Opt-in: configures the ngrok authentication token when ngrok is installed and
# NGROK_AUTHTOKEN is set, and skips otherwise.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../lib" && pwd)/loader.sh"

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# Documented in README.md#configuration-variables:
# - NGROK_AUTHTOKEN

# ----- INTERNAL CONSTANTS -----------------------------------------------------

readonly -a _NGROK_CONFIG_COMMAND=(config add-authtoken)

# ----- CORE SETUP -------------------------------------------------------------

# ngrok_setup: module entry; applies NGROK_AUTHTOKEN to the ngrok config with retries, skipping when ngrok or the token is missing
# Notes: the registry injects the token only into this module's subshell.
ngrok_setup() {
	local exit_code

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
	spinner_stream log_debug retry_command 3 1 "$(command -v ngrok || echo 'ngrok')" "${_NGROK_CONFIG_COMMAND[@]}" "${NGROK_AUTHTOKEN}" || exit_code=$?
	if [[ $exit_code -ne 0 ]]; then
		push_error "$DEVCONTAINER_NETWORK_ERROR" "${LINENO}" "ngrok_setup" "ngrok ${_NGROK_CONFIG_COMMAND[*]}" "ngrok configuration failed after retries"
		stop_spinner 1
		return 1
	fi
	stop_spinner 0
}

export -f ngrok_setup
