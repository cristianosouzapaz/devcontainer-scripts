# shellcheck shell=bash
[[ -n "${_MODULE_REGISTRY_SH_LOADED:-}" ]] && return 0
readonly _MODULE_REGISTRY_SH_LOADED=1

# Discovers setup units from their CORE_* or MODULE_* metadata, orders them by their
# AFTER list, and runs each entry in its own strict-mode subshell, one phase per
# directory: core units first, then the optional modules, which depend only on core.
#
# The runner, and only the runner, writes a unit's start line and its end line; the
# unit writes outcome lines in between. Every warning of the run is collected in the
# runner's warnings file, for the Action needed block of the summary.

# ----- INTERNAL HELPERS -------------------------------------------------------

_MODULE_STATE_FILE=""

# registry_state_file_cleanup: removes the module state archive if setup exits before run_module imports it
registry_state_file_cleanup() {
	if [[ -n "$_MODULE_STATE_FILE" ]]; then
		rm -f "$_MODULE_STATE_FILE" 2>/dev/null || true
		_MODULE_STATE_FILE=""
	fi
}

# registry_warnings_file_start: starts collecting the run's warnings in a temp file removed when setup exits, unless already collecting
registry_warnings_file_start() {
	[[ -z "${_LOG_WARNINGS_FILE:-}" ]] || return 0
	_LOG_WARNINGS_FILE=$(mktemp) || { log_error "Could not create the run's warnings file"; return 1; }
	register_cleanup registry_warnings_file_cleanup
}

# registry_warnings_file_cleanup: removes the run's warnings file when setup exits
registry_warnings_file_cleanup() {
	if [[ -n "${_LOG_WARNINGS_FILE:-}" ]]; then
		rm -f "$_LOG_WARNINGS_FILE" 2>/dev/null || true
		_LOG_WARNINGS_FILE=""
	fi
}

# registry_end_line <name>: logs the end line of a unit that returned 0, from the skip state it reported
# Notes: a skip with a remedy ends in a warning and records the remedy, not the end line
#   itself, for Action needed.
registry_end_line() {
	local name="$1"

	if [[ "${_MODULE_SKIPPED:-}" != 'true' ]]; then
		log_success "${name} done"
	elif [[ -n "${_MODULE_SKIP_ACTION:-}" ]]; then
		log_record_warning "${_MODULE_SKIP_ACTION}"
		_LOG_WARNINGS_FILE='' log_warning "${name} skipped: ${_MODULE_SKIP_REASON:-no reason given}"
	elif [[ -n "${_MODULE_SKIP_REASON:-}" ]]; then
		log_info "${name} skipped: ${_MODULE_SKIP_REASON}"
	else
		log_info "${name} skipped"
	fi
}

# registry_read_meta <file> <key>: prints the CORE_<key> or MODULE_<key> metadata value of a unit file, without sourcing it
# Stdout: the metadata value
registry_read_meta() {
	local file="$1"
	local key="$2"

	sed -n -E "s/^# (CORE|MODULE)_${key}=\"(.*)\"$/\2/p" "$file" | head -1
}

# registry_meta_prefix <file>: prints the metadata prefix a unit file declares: CORE for a core unit, MODULE otherwise
# Stdout: CORE or MODULE
registry_meta_prefix() {
	if grep -q '^# CORE_NAME="' "$1"; then
		printf 'CORE'
	else
		printf 'MODULE'
	fi
}

# registry_validate_secrets_meta <file>: validates exact secret names and suffix-only wildcards
registry_validate_secrets_meta() {
	local file="$1" name secret prefix meta_prefix
	name="$(registry_read_meta "$file" 'NAME')"
	meta_prefix="$(registry_meta_prefix "$file")"
	for secret in $(registry_read_meta "$file" 'SECRETS'); do
		if [[ "$secret" == *'*' ]]; then
			prefix="${secret%\*}"
			[[ "$prefix" =~ ^[a-zA-Z_][a-zA-Z0-9_]*_$ ]] || {
				log_error "Module ${name}: invalid ${meta_prefix}_SECRETS entry ${secret}"
				return 1
			}
		elif [[ ! "$secret" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
			log_error "Module ${name}: invalid ${meta_prefix}_SECRETS entry ${secret}"
			return 1
		fi
	done
}

# registry_validate_persist_meta <file>: checks that the optional PERSIST list names exactly the categories of the unit's <unit>.persist.json, which exists only beside a non-empty list
# Notes: the inventory reads a category only through the list, so a category the file
#   defines but the list omits would silently vanish; both mismatches fail here instead.
registry_validate_persist_meta() {
	local file="$1" name prefix persist persist_file id

	name="$(registry_read_meta "$file" 'NAME')"
	prefix="$(registry_meta_prefix "$file")"
	persist="$(registry_read_meta "$file" 'PERSIST')"
	persist_file="${file%.sh}.persist.json"
	if [[ -z "$persist" ]]; then
		[[ ! -e "$persist_file" ]] && return 0
		log_error "Module ${name}: ${persist_file##*/} exists without ${prefix}_PERSIST"
		return 1
	fi
	for id in $persist; do
		[[ "$id" =~ ^[a-z0-9-]+$ ]] || {
			log_error "Module ${name}: invalid ${prefix}_PERSIST entry ${id}"
			return 1
		}
	done
	if ! jq -e --arg ids "$persist" 'type == "object" and (keys == ($ids | split(" ") | map(select(length > 0)) | sort))' \
		"$persist_file" >/dev/null 2>&1; then
		log_error "Module ${name}: ${prefix}_PERSIST must name exactly the categories of ${persist_file##*/}"
		return 1
	fi
}

# registry_validate_meta <file>: checks a module's metadata and filename without sourcing it, logging the first problem found
registry_validate_meta() {
	local file="$1"
	local key value name after file_name dependency prefix
	local -a dependencies

	prefix="$(registry_meta_prefix "$file")"
	for key in NAME DESCRIPTION ENTRY AFTER SECRETS; do
		value="$(registry_read_meta "$file" "$key")"
		if ! grep -q "^# ${prefix}_${key}=\"" "$file" || [[ -z "$value" && "$key" != 'AFTER' && "$key" != 'SECRETS' ]]; then
			log_error "Module $(basename "$file"): missing ${prefix}_${key}"
			return 1
		fi
	done
	name="$(registry_read_meta "$file" 'NAME')"
	file_name="$(basename "$file" .sh)"
	if [[ ! "$name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
		log_error "Module ${file_name}: invalid ${prefix}_NAME: ${name}"
		return 1
	fi
	if [[ "$file_name" != "$name" ]]; then
		log_error "Module ${file_name}: filename must match ${prefix}_NAME ${name}"
		return 1
	fi
	after="$(registry_read_meta "$file" 'AFTER')"
	if [[ -n "$after" && ! "$after" =~ ^[a-z0-9]+(-[a-z0-9]+)*(,[a-z0-9]+(-[a-z0-9]+)*)*$ ]]; then
		log_error "Module ${name}: invalid ${prefix}_AFTER"
		return 1
	fi
	IFS=',' read -r -a dependencies <<<"$after"
	for dependency in "${dependencies[@]}"; do
		[[ -z "$dependency" || "$dependency" != "$name" ]] || {
			log_error "Module ${name}: cannot depend on itself"
			return 1
		}
	done
	registry_validate_secrets_meta "$file" || return 1
	registry_validate_persist_meta "$file" || return 1
}

# registry_module_exit: module subshell EXIT handler; stops the spinner and writes the state the module added to run_module's state file
# Notes: the state is NUL-delimited kind/value pairs, so embedded newlines survive.
#   Reads run_module's local state_file through dynamic scope.
registry_module_exit() {
	local status=$? errexit=false
	[[ "$-" != *e* ]] || errexit=true
	trap - ERR
	set +e
	spinner_cleanup
	registry_module_state >"$state_file"
	if "$errexit"; then set -e; else set +e; fi
	return "$status"
}

# registry_module_state: lists the state a module subshell added, for registry_module_exit
# Stdout: NUL-delimited kind/value pairs: skip, skip-reason and skip-action once, then error, module-cleanup and cleanup per record
# Notes: reads run_module's locals through dynamic scope: error_start, module_cleanup_start
#   and cleanup_start.
registry_module_state() {
	local record
	printf 'skip\0%s\0' "${_MODULE_SKIPPED:-}"
	printf 'skip-reason\0%s\0' "${_MODULE_SKIP_REASON:-}"
	printf 'skip-action\0%s\0' "${_MODULE_SKIP_ACTION:-}"
	for record in "${_ERROR_STACK[@]:$error_start}"; do
		printf 'error\0%s\0' "$record"
	done
	for record in "${_MODULE_CLEANUP_HANDLERS[@]:$module_cleanup_start}"; do
		printf 'module-cleanup\0%s\0' "$record"
	done
	for record in "${_CLEANUP_HANDLERS[@]:$cleanup_start}"; do
		printf 'cleanup\0%s\0' "$record"
	done
}

# ----- PUBLIC FUNCTIONS -------------------------------------------------------

# discover_modules <unit_dir>...: sets DISCOVERED_MODULES to the validated unit files of every directory, phase by phase in argument order, each phase in dependency order with ties broken by name
# Notes: a unit may depend only on units of the first directory, the core, so every
#   later phase runs after all its dependencies and no optional module depends on another.
discover_modules() {
	local first_dir="$1"
	local unit_dir file name dependency candidate selected_name secret
	local -a names phase_names dependencies
	local -A module_files module_after module_dirs indegree selected

	declare -ga DISCOVERED_MODULES=()
	MODULE_SECRET_PATTERNS=()
	for unit_dir in "$@"; do
		phase_names=()
		for file in "$unit_dir"/*.sh; do
			[[ -f "$file" ]] || continue
			registry_validate_meta "$file" || return 1
			name="$(registry_read_meta "$file" 'NAME')"
			# why: the filename ties a name to one file per directory, not across phase directories
			if [[ -n "${module_files[$name]:-}" ]]; then
				log_error "Module ${name}: declared in more than one phase"
				return 1
			fi
			module_files["$name"]="$file"
			module_dirs["$name"]="$unit_dir"
			module_after["$name"]="$(registry_read_meta "$file" 'AFTER')"
			while IFS= read -r secret; do
				[[ -n "$secret" ]] && MODULE_SECRET_PATTERNS+=("$secret")
			done < <(registry_read_meta "$file" 'SECRETS' | tr ' ' '\n')
			phase_names+=("$name")
		done
		if [[ "${#phase_names[@]}" -gt 0 ]]; then
			mapfile -t phase_names < <(printf '%s\n' "${phase_names[@]}" | LC_ALL=C sort)
			names+=("${phase_names[@]}")
		fi
	done
	for name in "${names[@]}"; do
		IFS=',' read -r -a dependencies <<<"${module_after[$name]}"
		for dependency in "${dependencies[@]}"; do
			[[ -z "$dependency" ]] && continue
			if [[ -z "${module_files[$dependency]:-}" ]]; then
				log_error "Module ${name}: missing dependency ${dependency}"
				return 1
			fi
			if [[ "${module_dirs[$dependency]}" != "$first_dir" ]]; then
				log_error "Module ${name}: dependency ${dependency} is not a core unit"
				return 1
			fi
			indegree["$name"]=$(( ${indegree[$name]:-0} + 1 ))
		done
	done
	while [[ "${#DISCOVERED_MODULES[@]}" -lt "${#names[@]}" ]]; do
		selected_name=''
		for candidate in "${names[@]}"; do
			if [[ -z "${selected[$candidate]:-}" && "${indegree[$candidate]:-0}" -eq 0 ]]; then
				selected_name="$candidate"
				break
			fi
		done
		if [[ -z "$selected_name" ]]; then
			log_error 'Module dependency cycle detected'
			return 1
		fi
		selected["$selected_name"]=1
		DISCOVERED_MODULES+=("${module_files[$selected_name]}")
		for candidate in "${names[@]}"; do
			IFS=',' read -r -a dependencies <<<"${module_after[$candidate]}"
			for dependency in "${dependencies[@]}"; do
				[[ "$dependency" == "$selected_name" ]] || continue
				indegree["$candidate"]=$(( ${indegree[$candidate]:-0} - 1 ))
			done
		done
	done
}

# registry_inject_module_secrets <module_file>: exports only the module's archived secrets
registry_inject_module_secrets() {
	local module_file="$1" key value pattern prefix secret
	local -a module_secrets=()
	[[ -r "${_MODULE_SECRET_FILE:-}" ]] || return 0
	while IFS= read -r secret; do
		[[ -n "$secret" ]] && module_secrets+=("$secret")
	done < <(registry_read_meta "$module_file" 'SECRETS' | tr ' ' '\n')
	while IFS= read -r -d '' key && IFS= read -r -d '' value; do
		for pattern in "${module_secrets[@]}"; do
			if [[ "$key" == "$pattern" ]] || { [[ "$pattern" == *'*' ]] && prefix="${pattern%\*}" && [[ "$key" == "$prefix"* ]]; }; then
				export "$key=$value"
				break
			fi
		done
	done <"$_MODULE_SECRET_FILE"
}

# run_module <module_file>: sources the module and runs its entry in a strict-mode subshell, then imports the state it added and runs its module cleanups
# Returns: 0 for success or skip, 1 for failure.
# Notes: errexit is off around the bare subshell so the parent captures its status
#   without recording the subshell's ERR, then restored. The state comes back as data
#   read from a file, never shell syntax. Module cleanups run right after the
#   subshell, whatever its status, before the next module runs.
run_module() {
	local module_file="$1"
	local name entry result state_file kind record secret errexit=false
	local error_start module_cleanup_start cleanup_start
	# shellcheck disable=SC2034 # consumed by error-handler.sh through Bash dynamic scope
	local module_waiting=false direct_environment=false

	[[ "$-" != *e* ]] || errexit=true

	name="$(registry_read_meta "$module_file" 'NAME')"
	entry="$(registry_read_meta "$module_file" 'ENTRY')"
	if [[ ! -r "${_MODULE_SECRET_FILE:-}" ]]; then
		registry_validate_secrets_meta "$module_file" || return 1
		MODULE_SECRET_PATTERNS=()
		while IFS= read -r secret; do
			[[ -n "$secret" ]] && MODULE_SECRET_PATTERNS+=("$secret")
		done < <(registry_read_meta "$module_file" 'SECRETS' | tr ' ' '\n')
		load_env_file
		persist_env_vars
		direct_environment=true
	fi
	_LOG_MODULE="$name"
	log_info "$name"
	_MODULE_SKIPPED=''
	_MODULE_SKIP_REASON=''
	_MODULE_SKIP_ACTION=''
	state_file=$(mktemp) || {
		_LOG_MODULE=''
		push_error "$DEVCONTAINER_FATAL_ERROR" "${LINENO}" 'run_module' "$entry" "${name} failed"
		return 1
	}
	_MODULE_STATE_FILE="$state_file"
	register_cleanup registry_state_file_cleanup
	# why: modules are discovered at run time and checked as separate ShellCheck targets
	# shellcheck source=/dev/null
	source "$module_file"
	error_start=${#_ERROR_STACK[@]}
	module_cleanup_start=${#_MODULE_CLEANUP_HANDLERS[@]}
	cleanup_start=${#_CLEANUP_HANDLERS[@]}
	set +e
	# shellcheck disable=SC2034 # consumed by error-handler.sh through Bash dynamic scope
	module_waiting=true
	(
		# shellcheck disable=SC2034 # consumed by error-handler.sh through Bash dynamic scope
		module_waiting=false
		set -eEuo pipefail
		shopt -s inherit_errexit
		trap 'handle_error' ERR
		trap 'registry_module_exit' EXIT
		trap 'on_sigint' INT
		trap 'on_sigterm' TERM
		registry_inject_module_secrets "$module_file"
		"$entry"
	)
	result=$?
	# shellcheck disable=SC2034 # consumed by error-handler.sh through Bash dynamic scope
	module_waiting=false
	if [[ -f "$state_file" && -r "$state_file" ]]; then
		while IFS= read -r -d '' kind && IFS= read -r -d '' record; do
			case "$kind" in
				skip) _MODULE_SKIPPED=$record ;;
				skip-reason) _MODULE_SKIP_REASON=$record ;;
				skip-action) _MODULE_SKIP_ACTION=$record ;;
				error) _ERROR_STACK+=("$record") ;;
				module-cleanup) _MODULE_CLEANUP_HANDLERS+=("$record") ;;
				cleanup) _CLEANUP_HANDLERS+=("$record") ;;
			esac
		done <"$state_file"
	fi
	rm -f "$state_file"
	_MODULE_STATE_FILE=""
	if "$direct_environment"; then remove_module_secret_file; fi
	run_module_cleanup_handlers || true
	if "$errexit"; then set -e; else set +e; fi
	if [[ "$result" -ne 0 ]]; then
		log_error "${name} failed"
		_LOG_MODULE=''
		push_error "$DEVCONTAINER_FATAL_ERROR" "${LINENO}" 'run_module' "$entry" "${name} failed"
		return 1
	fi
	registry_end_line "$name"
	_LOG_MODULE=''
}

# run_all_modules <unit_dir>...: validates the whole plan, then runs each directory as a phase opened by its header, each unit in order, stopping at the first failure
# Notes: sets MODULE_STATES to one "<name>|on" or "<name>|off (<reason>)" record per
#   unit of a phase after the first, the optional modules, for print_module_states, and
#   FAILED_MODULE to the unit that failed. Starts the run's warnings file, kept until
#   setup exits so print_action_needed can read it.
run_all_modules() {
	local first_dir="$1"
	local unit_dir phase module name result errexit=false

	[[ "$-" != *e* ]] || errexit=true

	declare -ga MODULE_STATES=()
	# shellcheck disable=SC2034 # consumed by devcontainer-setup.sh for its closing line
	FAILED_MODULE=''
	registry_warnings_file_start || return 1
	discover_modules "$@" || return 1
	if [[ "${#DISCOVERED_MODULES[@]}" -eq 0 ]]; then
		log_warning "No setup units found in $*"
		return 0
	fi
	log_debug "Discovered ${#DISCOVERED_MODULES[@]} unit(s)"
	for unit_dir in "$@"; do
		phase="${unit_dir##*/}"
		log_phase "${phase^}"
		for module in "${DISCOVERED_MODULES[@]}"; do
			[[ "${module%/*}" == "$unit_dir" ]] || continue
			name="$(registry_read_meta "$module" 'NAME')"
			set +e
			run_module "$module"
			result=$?
			if "$errexit"; then set -e; else set +e; fi
			if [[ "$result" -ne 0 ]]; then
				# shellcheck disable=SC2034 # consumed by devcontainer-setup.sh for its closing line
				FAILED_MODULE="$name"
				return 1
			fi
			[[ "$unit_dir" != "$first_dir" ]] || continue
			if [[ "${_MODULE_SKIPPED:-}" == 'true' ]]; then
				MODULE_STATES+=("${name}|off (${_MODULE_SKIP_REASON:-no reason given})")
			else
				MODULE_STATES+=("${name}|on")
			fi
		done
	done
}

# print_module_states: logs the Modules block of the summary, each optional module of the last run_all_modules as on, or off with its reason, nothing when there is none
print_module_states() {
	local record name state width=0 row
	local -a states=("${MODULE_STATES[@]+"${MODULE_STATES[@]}"}")

	((${#states[@]} == 0)) && return 0
	for record in "${states[@]}"; do
		name="${record%%|*}"
		((${#name} > width)) && width=${#name}
	done
	log_info 'Modules'
	for record in "${states[@]}"; do
		name="${record%%|*}"
		state="${record#*|}"
		printf -v row '%-*s  %s' "$width" "$name" "$state"
		if [[ "$state" == 'on' ]]; then
			log_item_success "$row"
		else
			log_item_info "$row"
		fi
	done
}

# print_action_needed [action...]: logs the Action needed block of the summary: every warning of the run, then each given action, nothing when there is none
print_action_needed() {
	local line
	local -a actions=()

	if [[ -n "${_LOG_WARNINGS_FILE:-}" && -f "$_LOG_WARNINGS_FILE" ]]; then
		while IFS= read -r line; do
			[[ -n "$line" ]] && actions+=("$line")
		done <"$_LOG_WARNINGS_FILE"
	fi
	actions+=("$@")
	((${#actions[@]} == 0)) && return 0
	# why: these lines repeat warnings already collected, so they must not be collected again
	_LOG_WARNINGS_FILE='' log_warning "Action needed: ${#actions[@]}"
	for line in "${actions[@]}"; do
		_LOG_WARNINGS_FILE='' log_item_warning "$line"
	done
}

export -f registry_warnings_file_start registry_warnings_file_cleanup registry_end_line print_action_needed registry_module_exit registry_module_state registry_meta_prefix registry_read_meta registry_validate_secrets_meta registry_validate_persist_meta registry_validate_meta discover_modules registry_inject_module_secrets run_module run_all_modules print_module_states
