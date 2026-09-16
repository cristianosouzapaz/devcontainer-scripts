#!/bin/bash

[[ -n "${_VALIDATION_SH_LOADED:-}" ]] && return 0
readonly _VALIDATION_SH_LOADED=1

# Checks commands, environment variables, URLs, files and JSON, and collects
# numbered configuration variables.

# ----- VALIDATION FUNCTIONS ---------------------------------------------------

# check_command <command_name>: succeeds when the command is available
check_command() {
	local cmd_name="$1"
	if command -v "$cmd_name" >/dev/null 2>&1; then
		log_debug "Command '$cmd_name' is available"
		return 0
	else
		log_debug "Command '$cmd_name' is not available"
		return 1
	fi
}

# check_env_var <var_name>: succeeds when the variable is set and non-empty
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

# collect_numbered_vars <nameref> <prefix> [fallback_var]: appends <prefix>_1, <prefix>_2, … up to the first unset or empty one to the array <nameref>
# Notes: when none is set, appends the value of fallback_var instead, if given and non-empty.
collect_numbered_vars() {
	local -n _out_vals="$1"
	local prefix="$2" fallback_var="${3:-}"
	local i=1 val var

	while true; do
		var="${prefix}_${i}"
		val="${!var:-}"
		[[ -z "$val" ]] && break
		_out_vals+=("$val")
		i=$(( i + 1 ))
	done

	if [[ "${#_out_vals[@]}" -eq 0 && -n "$fallback_var" && -n "${!fallback_var:-}" ]]; then
		_out_vals+=("${!fallback_var}")
	fi
}

# collect_numbered_repo_entries <nameref> [fallback_var]: appends the clone URLs REPO_SOURCE_1, REPO_SOURCE_2, … to the array <nameref>
collect_numbered_repo_entries() {
	collect_numbered_vars "$1" "REPO_SOURCE" "${2:-}"
}

# collect_numbered_extra_folders <nameref>: appends the folder names EXTRA_FOLDER_1, EXTRA_FOLDER_2, … to the array <nameref>
collect_numbered_extra_folders() {
	collect_numbered_vars "$1" "EXTRA_FOLDER"
}

# repo_entry_folder_name <url>: prints the URL's last path segment without .git (https://gitlab.com/org/my-app.git → my-app)
repo_entry_folder_name() {
	local url="${1##*/}"
	echo "${url%.git}"
}

# validate_url <url>: succeeds when the URL is http or https with a host, an optional port and an optional path
validate_url() {
	local url="$1"
	if [[ ! "$url" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?(/.*)?$ ]]; then
		log_debug "URL format invalid: $url"
		return 1
	fi
	return 0
}

# validate_file <path> [--readable] [--writable] [--executable]: succeeds when the path exists and has every requested permission
validate_file() {
	local path="$1" opt
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

# validate_json <file|->: succeeds when the file, or stdin for - or an empty argument, is valid JSON
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
f=open('$target')
json.load(f)" >/dev/null 2>&1 || return 1
	fi
	return 0
}

# validate_env_var_format <var_name> <type>: succeeds when the variable is non-empty and matches <type> (email or url)
# Returns: 1 when it is empty or does not match, 2 for an unknown type.
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

export -f check_command check_env_var collect_numbered_vars collect_numbered_repo_entries collect_numbered_extra_folders repo_entry_folder_name validate_url validate_file validate_json validate_env_var_format
