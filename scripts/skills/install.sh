#!/bin/bash
set -euo pipefail

# main: Downloads the latest skills installer assets and installs dependencies.
# Fetches index.js and package.json from the public repository into
# the script's own directory and runs `npm install`.
# Returns: 0 on success.
main() {
	local skills_dir base_url scripts_ref
	skills_dir="$(dirname "${BASH_SOURCE[0]}")"
	scripts_ref="${SCRIPTS_REF:-main}"
	base_url="https://raw.githubusercontent.com/cristianosouzapaz/devcontainer-scripts/${scripts_ref}/scripts/skills"

	curl -fsSL "${base_url}/index.js"    -o "${skills_dir}/index.js"
	curl -fsSL "${base_url}/package.json" -o "${skills_dir}/package.json"
	curl -fsSL "${base_url}/skills.json"  -o "${skills_dir}/skills.json"

	cd "${skills_dir}"
	npm i >/dev/null 2>&1
}

main "$@"
