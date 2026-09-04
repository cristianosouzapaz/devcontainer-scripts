#!/bin/bash

[[ -n "${_MODULE_REGISTRY_SH_LOADED:-}" ]] && return 0
readonly _MODULE_REGISTRY_SH_LOADED=1

# Module Registry - Dynamic dependency-aware discovery and execution of setup modules

# ----- INTERNAL HELPERS -------------------------------------------------------

# registry_read_meta <file> <key>
# Read a MODULE_* metadata value from a file without sourcing it.
registry_read_meta() {
	local file="$1"
	local key="$2"

	sed -n "s/^# MODULE_${key}=\"\(.*\)\"$/\1/p" "$file" | head -1
}

# registry_validate_meta <file>
# Validate required metadata and the module filename without sourcing the file.
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
	if [[ "$file_name" != "$name" && ! "$file_name" =~ ^[0-9][0-9]-$name$ ]]; then
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

# ----- PUBLIC FUNCTIONS -------------------------------------------------------

# discover_modules <modules_dir>: Validates and topologically orders modules.
# Returns: 0 with DISCOVERED_MODULES populated, 1 when the module plan is invalid.
discover_modules() {
	local modules_dir="$1"
	local file name dependency candidate selected_name
	local -a names dependencies
	local -A module_files module_after indegree selected

	declare -ga DISCOVERED_MODULES=()
	for file in "$modules_dir"/*.sh; do
		[[ -f "$file" ]] || continue
		registry_validate_meta "$file" || return 1
		name="$(registry_read_meta "$file" 'NAME')"
		if [[ -n "${module_files[$name]:-}" ]]; then
			log_error "Duplicate module identifier: ${name}"
			return 1
		fi
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

# run_module <module_file>: Sources the module file and calls its declared entry function.
# Returns: the entry function's exit code.
run_module() {
	local module_file="$1"
	local name entry

	name="$(registry_read_meta "$module_file" 'NAME')"
	entry="$(registry_read_meta "$module_file" 'ENTRY')"
	log_info "Running module: ${name}"
	_MODULE_SKIPPED=''
	source "$module_file"
	if ! "$entry"; then
		push_error "$FATAL_ERROR" "${LINENO}" 'run_module' "$entry" "${name} failed"
		return 1
	fi
	if [[ "${_MODULE_SKIPPED:-}" == 'true' ]]; then
		log_info "Module ${name} skipped"
	else
		log_success "Module ${name} completed"
	fi
}

# run_all_modules <modules_dir>: Validates the complete module plan before running it.
# Returns: 0 on success, 1 for an invalid plan or failed module.
run_all_modules() {
	local modules_dir="$1"
	local count module completed=0 skipped=0

	discover_modules "$modules_dir" || return 1
	count="${#DISCOVERED_MODULES[@]}"
	if [[ "$count" -eq 0 ]]; then
		log_warning "No modules discovered in ${modules_dir}"
		return 0
	fi
	log_info "Discovered ${count} module(s)"
	for module in "${DISCOVERED_MODULES[@]}"; do
		run_module "$module" || return 1
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

export -f registry_read_meta registry_validate_meta discover_modules run_module run_all_modules
