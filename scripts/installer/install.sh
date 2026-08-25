#!/bin/bash
set -euo pipefail

# ----- HELPER FUNCTIONS -------------------------------------------------------

# fetch_templated_component: downloads a sub-installer's index.js and JSON manifest(s) from the
# remote installer repo, then fetches every templateFile referenced inside those manifests.
# Args: $1 base_url, $2 installer_dir, $3 component name (e.g. "agents"), $4... manifest filenames
# Returns: 0 on success.
fetch_templated_component() {
	local base_url="$1" installer_dir="$2" name="$3"
	shift 3
	local -a manifests=("$@")
	local manifest template
	local -a templates

	curl --create-dirs -fsSL "${base_url}/${name}/index.js" -o "${installer_dir}/${name}/index.js"
	for manifest in "${manifests[@]}"; do
		curl --create-dirs -fsSL "${base_url}/${name}/${manifest}" -o "${installer_dir}/${name}/${manifest}"
	done

	mapfile -t templates < <(
		grep -h '"templateFile"' "${manifests[@]/#/${installer_dir}/${name}/}" \
			| sed -n 's/.*"templateFile":\s*"\([^"]*\)".*/\1/p' \
			| sort -u
	)

	for template in "${templates[@]}"; do
		curl --create-dirs -fsSL "${base_url}/${name}/templates/${template}" -o "${installer_dir}/${name}/templates/${template}"
	done
}

# ----- CORE SETUP -------------------------------------------------------------

# main: Downloads all installer assets from the public repository and installs dependencies.
# Fetches package.json, shared/utils.js, and each sub-installer (agents, configs, skills,
# skills/local, agent-md) including their index.js files, template files, and data files,
# then runs a single `npm install` for the entire installer package.
# Returns: 0 on success.
main() {
	local installer_dir base_url scripts_ref
	installer_dir="$(dirname "${BASH_SOURCE[0]}")"
	scripts_ref="${SCRIPTS_REF:-main}"
	base_url="https://raw.githubusercontent.com/cristianosouzapaz/devcontainer-scripts/${scripts_ref}/scripts/installer"

	curl --create-dirs -fsSL "${base_url}/package.json"       -o "${installer_dir}/package.json"
	curl --create-dirs -fsSL "${base_url}/shared/utils.js"    -o "${installer_dir}/shared/utils.js"
	curl --create-dirs -fsSL "${base_url}/skills/index.js"    -o "${installer_dir}/skills/index.js"
	curl --create-dirs -fsSL "${base_url}/skills/skills.json" -o "${installer_dir}/skills/skills.json"

	fetch_templated_component "${base_url}" "${installer_dir}" agents instructions.json prompts.json
	fetch_templated_component "${base_url}" "${installer_dir}" configs configs.json
	fetch_templated_component "${base_url}" "${installer_dir}" agent-md agent-md.json
	fetch_templated_component "${base_url}" "${installer_dir}" skills/local skills.json

	cd "${installer_dir}"
	npm i --omit=dev >/dev/null 2>&1
}

# ----- ENTRY POINT ------------------------------------------------------------

main "$@"
