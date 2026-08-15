#!/bin/bash

[[ -n "${_ENV_LOADER_SH_LOADED:-}" ]] && return 0
readonly _ENV_LOADER_SH_LOADED=1

# Environment file loader - Loads and persists variables from mounted .env file
#
# Usage in .env:
#   PERSIST_CONTEXT7_API_KEY=your-key   # persisted as CONTEXT7_API_KEY
#   GIT_CLONE_TOKEN=secret                          # available during setup only; global fallback
#   GIT_CLONE_TOKEN_GITLAB_EXAMPLE_COM=secret       # per-host override, see 01-git.sh

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_ENV_FILE_PATH="${_ENV_FILE_PATH:-/tmp/.env}"
_ETC_ENVIRONMENT_PATH="${_ETC_ENVIRONMENT_PATH:-/etc/environment}"

# ----- FUNCTIONS --------------------------------------------------------------

# load_env_file: Reads key=value pairs from $_ENV_FILE_PATH and exports them
# into the current shell for use during setup.
# Args: none. Returns: 0 on success (including when file is absent).
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

# persist_env_vars: Writes variables prefixed with PERSIST_ to
# $_ETC_ENVIRONMENT_PATH (default /etc/environment), stripping the prefix so
# they are available to all container processes (including Claude Code)
# after setup. Existing entries for the same key are replaced (idempotent).
# Must be called after load_env_file so PERSIST_* vars are in the environment.
# Args: none. Returns: 0 always.
persist_env_vars() {
	local line key stripped value
	local -a persist_keys=()

	while IFS= read -r line; do
		key="${line%%=*}"
		[[ "$key" == PERSIST_* ]] && persist_keys+=("$key")
	done < <(env)

	if [[ "${#persist_keys[@]}" -eq 0 ]]; then
		log_debug "No PERSIST_* variables found — skipping environment persistence"
		return 0
	fi

	for key in "${persist_keys[@]}"; do
		stripped="${key#PERSIST_}"
		value="${!key}"
		[[ -f "$_ETC_ENVIRONMENT_PATH" ]] && sed -i "/^${stripped}=/d" "$_ETC_ENVIRONMENT_PATH"
		echo "${stripped}=${value}" >> "$_ETC_ENVIRONMENT_PATH"
		log_debug "Persisted: ${stripped}"
	done

	log_success "Persisted ${#persist_keys[@]} variable(s) to /etc/environment"
}

export -f load_env_file persist_env_vars
