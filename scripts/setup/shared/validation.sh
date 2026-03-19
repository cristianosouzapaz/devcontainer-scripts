#!/bin/bash

[[ -n "${_VALIDATION_SH_LOADED:-}" ]] && return 0
readonly _VALIDATION_SH_LOADED=1

# Validation utility functions for checking commands and environment variables

# ----- VALIDATION FUNCTIONS ---------------------------------------------------

# check_command: Checks if a command is available
# Usage: check_command <command_name>
# Returns: 0 if available, 1 if not
check_command() {
	local cmd="$1"
	if command -v "$cmd" >/dev/null 2>&1; then
		log_debug "Command '$cmd' is available"
		return 0
	else
		log_debug "Command '$cmd' is not available"
		return 1
	fi
}

# check_env_var: Checks if an environment variable is set and non-empty
# Usage: check_env_var <var_name>
# Returns: 0 if set, 1 if not
check_env_var() {
	local var_name="$1"
	if [[ -n "${!var_name:-}" ]]; then
		log_debug "Environment variable '$var_name' is set"
		return 0
	else
		log_debug "Environment variable '$var_name' is not set"
		return 1
	fi
}

# repo_entry_folder_name <url>: Extracts the last path segment without the .git extension.
# Used by both 01-git.sh and 05-workspaces.sh to derive the workspace folder name from a clone URL.
# Examples: https://github.com/org/repo.git → repo
#           https://gitlab.com/myorg/my-app  → my-app
repo_entry_folder_name() {
	local url="${1##*/}"
	echo "${url%.git}"
}

# sanitize_string: remove control characters and trim
sanitize_string() {
	local s="$1"
	# remove non-printable characters
	s=$(echo -n "$s" | tr -cd '\11\12\15\40-\176')
	# trim
	s=$(echo -n "$s" | sed -e 's/^\s\+//' -e 's/\s\+$//')
	printf '%s' "$s"
}

# sanitize_env_var: sanitize and export a variable safely
sanitize_env_var() {
	local var_name="$1"
	local val="${!var_name:-}"
	local clean
	clean=$(sanitize_string "$val")
	export "$var_name"="$clean"
}

# validate: Dispatcher for different validation types
# Usage: validate <type> <args...>
validate() {
	local type="$1"
	shift || true
	case "$type" in
	url)
		validate_url "$@"
		;;
	file)
		validate_file "$@"
		;;
	disk_space)
		validate_disk_space "$@"
		;;
	json)
		validate_json "$@"
		;;
	env_var_format)
		validate_env_var_format "$@"
		;;
	*)
		log_debug "Unknown validate type: $type"
		return 2
		;;
	esac
}

# validate_url: validate URL format and optional reachability
# Usage: validate_url <url> [--reachable]
validate_url() {
	local url="$1"
	local reachable=false
	if [[ "${2:-}" == "--reachable" ]]; then
		reachable=true
	fi

	# Basic URL regex (accepts http, https)
	if [[ ! "$url" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?(/.*)?$ ]]; then
		log_debug "URL format invalid: $url"
		return 1
	fi

	if $reachable; then
		if check_command curl; then
			curl -fsS --max-time 5 --head "$url" >/dev/null 2>&1 || return 1
		else
			# Try wget as fallback
			if check_command wget; then
				wget --spider --timeout=5 "$url" >/dev/null 2>&1 || return 1
			else
				log_debug "No HTTP client (curl/wget) available to check reachability"
				return 2
			fi
		fi
	fi
	return 0
}

# validate_file: check existence, readability, writability, executability
# Usage: validate_file <path> [--readable] [--writable] [--executable]
validate_file() {
	local path="$1"
	shift || true
	if [[ ! -e "$path" ]]; then
		log_debug "File does not exist: $path"
		return 1
	fi
	for opt in "$@"; do
		case "$opt" in
		--readable)
			[[ -r "$path" ]] || {
				log_debug "File not readable: $path"
				return 1
			}
			;;
		--writable)
			[[ -w "$path" ]] || {
				log_debug "File not writable: $path"
				return 1
			}
			;;
		--executable)
			[[ -x "$path" ]] || {
				log_debug "File not executable: $path"
				return 1
			}
			;;
		esac
	done
	return 0
}

# validate_disk_space: ensure at least <min_mb> free on filesystem containing <path>
# Usage: validate_disk_space <path> <min_mb>
validate_disk_space() {
	local path="${1:-/}"
	local min_mb="${2:-1}"
	if [[ -z "$path" ]]; then path="/"; fi
	local avail_mb
	avail_mb=$(df -P -m "$path" 2>/dev/null | awk 'END{print $4}') || avail_mb=0
	if [[ -z "$avail_mb" ]]; then avail_mb=0; fi
	if ((avail_mb < min_mb)); then
		log_debug "Insufficient disk space on $path: ${avail_mb}MB available, ${min_mb}MB required"
		return 1
	fi
	return 0
}

# validate_json: check JSON syntax of a file or stdin (-)
# Usage: validate_json <file|- >
validate_json() {
	local target="$1"
	if [[ "$target" == "-" || -z "$target" ]]; then
		if check_command jq; then
			jq -e . >/dev/null 2>&1 || return 1
		else
			python -c 'import sys,json; json.load(sys.stdin)' >/dev/null 2>&1 || return 1
		fi
		return 0
	fi
	if [[ ! -e "$target" ]]; then
		log_debug "JSON file not found: $target"
		return 1
	fi
	if check_command jq; then
		jq -e . "$target" >/dev/null 2>&1 || return 1
	else
		python -c "import json,sys
import io
f=open('$target')
json.load(f)" >/dev/null 2>&1 || return 1
	fi
	return 0
}

# validate_env_var_format: simple format checks for env vars
# Usage: validate_env_var_format <var_name> <type>
validate_env_var_format() {
	local var_name="$1"
	local vtype="$2"
	local val="${!var_name:-}"
	if [[ -z "$val" ]]; then
		log_debug "Environment variable '$var_name' is empty"
		return 1
	fi
	case "$vtype" in
	email)
		if [[ ! "$val" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
			log_debug "Env var $var_name does not match email pattern"
			return 1
		fi
		;;
	url)
		validate_url "$val" || return 1
		;;
	*)
		log_debug "Unknown env var format type: $vtype"
		return 2
		;;
	esac
	return 0
}