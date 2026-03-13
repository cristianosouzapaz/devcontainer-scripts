#!/bin/bash

[[ -n "${_MODULE_REGISTRY_SH_LOADED:-}" ]] && return 0
readonly _MODULE_REGISTRY_SH_LOADED=1

# Module Registry - Dynamic discovery and execution of setup modules
#
# Provides three public functions:
#   discover_modules <dir>  - Populate DISCOVERED_MODULES array from numbered *.sh files
#   run_module <file>       - Source and execute a single module
#   run_all_modules <dir>   - Discover and run all modules in order

# ----- INTERNAL HELPERS -------------------------------------------------------

# _registry_read_meta <file> <key>
# Read a MODULE_* metadata value from a file without sourcing it.
_registry_read_meta() {
	local file="$1"
	local key="$2"
	grep "^# MODULE_${key}=" "$file" | head -1 | sed 's/^# MODULE_[^=]*="\(.*\)"/\1/'
}

# _registry_validate_meta <file>
# Return 0 if all required MODULE_* keys are present, 1 otherwise.
_registry_validate_meta() {
	local file="$1"
	local key
	local val
	for key in NAME DESCRIPTION ENTRY; do
		val="$(_registry_read_meta "$file" "$key")"
		if [[ -z "$val" ]]; then
			log_warning "Module $(basename "$file"): missing MODULE_${key} — skipping"
			return 1
		fi
	done
	return 0
}

# ----- PUBLIC FUNCTIONS -------------------------------------------------------

# discover_modules <modules_dir>
# Finds all [0-9][0-9]-*.sh files, validates their metadata, and populates
# the global DISCOVERED_MODULES array in sorted order.
discover_modules() {
	local modules_dir="$1"
	declare -ga DISCOVERED_MODULES=()

	local file
	for file in "$modules_dir"/[0-9][0-9]-*.sh; do
		[[ -f "$file" ]] || continue
		if _registry_validate_meta "$file"; then
			DISCOVERED_MODULES+=("$file")
		fi
	done
}

# run_module <module_file>
# Sources the module file and calls its declared entry function.
# Returns the entry function's exit code on failure, 0 on success.
run_module() {
	local module_file="$1"

	local name entry
	name="$(_registry_read_meta "$module_file" "NAME")"
	entry="$(_registry_read_meta "$module_file" "ENTRY")"

	log_info "Running module: ${name}"

	_MODULE_SKIPPED=""
	source "$module_file"

	if ! "$entry"; then
		push_error $FATAL_ERROR "${LINENO}" "run_module" "$entry" "${name} failed"
		return 1
	fi

	if [[ "${_MODULE_SKIPPED:-}" == "true" ]]; then
		log_info "Module ${name} skipped"
	else
		log_success "Module ${name} completed"
	fi
	return 0
}

# run_all_modules <modules_dir>
# Discovers and runs all modules in sorted order.
# Fails fast on the first module error.
run_all_modules() {
	local modules_dir="$1"

	discover_modules "$modules_dir"

	local count="${#DISCOVERED_MODULES[@]}"
	if [[ "$count" -eq 0 ]]; then
		log_warning "No modules discovered in ${modules_dir}"
		return 0
	fi

	log_info "Discovered ${count} module(s)"

	local module completed=0 skipped=0
	for module in "${DISCOVERED_MODULES[@]}"; do
		if ! run_module "$module"; then
			return 1
		fi
		if [[ "${_MODULE_SKIPPED:-}" == "true" ]]; then
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
	return 0
}
