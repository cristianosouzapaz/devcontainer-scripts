#!/bin/bash

[[ -n "${_MODULE_REGISTRY_SH_LOADED:-}" ]] && return 0
readonly _MODULE_REGISTRY_SH_LOADED=1

# Discovers setup modules from their MODULE_* metadata, orders them by MODULE_AFTER,
# and runs each entry in its own strict-mode subshell.

# ----- INTERNAL HELPERS -------------------------------------------------------

# registry_read_meta <file> <key>: prints the MODULE_<key> metadata value of a module file, without sourcing it
registry_read_meta() {
	local file="$1"
	local key="$2"

	sed -n "s/^# MODULE_${key}=\"\(.*\)\"$/\1/p" "$file" | head -1
}

# registry_validate_meta <file>: checks a module's metadata and filename without sourcing it, logging the first problem found
registry_validate_meta() {
	local file="$1"
	local key value name after file_name dependency

	for key in NAME DESCRIPTION ENTRY AFTER; do
		value="$(registry_read_meta "$file" "$key")"
		if ! grep -q "^# MODULE_${key}=\"" "$file" || [[ -z "$value" && "$key" != 'AFTER' ]]; then
			log_error "Module $(basename "$file"): missing MODULE_${key}"
			return 1
		fi
	done
	name="$(registry_read_meta "$file" 'NAME')"
	file_name="$(basename "$file" .sh)"
	if [[ ! "$name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
		log_error "Module ${file_name}: invalid MODULE_NAME: ${name}"
		return 1
	fi
	if [[ "$file_name" != "$name" ]]; then
		log_error "Module ${file_name}: filename must match MODULE_NAME ${name}"
		return 1
	fi
	after="$(registry_read_meta "$file" 'AFTER')"
	if [[ -n "$after" && ! "$after" =~ ^[a-z0-9]+(-[a-z0-9]+)*(,[a-z0-9]+(-[a-z0-9]+)*)*$ ]]; then
		log_error "Module ${name}: invalid MODULE_AFTER"
		return 1
	fi
	IFS=',' read -r -a dependencies <<<"$after"
	for dependency in "${dependencies[@]}"; do
		[[ -z "$dependency" || "$dependency" != "$name" ]] || {
			log_error "Module ${name}: cannot depend on itself"
			return 1
		}
	done
}

# registry_module_exit: module subshell EXIT handler; stops the spinner and writes the state the module added to run_module's state file
# Notes: the state is NUL-delimited kind/value pairs, so embedded newlines survive.
#   Reads run_module's locals through dynamic scope: state_file, error_start,
#   module_cleanup_start and cleanup_start.
registry_module_exit() {
	local status=$? record
	trap - ERR
	set +e
	spinner_cleanup
	{
		printf 'skip\0%s\0' "${_MODULE_SKIPPED:-}"
		for record in "${_ERROR_STACK[@]:$error_start}"; do
			printf 'error\0%s\0' "$record"
		done
		for record in "${_MODULE_CLEANUP_HANDLERS[@]:$module_cleanup_start}"; do
			printf 'module-cleanup\0%s\0' "$record"
		done
		for record in "${_CLEANUP_HANDLERS[@]:$cleanup_start}"; do
			printf 'cleanup\0%s\0' "$record"
		done
	} >"$state_file"
	return "$status"
}

# ----- PUBLIC FUNCTIONS -------------------------------------------------------

# discover_modules <modules_dir>: sets DISCOVERED_MODULES to the validated module files in dependency order, ties broken by name
discover_modules() {
	local modules_dir="$1"
	local file name dependency candidate selected_name
	local -a names dependencies
	local -A module_files module_after indegree selected

	declare -ga DISCOVERED_MODULES=()
	for file in "$modules_dir"/*.sh; do
		[[ -f "$file" ]] || continue
		registry_validate_meta "$file" || return 1
		# why: no duplicate-name check, registry_validate_meta ties each name to its unique filename
		name="$(registry_read_meta "$file" 'NAME')"
		module_files["$name"]="$file"
		module_after["$name"]="$(registry_read_meta "$file" 'AFTER')"
		names+=("$name")
	done
	if [[ "${#names[@]}" -gt 0 ]]; then
		mapfile -t names < <(printf '%s\n' "${names[@]}" | LC_ALL=C sort)
	fi
	for name in "${names[@]}"; do
		IFS=',' read -r -a dependencies <<<"${module_after[$name]}"
		for dependency in "${dependencies[@]}"; do
			[[ -z "$dependency" ]] && continue
			if [[ -z "${module_files[$dependency]:-}" ]]; then
				log_error "Module ${name}: missing dependency ${dependency}"
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

# run_module <module_file>: sources the module and runs its entry in a strict-mode subshell, then imports the state it added and runs its module cleanups
# Returns: 0 for success or skip, 1 for failure.
# Notes: errexit is off around the bare subshell so the parent captures its status
#   without recording the subshell's ERR, then restored. The state comes back as data
#   read from a file, never shell syntax. Module cleanups run right after the
#   subshell, whatever its status, before the next module runs.
run_module() {
	local module_file="$1"
	local name entry result state_file kind record errexit=false
	local error_start module_cleanup_start cleanup_start
	local _MODULE_WAITING=false

	[[ "$-" != *e* ]] || errexit=true

	name="$(registry_read_meta "$module_file" 'NAME')"
	entry="$(registry_read_meta "$module_file" 'ENTRY')"
	log_info "Running module: ${name}"
	_MODULE_SKIPPED=''
	state_file=$(mktemp) || {
		push_error "$DEVCONTAINER_FATAL_ERROR" "${LINENO}" 'run_module' "$entry" "${name} failed"
		return 1
	}
	# why: modules are discovered at run time and checked as separate ShellCheck targets
	# shellcheck source=/dev/null
	source "$module_file"
	error_start=${#_ERROR_STACK[@]}
	module_cleanup_start=${#_MODULE_CLEANUP_HANDLERS[@]}
	cleanup_start=${#_CLEANUP_HANDLERS[@]}
	set +e
	_MODULE_WAITING=true
	(
		_MODULE_WAITING=false
		set -eEuo pipefail
		shopt -s inherit_errexit
		trap 'handle_error' ERR
		trap 'registry_module_exit' EXIT
		trap 'on_sigint' INT
		trap 'on_sigterm' TERM
		"$entry"
	)
	result=$?
	_MODULE_WAITING=false
	if [[ -f "$state_file" && -r "$state_file" ]]; then
		while IFS= read -r -d '' kind && IFS= read -r -d '' record; do
			case "$kind" in
				skip) _MODULE_SKIPPED=$record ;;
				error) _ERROR_STACK+=("$record") ;;
				module-cleanup) _MODULE_CLEANUP_HANDLERS+=("$record") ;;
				cleanup) _CLEANUP_HANDLERS+=("$record") ;;
			esac
		done <"$state_file"
	fi
	rm -f "$state_file"
	run_module_cleanup_handlers || true
	if "$errexit"; then set -e; else set +e; fi
	if [[ "$result" -ne 0 ]]; then
		log_error "${name} failed"
		push_error "$DEVCONTAINER_FATAL_ERROR" "${LINENO}" 'run_module' "$entry" "${name} failed"
		return 1
	fi
	if [[ "${_MODULE_SKIPPED:-}" == 'true' ]]; then
		log_info "Module ${name} skipped"
	else
		log_success "Module ${name} completed"
	fi
}

# run_all_modules <modules_dir>: validates the whole module plan, then runs each module in order, stopping at the first failure
run_all_modules() {
	local modules_dir="$1"
	local count module completed=0 skipped=0 result errexit=false

	[[ "$-" != *e* ]] || errexit=true

	discover_modules "$modules_dir" || return 1
	count="${#DISCOVERED_MODULES[@]}"
	if [[ "$count" -eq 0 ]]; then
		log_warning "No modules discovered in ${modules_dir}"
		return 0
	fi
	log_info "Discovered ${count} module(s)"
	for module in "${DISCOVERED_MODULES[@]}"; do
		set +e
		run_module "$module"
		result=$?
		if "$errexit"; then set -e; else set +e; fi
		[[ "$result" -eq 0 ]] || return 1
		if [[ "${_MODULE_SKIPPED:-}" == 'true' ]]; then
			(( skipped++ )) || true
		else
			(( completed++ )) || true
		fi
	done
	if [[ "$skipped" -gt 0 ]]; then
		log_success "${completed} module(s) completed, ${skipped} skipped"
	else
		log_success "All ${count} module(s) completed"
	fi
}

export -f registry_module_exit registry_read_meta registry_validate_meta discover_modules run_module run_all_modules
