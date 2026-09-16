#!/bin/bash

[[ -n "${_ENV_LOADER_SH_LOADED:-}" ]] && return 0
readonly _ENV_LOADER_SH_LOADED=1

# Loads variables from the mounted .env file into the setup shell and persists the
# PERSIST_* ones for every container process.

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_ENV_FILE_PATH="${_ENV_FILE_PATH:-/tmp/.env}"
_ETC_ENVIRONMENT_PATH="${_ETC_ENVIRONMENT_PATH:-/etc/environment}"

# ----- FUNCTIONS --------------------------------------------------------------

# load_env_file: exports the key=value pairs of $_ENV_FILE_PATH into the current shell
# Notes: a line splits at the first =; key and value are trimmed of surrounding
#   whitespace, a trailing CR included, then one matching quote pair is removed from
#   the value; the rest is literal, with no inline comments. Empty keys and # lines
#   are skipped. An empty value is not exported, so a blank never overwrites a set
#   variable. An absent file is not an error.
load_env_file() {
	[[ -f "$_ENV_FILE_PATH" ]] || {
		log_info "No .env file found"
		return 0
	}

	log_info "Loading environment from .env file"

	local line key value
	while IFS= read -r line || [[ -n "$line" ]]; do
		[[ "$line" == *=* ]] || continue
		key="${line%%=*}"
		value="${line#*=}"

		key="${key#"${key%%[![:space:]]*}"}"
		key="${key%"${key##*[![:space:]]}"}"
		value="${value#"${value%%[![:space:]]*}"}"
		value="${value%"${value##*[![:space:]]}"}"

		if [[ "${#value}" -ge 2 && "${value:0:1}" == "${value: -1}" &&
			( "${value:0:1}" == '"' || "${value:0:1}" == "'" ) ]]; then
			value="${value:1:${#value}-2}"
		fi

		[[ -z "$key" || "$key" =~ ^# ]] && continue

		[[ -n "$value" ]] && export "$key"="$value" && log_debug "Loaded: $key"
	done <"$_ENV_FILE_PATH"
	return 0
}

# persist_env_vars: writes each PERSIST_<KEY> variable to $_ETC_ENVIRONMENT_PATH as <KEY>, replacing an existing entry
# Notes: runs after load_env_file, which puts the PERSIST_* variables in the environment.
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
