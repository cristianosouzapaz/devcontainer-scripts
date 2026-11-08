# shellcheck shell=bash

# Codex CLI's pack hooks: what its agent.json cannot express. Sourced by the
# inventory library, so every consumer of the inventory sees them.

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# - CODEX_HOME: Codex's own state directory holding auth.json (default ~/.codex)

# ----- HOOKS ------------------------------------------------------------------

# agent_codex_settings_with_defaults <defaults_file> <config_file> <enforced>: prints the Codex configuration with the asset's enforced root-level lines and its defaults filled in
# Stdout: the complete configuration file content
# Returns: grep's status when the existing configuration cannot be read, so the caller
#   aborts before replacing it.
# Notes: <enforced> holds one "key = value" line per line, and replaces any line setting
#   that key. The enforced lines and the defaults lead the output, so a root-level key can
#   never land inside an existing [table]. The "already set" probe covers only the
#   root-level region, above the first table header, so a same-named key inside a table
#   does not mask a default the developer has not actually set.
agent_codex_settings_with_defaults() {
	local defaults_file="$1" config_file="$2" enforced="$3" existing='' root_keys='' enforced_keys='' line key rc=0
	local -a enforced_patterns=()

	while IFS= read -r line; do
		[[ "${line}" =~ ^([A-Za-z_][A-Za-z0-9_-]*)[[:space:]]*= ]] || continue
		printf '%s\n' "${line}"
		enforced_patterns+=(-e "^${BASH_REMATCH[1]}[[:space:]]*=")
		enforced_keys+="${BASH_REMATCH[1]}"$'\n'
	done <<<"${enforced}"
	if [[ -f "${config_file}" ]]; then
		if [[ "${#enforced_patterns[@]}" -gt 0 ]]; then
			existing=$(grep -Ev "${enforced_patterns[@]}" "${config_file}") || rc=$?
		else
			existing=$(<"${config_file}")
		fi
		[[ "${rc}" -le 1 ]] || return "${rc}"
		root_keys=$(sed -n '/^[[:space:]]*\[/q; s/^\([A-Za-z_][A-Za-z0-9_-]*\)[[:space:]]*=.*/\1/p' <<<"${existing}")
	fi
	while IFS= read -r line; do
		[[ "${line}" =~ ^([A-Za-z_][A-Za-z0-9_-]*)[[:space:]]*= ]] || continue
		key="${BASH_REMATCH[1]}"
		# why: TOML rejects a duplicate key, so a default never repeats a key already set or enforced
		if grep -qxF "${key}" <<<"${root_keys}${root_keys:+$'\n'}${enforced_keys}"; then
			continue
		fi
		printf '%s\n' "${line}"
	done < "${defaults_file}"
	[[ -z "${existing}" ]] || printf '%s\n' "${existing}"
}

# agent_codex_configure: merges the pack's Codex defaults and the lines its config asset enforces, such as file credential storage
# Notes: the configuration lives on a persistent volume, so the merged result survives
#   rebuilds; it is rewritten only when it would actually change.
agent_codex_configure() {
	local asset source config_file current desired

	asset=$(agent_asset codex config)
	if [[ -z "${asset}" ]]; then
		log_debug 'No Codex config asset declared, skipping defaults'
		return 0
	fi
	source=$(inventory_asset_source codex "${asset}")
	config_file=$(asset_target codex "${asset}")
	mkdir -p "${config_file%/*}"
	desired=$(agent_codex_settings_with_defaults "${source}" "${config_file}" "$(jq -r '.enforce // [] | .[]' <<<"${asset}")")
	if [[ -f "${config_file}" ]]; then
		current=$(<"${config_file}")
		[[ "${current}" == "${desired}" ]] && return 0
	fi
	atomic_write "${config_file}" printf '%s\n' "${desired}"
	log_debug "Configured Codex settings in ${config_file} from the pack defaults"
}

# agent_codex_identity: prints the ChatGPT account email behind the Codex login, or "active session"
# Stdout: the account email or "active session", one line
# Returns: 1 when not logged in; the probe's status when it timed out.
# Notes: codex login status confirms a session but exposes no account, so the email
#   is decoded from the id_token JWT in $CODEX_HOME/auth.json; an API-key login has
#   no id_token and prints "active session".
agent_codex_identity() {
	local auth_file="${CODEX_HOME:-$HOME/.codex}/auth.json"
	local id_token payload email='' rc=0

	agent_probe codex login status >/dev/null 2>&1 || rc=$?
	[[ "$rc" -eq 0 ]] || return "$rc"
	if [[ -f "$auth_file" ]]; then
		id_token="$(jq -r '.tokens.id_token // empty' "$auth_file" 2>/dev/null)"
		payload="${id_token#*.}"
		payload="${payload%%.*}"
		if [[ -n "$payload" ]]; then
			email="$(jq -rn --arg p "$payload" \
				'($p | gsub("-";"+") | gsub("_";"/")) as $s
				| ($s + ("=" * ((4 - ($s | length) % 4) % 4)))
				| @base64d | fromjson | .email // empty' 2>/dev/null)"
		fi
	fi
	printf '%s\n' "${email:-active session}"
}

# agent_codex_herdr: adds the Stop hook that reports the context row to Herdr into Codex's hooks.json, once
# Notes: the entry names a script shipped in the pack's assets, so editing the script never
#   changes the hook definition (Codex trusts a hook by a hash of it). An entry naming the
#   script at another path, left by an older layout, is replaced; every other key and
#   entry, such as Herdr's SessionStart, is kept. A file that already carries only the
#   current entry is not rewritten, and one that is not valid JSON is refused.
agent_codex_herdr() {
	local hooks_file assets_dir command current updated

	hooks_file="$(persistent_data_category_path codex)/hooks.json" || return 1
	assets_dir=$(inventory_fields agents codex assetsDir) || return 1
	command="bash '${assets_dir}/herdr-context-hook.sh'"
	if [[ -f "$hooks_file" ]] && ! jq -e . "$hooks_file" >/dev/null 2>&1; then
		log_error "Codex hooks file is not valid JSON: $hooks_file"
		return 1
	fi
	current='{}'
	[[ ! -f "$hooks_file" ]] || current=$(<"$hooks_file") || return 1
	# shellcheck disable=SC2016 # jq variables, not shell expansions.
	updated=$(jq --arg c "$command" --arg suffix "/herdr-context-hook.sh'" '
		def context_hook: (.command | type == "string") and (.command | endswith($suffix));
		.hooks.Stop = ([(.hooks.Stop // [])[] | select(any(.hooks[]?; context_hook and .command != $c) | not)]
			| if any(.[].hooks[]?; .command == $c) then . else . + [{hooks: [{type: "command", command: $c, timeout: 10}]}] end)
	' <<<"$current") || return 1
	if [[ "$(jq -cS . <<<"$current")" == "$(jq -cS . <<<"$updated")" ]]; then
		log_debug "Codex context hook already present, skipping"
		return 0
	fi
	mkdir -p "$(dirname "$hooks_file")" || return 1
	atomic_write "$hooks_file" printf '%s\n' "$updated" || return 1
	log_debug "Added the Codex context hook to $hooks_file"
}

export -f agent_codex_settings_with_defaults agent_codex_configure agent_codex_identity agent_codex_herdr
