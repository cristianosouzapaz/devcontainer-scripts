# shellcheck shell=bash

# Pi's pack hooks: what its agent.json cannot express. Sourced by the inventory
# library, so every consumer of the inventory sees them.

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# - PI_CODING_AGENT_DIR: Pi's own agent directory holding auth.json (default ~/.pi/agent)

# ----- HOOKS ------------------------------------------------------------------

# agent_pi_settings_file: prints the settings.json path the pack's settings asset targets
# Stdout: the settings file path, one line; nothing when the pack declares no settings asset
agent_pi_settings_file() {
	local asset

	asset=$(agent_asset pi settings)
	[[ -n "${asset}" ]] || return 0
	asset_target pi "${asset}"
}

# agent_pi_configure: deploys Pi's managed files and installs the pack's packages Pi does not carry yet
agent_pi_configure() {
	local pi_command assets asset settings_file source destination changed=false
	local current_settings missing package verb
	local -a packages=() missing_packages=()

	pi_command=$(inventory_fields agents pi command)
	assets=$(inventory_assets pi) || return 1
	while IFS= read -r asset; do
		[[ -n "${asset}" ]] || continue
		case "$(jq -r '.type' <<<"${asset}")" in
		package) packages+=("$(jq -r '.source' <<<"${asset}")") ;;
		managed-file)
			source=$(inventory_asset_source pi "${asset}")
			destination=$(asset_target pi "${asset}")
			verb='Deployed'
			[[ ! -f "${destination}" ]] || verb='Updated'
			deploy_managed_file "${source}" "${destination}" changed
			if [[ "${changed}" == 'true' ]]; then
				log_debug "${verb} Pi ${destination}"
			fi
			;;
		esac
	done <<<"${assets}"
	settings_file=$(agent_pi_settings_file)
	if [[ -z "${settings_file}" ]]; then
		log_debug 'No Pi settings asset declared, skipping Pi packages'
		return 0
	fi
	if [[ -f "${settings_file}" ]] && ! jq -e . "${settings_file}" >/dev/null 2>&1; then
		log_item_warning 'Pi settings.json is malformed — skipping Pi packages'
		return 0
	fi
	[[ ${#packages[@]} -gt 0 ]] || return 0
	current_settings='{}'
	if [[ -f "${settings_file}" ]]; then
		current_settings=$(<"${settings_file}")
	fi
	# why: -n keeps jq off the caller's stdin
	missing=$(jq -nr --argjson installed "${current_settings}" --argjson catalog "$(printf '%s\n' "${packages[@]}" | jq -R . | jq -s .)" \
		'$catalog - ($installed.packages // []) | .[]')
	[[ -n "${missing}" ]] || return 0
	mapfile -t missing_packages <<<"${missing}"
	for package in "${missing_packages[@]}"; do
		start_spinner "Installing the Pi extension ${package}"
		if ! spinner_stream log_debug "${pi_command}" install "${package}"; then
			stop_spinner 1 "Pi extension ${package} not installed: ${pi_command} install failed (see the debug log)"
			return 1
		fi
		stop_spinner 0 "Pi extension ${package} installed"
	done
}

# agent_pi_package_declared <source>: succeeds when Pi's settings declare the package
agent_pi_package_declared() {
	local settings_file

	settings_file=$(agent_pi_settings_file)
	[[ -n "${settings_file}" && -f "${settings_file}" ]] || return 1
	jq -e --arg package "$1" '(.packages // []) | index($package) != null' "${settings_file}" >/dev/null 2>&1
}

# agent_pi_identity: prints the providers in Pi's auth file that pi auth check reports ready
# Stdout: the ready providers, comma-separated on one line
# Returns: 1 when none is ready; a provider probe's status when it timed out.
# Notes: readiness comes from the JSON payload, not the command's exit status. A timed-out
#   probe wins over a ready provider, so the timeout surfaces as retryable.
agent_pi_identity() {
	local auth_file="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/auth.json"
	local provider output status ready_providers='' rc=0 provider_rc

	[[ -f "$auth_file" ]] || return 1
	while IFS= read -r provider; do
		[[ -n "$provider" ]] || continue
		provider_rc=0
		output=$(agent_probe pi auth check --provider "$provider" --json --no-refresh 2>/dev/null) || provider_rc=$?
		case "$provider_rc" in
		0) ;;
		124|125|137) rc="$provider_rc"; continue ;;
		*) continue ;;
		esac
		status=$(jq -r '.status // empty' <<<"$output" 2>/dev/null || true)
		[[ "$status" == 'ready' ]] && ready_providers+="${ready_providers:+, }${provider}"
	done < <(jq -r 'keys[]' "$auth_file" 2>/dev/null)
	[[ "$rc" -eq 0 ]] || return "$rc"
	[[ -n "$ready_providers" ]] || return 1
	printf '%s\n' "$ready_providers"
}

export -f agent_pi_settings_file agent_pi_configure agent_pi_package_declared agent_pi_identity
