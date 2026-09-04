#!/bin/bash

[[ -n "${_HERDR_SH_LOADED:-}" ]] && return 0
readonly _HERDR_SH_LOADED=1

# Reusable Herdr configuration helpers: config path resolution, initial config
# copy, integration install, and the locked apply sequence. Shared by the herdr
# setup module and bin/devcontainer-data. The discoverable module keeps only its
# MODULE_* metadata and the herdr_setup entry point.

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_HERDR_COMMAND="${HERDR_COMMAND:-herdr}"
_HERDR_TEMPLATE="${HERDR_TEMPLATE:-${DEVCONTAINER_ASSETS_DIR}/herdr-config.toml}"
_HERDR_CONFIG_PATH="${HERDR_CONFIG_PATH:-}"

# ----- HELPER FUNCTIONS -----------------------------------------------------

# herdr_config_path: Prints the Herdr configuration file path.
herdr_config_path() {
	local category_path

	if [[ -n "$_HERDR_CONFIG_PATH" ]]; then
		printf '%s\n' "$_HERDR_CONFIG_PATH"
		return 0
	fi
	category_path=$(persistent_data_category_path herdr) || return 1
	printf '%s/config.toml\n' "$category_path"
}

# herdr_initialize_config: Copies the initial config only when the user has none.
herdr_initialize_config() {
	local config_path

	config_path=$(herdr_config_path) || return 1
	if [[ -f "$config_path" ]]; then
		log_debug "Herdr configuration already exists, skipping"
		return 0
	fi
	if [[ ! -f "$_HERDR_TEMPLATE" ]]; then
		log_error "Herdr configuration template is missing: $_HERDR_TEMPLATE"
		return 1
	fi
	mkdir -p "$(dirname "$config_path")" || return 1
	cp "$_HERDR_TEMPLATE" "$config_path"
	log_detail "Initialized Herdr configuration"
}

# herdr_require_command: Fails with a user-facing message when the Herdr CLI is
# unavailable. Guarded at every boundary that runs the binary so no caller — the
# setup module or bin/devcontainer-data — can reach it unchecked.
# Returns: 0 when the command resolves, 1 otherwise.
herdr_require_command() {
	check_command "$_HERDR_COMMAND" && return 0
	log_error "Herdr command is unavailable: $_HERDR_COMMAND"
	return 1
}

# herdr_install_integrations: Installs the supported agent integrations.
herdr_install_integrations() {
	herdr_require_command || return 1
	spinner_stream log_debug "$_HERDR_COMMAND" integration install claude || return 1
	spinner_stream log_debug "$_HERDR_COMMAND" integration install codex
}

# herdr_apply: Initializes the project config and installs the agent integrations
# under the required locks. Fails fast when the Herdr CLI is missing, before any
# lock is taken. The project configuration is initialized under the project lock
# only; installing the integrations touches shared Claude/Codex config, so it
# takes the shared then project lock, in that order (see
# docs/wiki/setup/persistent-data.md).
# Returns: 0 on success, 1 when configuration or integration setup fails.
herdr_apply() {
	herdr_require_command || return 1
	with_project_data_lock herdr_initialize_config || return 1
	with_shared_data_lock with_project_data_lock herdr_install_integrations
}

export -f herdr_config_path herdr_require_command herdr_initialize_config \
	herdr_install_integrations herdr_apply
