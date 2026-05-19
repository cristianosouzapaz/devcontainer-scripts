#!/bin/bash
set -euo pipefail

# main: Downloads the latest agent-templates installer assets and installs dependencies.
# Fetches index.js, package.json, and all template files from the public repository
# into the script's own directory and runs `npm install`.
# Returns: 0 on success.
main() {
	local agents_dir base_url scripts_ref
	agents_dir="$(dirname "${BASH_SOURCE[0]}")"
	scripts_ref="${SCRIPTS_REF:-main}"
	base_url="https://raw.githubusercontent.com/cristianosouzapaz/devcontainer-scripts/${scripts_ref}/scripts/agents"

	curl -fsSL "${base_url}/index.js"    -o "${agents_dir}/index.js"
	curl -fsSL "${base_url}/package.json" -o "${agents_dir}/package.json"

	mkdir -p "${agents_dir}/templates/instructions"
	mkdir -p "${agents_dir}/templates/prompts"

	declare -a _templates
	mapfile -t _templates < <(grep -E 'templateFile:|commandTemplateFile:' "${agents_dir}/index.js" | sed -n 's/.*File: "\([^"]*\)".*/\1/p' | sort -u)

	for _name in "${_templates[@]}"; do
		curl -fsSL "${base_url}/templates/${_name}" -o "${agents_dir}/templates/${_name}"
	done

	cd "${agents_dir}"
	npm i >/dev/null 2>&1
}

main "$@"
