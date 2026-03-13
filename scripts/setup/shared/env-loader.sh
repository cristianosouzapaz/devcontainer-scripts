#!/bin/bash

[[ -n "${_ENV_LOADER_SH_LOADED:-}" ]] && return 0
readonly _ENV_LOADER_SH_LOADED=1

# Environment file loader - Loads variables from mounted .env file
#
# This module provides a small, safe loader for environment variables
# stored in a simple key=value file (commonly named `.env`). It strips
# carriage returns, ignores comments and blank lines, and exports any
# non-empty values into the current shell environment.

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_ENV_FILE_PATH="${_ENV_FILE_PATH:-/tmp/.env}"

# ----- FUNCTIONS --------------------------------------------------------------

# load_env_file: Load environment variables from a file into the current shell.
# Usage: load_env_file
# Behavior:
#   - If `$_ENV_FILE_PATH` does not exist, logs an informational message and
#     returns 0 (no-op).
#   - Reads the file line-by-line, parsing `key=value` pairs.
#   - Strips Windows-style carriage returns and surrounding whitespace.
#   - Ignores blank lines and lines starting with `#`.
#   - Exports variables with non-empty values and logs a debug message
#     for each loaded key.
# Args: none
# Returns:
#   0 on success (including when file is absent), non-zero only if an
#   unexpected error occurs while reading the file.
load_env_file() {
	[[ -f "$_ENV_FILE_PATH" ]] || {
		log_info "No .env file found"
		return 0
	}

	log_info "Loading environment from .env file"

	local key
	local value
	while IFS='=' read -r key value || [[ -n "$key" ]]; do
		# normalize and trim
		key=$(echo "$key" | tr -d '\r' | xargs)
		value=$(echo "$value" | tr -d '\r' | xargs)

		# skip empty keys and comments
		[[ -z "$key" || "$key" =~ ^# ]] && continue

		# only export non-empty values to avoid overwriting with blanks
		[[ -n "$value" ]] && export "$key"="$value" && log_debug "Loaded: $key"
	done <"$_ENV_FILE_PATH"
}
