# shellcheck shell=bash
[[ -n "${_HERDR_SH_LOADED:-}" ]] && return 0
readonly _HERDR_SH_LOADED=1

# Herdr configuration helpers: config path, initial config, pane XDG reset,
# integration install, and the locked apply sequence. They live in lib/ because both
# the herdr setup module and bin/devcontainer-data run them.

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_HERDR_COMMAND="${HERDR_COMMAND:-herdr}"
_HERDR_TEMPLATE="${HERDR_TEMPLATE:-${DEVCONTAINER_ASSETS_DIR}/herdr-config.toml}"
_HERDR_CONFIG_PATH="${HERDR_CONFIG_PATH:-}"
_HERDR_XDG_RESET_ASSET="${HERDR_XDG_RESET_ASSET:-${DEVCONTAINER_ASSETS_DIR}/herdr-xdg-reset.sh}"
_HERDR_BASHRC_PATH="${HERDR_BASHRC_PATH:-/etc/bash.bashrc}"
_HERDR_XDG_RESET_MARKER='devcontainer-herdr-xdg-reset'

# ----- HELPER FUNCTIONS -------------------------------------------------------

# herdr_config_path: prints the Herdr config file path, HERDR_CONFIG_PATH or config.toml in the herdr persistent-data category
herdr_config_path() {
	local category_path

	if [[ -n "$_HERDR_CONFIG_PATH" ]]; then
		printf '%s\n' "$_HERDR_CONFIG_PATH"
		return 0
	fi
	category_path=$(persistent_data_category_path herdr) || return 1
	printf '%s/config.toml\n' "$category_path"
}

# herdr_initialize_config: copies the config template to the config path, only when no config exists there
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
	atomic_write "$config_path" cat "$_HERDR_TEMPLATE" || return 1
	log_detail "Initialized Herdr configuration"
}

# herdr_reset_xdg_config_home: appends the XDG_CONFIG_HOME pane-reset snippet to the system-wide bashrc, once
# Notes: the public wrapper narrows XDG_CONFIG_HOME for the herdr server, and every
#   pane it spawns inherits that value, which breaks XDG-aware tools such as gh run
#   inside a pane. The snippet's marker is checked first, so a re-run never
#   duplicates it.
herdr_reset_xdg_config_home() {
	if [[ ! -f "$_HERDR_XDG_RESET_ASSET" ]]; then
		log_error "Herdr XDG_CONFIG_HOME reset asset is missing: $_HERDR_XDG_RESET_ASSET"
		return 1
	fi
	if grep -qF "$_HERDR_XDG_RESET_MARKER" "$_HERDR_BASHRC_PATH" 2>/dev/null; then
		log_debug "Herdr XDG_CONFIG_HOME reset already present, skipping"
		return 0
	fi
	cat "$_HERDR_XDG_RESET_ASSET" >>"$_HERDR_BASHRC_PATH" || return 1
	log_detail "Installed Herdr XDG_CONFIG_HOME pane reset"
}

# herdr_require_command: succeeds when the Herdr CLI resolves, logging an error otherwise
# Notes: checked at every boundary that runs the binary, so neither the setup module
#   nor bin/devcontainer-data can reach it unchecked.
herdr_require_command() {
	check_command "$_HERDR_COMMAND" && return 0
	log_error "Herdr command is unavailable: $_HERDR_COMMAND"
	return 1
}

# herdr_install_integrations: installs each catalog agent's Herdr integration that is not already current
# Notes: `herdr integration status` is read once and reports a current target as
#   "<target>: current (vN) (<path>)"; a missing, outdated or unreadable status
#   counts as not current, so the integration is (re)installed.
herdr_install_integrations() {
	local target herdr_integration ids status_output
	local -a agent_ids=()

	herdr_require_command || return 1
	ids=$(provisioning_ids agents)
	[[ -n "$ids" ]] || return 0
	status_output=$("$_HERDR_COMMAND" integration status 2>/dev/null) || status_output=''
	mapfile -t agent_ids <<< "$ids"
	for target in "${agent_ids[@]}"; do
		herdr_integration=$(provisioning_fields agents "$target" herdrIntegration)
		if [[ "$herdr_integration" != 'true' ]]; then
			log_debug "No Herdr integration declared for ${target}, skipping"
			continue
		fi
		if grep -q "^${target}: current " <<<"$status_output"; then
			log_debug "Herdr ${target} integration already current, skipping"
			continue
		fi
		spinner_stream log_debug "$_HERDR_COMMAND" integration install "$target" || return 1
	done
}

# herdr_apply: installs the pane reset, then initializes the project config and installs the agent integrations under their locks
# Notes: fails fast when the Herdr CLI is missing, before any lock is taken. The pane
#   reset targets the system-wide bashrc, outside the persistent-data model, so it
#   takes no lock; the config is project data, so it takes the project lock; the
#   integrations touch shared agent config, so they take the shared then the project
#   lock, in that order.
herdr_apply() {
	herdr_require_command || return 1
	herdr_reset_xdg_config_home || return 1
	with_project_data_lock herdr_initialize_config || return 1
	with_shared_data_lock with_project_data_lock herdr_install_integrations
}

export -f herdr_config_path herdr_require_command herdr_initialize_config \
	herdr_install_integrations herdr_reset_xdg_config_home herdr_apply
