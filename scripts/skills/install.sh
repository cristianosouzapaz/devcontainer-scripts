#!/bin/bash
set -euo pipefail

# Load shared utilities
source "$(dirname "${BASH_SOURCE[0]}")/../setup/shared/loader.sh"

# main: Downloads the latest skills installer assets and installs dependencies.
# Fetches index.js and package.json from the public repository into
# the script's own directory and runs `npm install`.
# Returns: 0 on success.
main() {
	local skills_dir base_url
	skills_dir="$(dirname "${BASH_SOURCE[0]}")"
	base_url="https://raw.githubusercontent.com/cristianosouzapaz/devcontainer-scripts/main/scripts/skills"
    
	curl -fsSL "${base_url}/index.js"    -o "${skills_dir}/index.js"
	curl -fsSL "${base_url}/package.json" -o "${skills_dir}/package.json"
	cd "${skills_dir}"
	npm i >/dev/null 2>&1
}

main "$@"
