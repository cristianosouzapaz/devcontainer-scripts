# shellcheck shell=bash
[[ -n "${_ENV_LOADER_SH_LOADED:-}" ]] && return 0
readonly _ENV_LOADER_SH_LOADED=1

# Loads variables from the mounted .env file into the setup shell and persists the
# PERSIST_* ones for every container process. Declared module secrets stay in a
# private NUL-delimited archive instead of the orchestrator environment.

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_ENV_FILE_PATH="${_ENV_FILE_PATH:-/tmp/.env}"
_ETC_ENVIRONMENT_PATH="${_ETC_ENVIRONMENT_PATH:-/etc/environment}"
_MODULE_SECRET_FILE="${_MODULE_SECRET_FILE:-}"
declare -ga MODULE_SECRET_PATTERNS=()

# ----- FUNCTIONS --------------------------------------------------------------

# env_loader_secret_matches <key>: reports whether a key matches a declared secret pattern
env_loader_secret_matches() {
	local key="$1" pattern prefix
	for pattern in "${MODULE_SECRET_PATTERNS[@]:-}"; do
		[[ "$key" == "$pattern" ]] && return 0
		[[ "$pattern" == *'*' ]] || continue
		prefix="${pattern%\*}"
		[[ "$key" == "$prefix"* ]] && return 0
	done
	return 1
}

# load_env_file <patterns...>: exports ordinary key=value pairs and archives declared secrets
# Notes: a line splits at the first =; key and value are trimmed of surrounding
#   whitespace, a trailing CR included, then one matching quote pair is removed from
#   the value; the rest is literal, with no inline comments. Empty keys and # lines
#   are skipped. An empty value is not exported, so a blank never overwrites a set
#   variable. An absent file is not an error.
load_env_file() {
	local line key value
	local -A secret_values=()
	local -A secret_keys=()
	if [[ "${#MODULE_SECRET_PATTERNS[@]}" -gt 0 ]]; then
		[[ -z "${_MODULE_SECRET_FILE:-}" ]] || remove_module_secret_file
		_MODULE_SECRET_FILE="$(mktemp "${TMPDIR:-/tmp}/devcontainer-secrets.XXXXXX")" || return 1
		declare -F register_cleanup >/dev/null 2>&1 && register_cleanup remove_module_secret_file
		chmod 600 "$_MODULE_SECRET_FILE"
		while IFS= read -r -d '' line; do
			key="${line%%=*}"; value="${line#*=}"
			if env_loader_secret_matches "$key"; then
				secret_keys["$key"]=1
				secret_values["$key"]="$value"
			fi
		done < <(env -0)
	fi
	[[ -f "$_ENV_FILE_PATH" ]] || {
		log_info "No .env file found"
		for key in "${!secret_values[@]}"; do
			printf '%s\0%s\0' "$key" "${secret_values[$key]}" >>"$_MODULE_SECRET_FILE"
		done
		for key in "${!secret_keys[@]}"; do
			unset "$key" 2>/dev/null || true
		done
		return 0
	}

	log_info "Loading environment from .env file"

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
		[[ "$key" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || continue

		[[ -n "$value" ]] || continue
		if [[ -n "${_MODULE_SECRET_FILE:-}" ]] && env_loader_secret_matches "$key"; then
			secret_values["$key"]="$value"
			secret_keys["$key"]=1
		else
			export "$key"="$value"
		fi
		log_debug "Loaded: $key"
	done <"$_ENV_FILE_PATH"
	if [[ -n "${_MODULE_SECRET_FILE:-}" ]]; then
		for key in "${!secret_values[@]}"; do
			printf '%s\0%s\0' "$key" "${secret_values[$key]}" >>"$_MODULE_SECRET_FILE"
		done
		for key in "${!secret_keys[@]}"; do
			unset "$key" 2>/dev/null || true
		done
	fi
	return 0
}

# remove_module_secret_file: deletes the private secret archive, when present
remove_module_secret_file() {
	[[ -z "${_MODULE_SECRET_FILE:-}" ]] || rm -f -- "$_MODULE_SECRET_FILE"
	_MODULE_SECRET_FILE=''
}

# persist_environment_file: writes the current environment file while replacing persisted entries
persist_environment_file() {
	local line key stripped
	if [[ -f "$_ETC_ENVIRONMENT_PATH" ]]; then
		while IFS= read -r line || [[ -n "$line" ]]; do
			key="${line%%=*}"
			for stripped in "${persist_keys[@]}"; do
				[[ "$key" == "${stripped#PERSIST_}" ]] && continue 2
			done
			printf '%s\n' "$line"
		done <"$_ETC_ENVIRONMENT_PATH"
	fi
	for key in "${persist_keys[@]}"; do
		stripped="${key#PERSIST_}"
		printf '%s=%s\n' "$stripped" "${!key}"
	done
}

# persist_env_vars: writes each PERSIST_<KEY> variable to $_ETC_ENVIRONMENT_PATH as <KEY>, replacing an existing entry
# Notes: runs after load_env_file, which puts the PERSIST_* variables in the environment.
persist_env_vars() {
	local line key
	local -a persist_keys=()

	while IFS= read -r line; do
		key="${line%%=*}"
		[[ "$key" == PERSIST_* ]] && persist_keys+=("$key")
	done < <(env)

	if [[ "${#persist_keys[@]}" -eq 0 ]]; then
		log_debug "No PERSIST_* variables found — skipping environment persistence"
		return 0
	fi

	atomic_write "$_ETC_ENVIRONMENT_PATH" persist_environment_file
	for key in "${persist_keys[@]}"; do
		log_debug "Persisted: ${key#PERSIST_}"
	done

	log_success "Persisted ${#persist_keys[@]} variable(s) to /etc/environment"
}

export -f load_env_file persist_env_vars remove_module_secret_file
