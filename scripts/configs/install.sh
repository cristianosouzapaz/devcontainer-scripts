#!/bin/bash
set -euo pipefail

# main: Downloads the latest config-templates installer assets and installs dependencies.
# Fetches index.js, package.json, and all template files from the public repository
# into the script's own directory and runs `npm install`.
# Returns: 0 on success.
main() {
	local configs_dir base_url
	configs_dir="$(dirname "${BASH_SOURCE[0]}")"
	base_url="https://raw.githubusercontent.com/cristianosouzapaz/devcontainer-scripts/main/scripts/configs"

	curl -fsSL "${base_url}/index.js"    -o "${configs_dir}/index.js"
	curl -fsSL "${base_url}/package.json" -o "${configs_dir}/package.json"

	declare -a _TEMPLATES=(
		"templates/biome.json"
		"templates/tsconfig.base.json"
		"templates/tsconfig.nextjs.json"
		"templates/lefthook.yml"
	)

	mkdir -p "${configs_dir}/templates"
	for _file in "${_TEMPLATES[@]}"; do
		curl -fsSL "${base_url}/${_file}" -o "${configs_dir}/${_file}"
	done

	cd "${configs_dir}"
	npm i >/dev/null 2>&1
}

main "$@"
