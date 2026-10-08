# shellcheck shell=bash
[[ -n "${_HERDR_SH_LOADED:-}" ]] && return 0
readonly _HERDR_SH_LOADED=1

# Herdr configuration helpers: config path, initial config, pane XDG reset,
# integration install, the Codex context hook seeding, and the locked apply sequence. They
# live in lib/ because both the herdr setup module and bin/devcontainer-data run them.

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_HERDR_COMMAND="${HERDR_COMMAND:-herdr}"
_HERDR_TEMPLATE="${HERDR_TEMPLATE:-}"
_HERDR_CONFIG_PATH="${HERDR_CONFIG_PATH:-}"
_HERDR_XDG_RESET_ASSET="${HERDR_XDG_RESET_ASSET:-}"
_HERDR_BASHRC_PATH="${HERDR_BASHRC_PATH:-}"
_HERDR_XDG_RESET_MARKER='devcontainer-herdr-xdg-reset'

# ----- HELPER FUNCTIONS -------------------------------------------------------

# herdr_config_path: prints the Herdr config file path, HERDR_CONFIG_PATH or config.toml in the herdr persistent-data category
herdr_config_path() {
	local category_path target

	if [[ -n "$_HERDR_CONFIG_PATH" ]]; then
		printf '%s\n' "$_HERDR_CONFIG_PATH"
		return 0
	fi
	category_path=$(persistent_data_category_path herdr) || return 1
	target=$(inventory_assets categories herdr | jq -r 'select(.id == "config") | .target' | head -n1)
	printf '%s/%s\n' "$category_path" "${target:-config.toml}"
}

# herdr_template_path: resolves the config template shipped by Rebuild Container
herdr_template_path() {
	local template="${_HERDR_TEMPLATE}"
	if [[ -z "${template}" ]]; then
		template=$(inventory_assets categories herdr | jq -r 'select(.id == "config") | .source' | head -n1)
		template="${DEVCONTAINER_ASSETS_DIR}/${template}"
	fi
	if [[ ! -f "${template}" ]]; then
		log_error "Herdr configuration template is missing: ${template}"
		return 1
	fi
	printf '%s\n' "$template"
}

# herdr_metadata_path: keeps managed history outside the user's Herdr configuration
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
	log_detail "Initialized Herdr configuration"
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
	local asset="${_HERDR_XDG_RESET_ASSET}" bashrc_path="${_HERDR_BASHRC_PATH}"
	if [[ -z "${asset}" ]]; then
		asset=$(inventory_assets categories herdr | jq -r 'select(.id == "xdg-reset") | .source' | head -n1)
		asset="${DEVCONTAINER_ASSETS_DIR}/${asset}"
	fi
	if [[ -z "${bashrc_path}" ]]; then
		bashrc_path=$(inventory_assets categories herdr | jq -r 'select(.id == "xdg-reset") | .target' | head -n1)
	fi
	bashrc_path="${bashrc_path:-/etc/bash.bashrc}"
	if [[ ! -f "${asset}" ]]; then
		log_error "Herdr XDG_CONFIG_HOME reset asset is missing: ${asset}"
		return 1
	fi
	if grep -qF "$_HERDR_XDG_RESET_MARKER" "${bashrc_path}" 2>/dev/null; then
		log_debug "Herdr XDG_CONFIG_HOME reset already present, skipping"
		return 0
	fi
	atomic_write "$bashrc_path" herdr_bashrc_with_reset "$bashrc_path" "$asset" || return 1
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
	ids=$(inventory_ids agents)
	[[ -n "$ids" ]] || return 0
	status_output=$("$_HERDR_COMMAND" integration status 2>/dev/null) || status_output=''
	mapfile -t agent_ids <<< "$ids"
	for target in "${agent_ids[@]}"; do
		herdr_integration=$(inventory_fields agents "$target" herdrIntegration)
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

# herdr_seed_codex_context_hook: adds the Codex Stop hook that reports the context row to Herdr's hooks.json, once
# Notes: the entry names a script shipped in the assets dir, so editing the script never
#   changes the hook definition (Codex trusts a hook by a hash of it). Every other key and
#   entry, such as Herdr's SessionStart, is kept; a file that already carries the entry is
#   not rewritten, and one that is not valid JSON is left as it is.
herdr_seed_codex_context_hook() {
	local hooks_file command current updated

	if [[ "$(inventory_fields agents codex herdrIntegration)" != 'true' ]]; then
		log_debug "No Herdr integration declared for codex, skipping the context hook"
		return 0
	fi
	hooks_file="$(persistent_data_category_path codex)/hooks.json" || return 1
	command="bash '${DEVCONTAINER_ASSETS_DIR}/codex/herdr-context-hook.sh'"
	if [[ -f "$hooks_file" ]] && ! jq -e . "$hooks_file" >/dev/null 2>&1; then
		log_error "Codex hooks file is not valid JSON: $hooks_file"
		return 1
	fi
	if [[ -f "$hooks_file" ]] && jq -e --arg c "$command" '[.hooks.Stop[]?.hooks[]? | select(.command == $c)] | length > 0' "$hooks_file" >/dev/null; then
		log_debug "Codex context hook already present, skipping"
		return 0
	fi
	[[ -f "$hooks_file" ]] && current=$(<"$hooks_file") || current='{}'
	updated=$(jq --arg c "$command" '.hooks.Stop += [{hooks: [{type: "command", command: $c, timeout: 10}]}]' <<<"$current") || return 1
	mkdir -p "$(dirname "$hooks_file")" || return 1
	atomic_write "$hooks_file" printf '%s\n' "$updated" || return 1
	log_detail "Added the Codex context hook to $hooks_file"
}

# herdr_apply: installs the pane reset, the project config, the Herdr integrations and the Codex context hook under their locks
# Notes: fails fast when the Herdr CLI is missing, before any lock is taken. The pane
#   reset targets the system-wide bashrc, outside the persistent-data model, so it
#   takes no lock; the config is project data, so it takes the project lock; the
#   integrations and the Codex hook touch shared agent config, so they take the shared then
#   project lock order.
herdr_apply() {
	herdr_require_command || return 1
	herdr_reset_xdg_config_home || return 1
	with_project_data_lock herdr_initialize_config || return 1
	with_shared_data_lock with_project_data_lock herdr_install_integrations || return 1
	with_shared_data_lock with_project_data_lock herdr_seed_codex_context_hook
}

export -f herdr_config_path herdr_template_path herdr_metadata_path herdr_validate_metadata_path herdr_write_managed_config \
	herdr_require_command herdr_initialize_config \
	herdr_install_integrations herdr_seed_codex_context_hook herdr_reset_xdg_config_home herdr_apply
