# shellcheck shell=bash
[[ -n "${_HERDR_SH_LOADED:-}" ]] && return 0
readonly _HERDR_SH_LOADED=1

# Herdr configuration helpers: config path, initial config, pane XDG reset,
# integration install, the agent packs' Herdr hooks, and the locked apply sequence. They
# live in lib/ because both the herdr setup module and bin/devcontainer-data run them.

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_HERDR_COMMAND="${HERDR_COMMAND:-herdr}"
_HERDR_TEMPLATE="${HERDR_TEMPLATE:-}"
_HERDR_CONFIG_PATH="${HERDR_CONFIG_PATH:-}"
_HERDR_XDG_RESET_ASSET="${HERDR_XDG_RESET_ASSET:-}"
_HERDR_BASHRC_PATH="${HERDR_BASHRC_PATH:-}"
_HERDR_XDG_RESET_MARKER='devcontainer-herdr-xdg-reset'
_HERDR_ASSETS_DIR="${DEVCONTAINER_CORE_DIR}/herdr/assets"

# ----- HELPER FUNCTIONS -------------------------------------------------------

# herdr_config_path: prints the Herdr config file path, HERDR_CONFIG_PATH or config.toml in the herdr persistent-data category
# Stdout: the config file path, one line
herdr_config_path() {
	local category_path target

	if [[ -n "$_HERDR_CONFIG_PATH" ]]; then
		printf '%s\n' "$_HERDR_CONFIG_PATH"
		return 0
	fi
	category_path=$(persistent_data_category_path herdr) || return 1
	printf '%s/config.toml\n' "$category_path"
}

# herdr_template_path: resolves the config template shipped by Rebuild Container
# Stdout: the template file path, one line
herdr_template_path() {
	local template="${_HERDR_TEMPLATE:-${_HERDR_ASSETS_DIR}/config.toml}"
	if [[ ! -f "${template}" ]]; then
		log_error "Herdr configuration template is missing: ${template}"
		return 1
	fi
	printf '%s\n' "$template"
}

# herdr_metadata_path: keeps managed history outside the user's Herdr configuration
# Stdout: the metadata directory path, one line
herdr_metadata_path() {
	local root
	root=$(persistent_data_root project) || return 1
	printf '%s/.metadata/herdr\n' "$root"
}

# herdr_validate_metadata_path: refuses redirected managed history before any config or metadata write
herdr_validate_metadata_path() {
	local root root_real metadata
	root=$(persistent_data_root project) || return 1
	root_real=$(realpath -m "$root") || return 1
	metadata=$(herdr_metadata_path) || return 1
	if [[ "$(realpath -m "$metadata")" != "$root_real/.metadata/herdr" ||
		"$(realpath -m "$metadata/config-template.sha256")" != "$root_real/.metadata/herdr/config-template.sha256" ]]; then
		log_error 'Herdr metadata escapes its project path'
		return 1
	fi
}

# herdr_write_managed_config <config_path> <template>: records history only after a successful config write
# Notes: callers hold the project lock; writing history last prevents a failed
#   config write from marking an unwritten template as installed.
herdr_write_managed_config() {
	local config_path="$1" template="$2" metadata hash
	herdr_validate_metadata_path || return 1
	metadata=$(herdr_metadata_path) || return 1
	hash=$(sha256sum < "$template") || return 1
	hash="${hash%% *}"
	mkdir -p "$(dirname "$config_path")" "$metadata" || return 1
	atomic_write "$config_path" cat "$template" || return 1
	atomic_write "$metadata/config-template.sha256" printf '%s\n' "$hash"
}

# herdr_initialize_config: initializes missing config and history without adopting existing user data
herdr_initialize_config() {
	local config_path template

	config_path=$(herdr_config_path) || return 1
	if [[ -f "$config_path" ]]; then
		log_debug "Herdr configuration already exists, skipping"
		return 0
	fi
	template=$(herdr_template_path) || return 1
	herdr_write_managed_config "$config_path" "$template" || return 1
	log_debug "Initialized Herdr configuration at ${config_path}"
}

# herdr_bashrc_with_reset <bashrc_path> <asset>: prints the existing bashrc followed by the reset asset
herdr_bashrc_with_reset() {
	if [[ -e "$1" ]]; then
		cat -- "$1" || return 1
	fi
	cat -- "$2"
}

# herdr_reset_xdg_config_home: appends the XDG_CONFIG_HOME pane-reset snippet to the system-wide bashrc, once
# Notes: the public wrapper narrows XDG_CONFIG_HOME for the herdr server, and every
#   pane it spawns inherits that value, which breaks XDG-aware tools such as gh run
#   inside a pane. The snippet's marker is checked first, so a re-run never
#   duplicates it.
herdr_reset_xdg_config_home() {
	local asset="${_HERDR_XDG_RESET_ASSET:-${_HERDR_ASSETS_DIR}/xdg-reset.sh}" bashrc_path="${_HERDR_BASHRC_PATH:-/etc/bash.bashrc}"
	if [[ ! -f "${asset}" ]]; then
		log_error "Herdr XDG_CONFIG_HOME reset asset is missing: ${asset}"
		return 1
	fi
	if grep -qF "$_HERDR_XDG_RESET_MARKER" "${bashrc_path}" 2>/dev/null; then
		log_debug "Herdr XDG_CONFIG_HOME reset already present, skipping"
		return 0
	fi
	atomic_write "$bashrc_path" herdr_bashrc_with_reset "$bashrc_path" "$asset" || return 1
	log_debug "Installed Herdr XDG_CONFIG_HOME pane reset in ${bashrc_path}"
}

# herdr_require_command: succeeds when the Herdr CLI resolves, logging an error otherwise
# Notes: checked at every boundary that runs the binary, so neither the setup module
#   nor bin/devcontainer-data can reach it unchecked.
herdr_require_command() {
	check_command "$_HERDR_COMMAND" && return 0
	log_error "Herdr command is unavailable: $_HERDR_COMMAND"
	return 1
}

# herdr_integration_ids: prints the IDs of the selected agents whose pack declares a Herdr integration, failing when the inventory is unavailable
# Stdout: one agent ID per line
herdr_integration_ids() {
	inventory_read_selected -r '.agents[] | select(.herdrIntegration == true) | .id'
}

# herdr_install_integrations: installs each selected agent's Herdr integration that is not already current
# Notes: `herdr integration status` is read once and reports a current target as
#   "<target>: current (vN) (<path>)"; a missing, outdated or unreadable status
#   counts as not current, so the integration is (re)installed.
herdr_install_integrations() {
	local target ids status_output
	local -a agent_ids=()

	herdr_require_command || return 1
	ids=$(herdr_integration_ids) || return 1
	[[ -n "$ids" ]] || return 0
	status_output=$("$_HERDR_COMMAND" integration status 2>/dev/null) || status_output=''
	mapfile -t agent_ids <<< "$ids"
	for target in "${agent_ids[@]}"; do
		if grep -q "^${target}: current " <<<"$status_output"; then
			log_debug "Herdr ${target} integration already current, skipping"
			continue
		fi
		spinner_stream log_debug "$_HERDR_COMMAND" integration install "$target" || return 1
	done
}

# herdr_apply_agent_hooks: runs the agent_<id>_herdr hook of each selected pack that declares a Herdr integration and ships one
herdr_apply_agent_hooks() {
	local agent_id hook ids
	local -a agent_ids=()

	ids=$(herdr_integration_ids) || return 1
	[[ -n "$ids" ]] || return 0
	mapfile -t agent_ids <<< "$ids"
	for agent_id in "${agent_ids[@]}"; do
		hook="agent_${agent_id}_herdr"
		declare -F "$hook" >/dev/null || continue
		"$hook" || return 1
	done
}

# herdr_apply: installs the pane reset, the project config, the Herdr integrations and the agents' Herdr hooks under their locks
# Notes: fails fast when the Herdr CLI is missing, before any lock is taken. The pane
#   reset targets the system-wide bashrc, outside the persistent-data model, so it
#   takes no lock; the config is project data, so it takes the project lock; the
#   integrations and the agent hooks touch shared agent config, so they take the shared then
#   project lock order.
herdr_apply() {
	herdr_require_command || return 1
	herdr_reset_xdg_config_home || return 1
	with_project_data_lock herdr_initialize_config || return 1
	with_shared_data_lock with_project_data_lock herdr_install_integrations || return 1
	with_shared_data_lock with_project_data_lock herdr_apply_agent_hooks
}

export -f herdr_config_path herdr_template_path herdr_metadata_path herdr_validate_metadata_path herdr_write_managed_config \
	herdr_require_command herdr_initialize_config \
	herdr_integration_ids herdr_install_integrations herdr_apply_agent_hooks herdr_reset_xdg_config_home herdr_apply
