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
_HERDR_XDG_RESET_ASSET="${HERDR_XDG_RESET_ASSET:-${DEVCONTAINER_ASSETS_DIR}/herdr-xdg-reset.sh}"
_HERDR_BASHRC_PATH="${HERDR_BASHRC_PATH:-/etc/bash.bashrc}"
_HERDR_XDG_RESET_MARKER='devcontainer-herdr-xdg-reset'

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

# herdr_reset_xdg_config_home: Appends the XDG_CONFIG_HOME pane-reset snippet to the
# system-wide bashrc, once. The public wrapper narrows XDG_CONFIG_HOME for the
# herdr server process, and every pane it spawns afterwards inherits that value
# via ordinary process env inheritance, which breaks XDG-aware tools (gh, etc.)
# run inside a pane (see docs/wiki/setup/herdr.md). Idempotent: skips when the
# snippet is already present, so a re-run never duplicates it.
# Returns: 0 on success, 1 when the snippet asset is missing.
herdr_reset_xdg_config_home() {
	if [[ ! -f "$_HERDR_XDG_RESET_ASSET" ]]; then
		log_error "Herdr XDG_CONFIG_HOME reset asset is missing: $_HERDR_XDG_RESET_ASSET"
		return 1
	fi
	if grep -qF "$_HERDR_XDG_RESET_MARKER" "$_HERDR_BASHRC_PATH" 2>/dev/null; then
		log_debug "Herdr XDG_CONFIG_HOME reset already present, skipping"
		return 0
	fi
	cat "$_HERDR_XDG_RESET_ASSET" >>"$_HERDR_BASHRC_PATH"
	log_detail "Installed Herdr XDG_CONFIG_HOME pane reset"
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

# herdr_integration_current: Succeeds when `herdr integration status` reports
# the target as current ("<target>: current (vN) (<path>)"). A missing, outdated
# or unreadable status counts as not current, so the caller (re)installs it.
# Arguments: $1 - integration target.
# Returns: 0 when current, 1 otherwise.
herdr_integration_current() {
	local target="$1" status_output

	status_output=$("$_HERDR_COMMAND" integration status 2>/dev/null) || {
		log_debug "Herdr integration status unavailable, treating ${target} as not current"
		return 1
	}
	grep -q "^${target}: current " <<<"$status_output"
}

# herdr_install_integrations: Installs each supported agent integration that is
# not already current; a current one is left untouched.
# Returns: 0 on success, 1 when the Herdr CLI is missing or an install fails.
herdr_install_integrations() {
	local target

	herdr_require_command || return 1
	for target in claude codex pi; do
		if herdr_integration_current "$target"; then
			log_debug "Herdr ${target} integration already current, skipping"
			continue
		fi
		spinner_stream log_debug "$_HERDR_COMMAND" integration install "$target" || return 1
	done
}

# herdr_apply: Installs the XDG_CONFIG_HOME pane reset, then initializes the
# project config and installs the agent integrations under the required locks.
# Fails fast when the Herdr CLI is missing, before any lock is taken. The pane
# reset targets the system-wide bashrc, outside the persistent-data model, so
# it takes no lock; the project configuration is initialized under the project
# lock only, while installing the integrations touches shared agent config, so
# it takes the shared then project lock, in that order (see
# docs/wiki/setup/persistent-data-locks.md).
# Returns: 0 on success, 1 when the reset, configuration, or integration setup fails.
herdr_apply() {
	herdr_require_command || return 1
	herdr_reset_xdg_config_home || return 1
	with_project_data_lock herdr_initialize_config || return 1
	with_shared_data_lock with_project_data_lock herdr_install_integrations
}

export -f herdr_config_path herdr_require_command herdr_initialize_config \
	herdr_integration_current herdr_install_integrations herdr_reset_xdg_config_home herdr_apply
