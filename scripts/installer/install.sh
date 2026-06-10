#!/bin/bash
set -euo pipefail

# main: Downloads all installer assets from the public repository and installs dependencies.
# Fetches package.json, shared/utils.js, and each sub-installer (agents, configs, skills)
# including their index.js files, template files, and data files, then runs a single
# `npm install` for the entire installer package.
# Returns: 0 on success.
main() {
	local installer_dir base_url scripts_ref
	installer_dir="$(dirname "${BASH_SOURCE[0]}")"
	scripts_ref="${SCRIPTS_REF:-main}"
	base_url="https://raw.githubusercontent.com/cristianosouzapaz/devcontainer-scripts/${scripts_ref}/scripts/installer"

	curl -fsSL "${base_url}/package.json" -o "${installer_dir}/package.json"

	mkdir -p "${installer_dir}/shared"
	curl -fsSL "${base_url}/shared/utils.js" -o "${installer_dir}/shared/utils.js"

	mkdir -p "${installer_dir}/agents/templates/instructions"
	mkdir -p "${installer_dir}/agents/templates/prompts"
	curl -fsSL "${base_url}/agents/index.js"          -o "${installer_dir}/agents/index.js"
	curl -fsSL "${base_url}/agents/instructions.json" -o "${installer_dir}/agents/instructions.json"
	curl -fsSL "${base_url}/agents/prompts.json"      -o "${installer_dir}/agents/prompts.json"

	declare -a _agent_templates
	mapfile -t _agent_templates < <(
		grep -h '"templateFile"' \
			"${installer_dir}/agents/instructions.json" \
			"${installer_dir}/agents/prompts.json" \
		| sed -n 's/.*"templateFile":\s*"\([^"]*\)".*/\1/p' \
		| sort -u
	)

	for _name in "${_agent_templates[@]}"; do
		curl -fsSL "${base_url}/agents/templates/${_name}" -o "${installer_dir}/agents/templates/${_name}"
	done

	mkdir -p "${installer_dir}/configs/templates"
	curl -fsSL "${base_url}/configs/index.js"    -o "${installer_dir}/configs/index.js"
	curl -fsSL "${base_url}/configs/configs.json" -o "${installer_dir}/configs/configs.json"

	declare -a _config_templates
	mapfile -t _config_templates < <(grep '"templateFile"' "${installer_dir}/configs/configs.json" | sed -n 's/.*"templateFile":\s*"\([^"]*\)".*/\1/p')

	for _name in "${_config_templates[@]}"; do
		curl -fsSL "${base_url}/configs/templates/${_name}" -o "${installer_dir}/configs/templates/${_name}"
	done

	mkdir -p "${installer_dir}/skills"
	curl -fsSL "${base_url}/skills/index.js"   -o "${installer_dir}/skills/index.js"
	curl -fsSL "${base_url}/skills/skills.json" -o "${installer_dir}/skills/skills.json"

	cd "${installer_dir}"
	npm i >/dev/null 2>&1
}

main "$@"
