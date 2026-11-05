# shellcheck shell=bash

# MODULE_NAME="browser"
# MODULE_DESCRIPTION="Points BROWSER at the stable devcontainer-browser wrapper in every interactive shell"
# MODULE_ENTRY="browser_setup"
# MODULE_AFTER=""
# MODULE_SECRETS=""

# ----- OVERVIEW ---------------------------------------------------------------
#
# Appends the browser-env snippet to the system-wide bashrc once, so every
# interactive shell sets BROWSER to /usr/local/bin/devcontainer-browser after
# VS Code has set its own commit-bound helper. A re-run finds the snippet's
# marker and writes nothing.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../lib" && pwd)/loader.sh"

# ----- INTERNAL CONSTANTS -----------------------------------------------------

readonly _BROWSER_ENV_ASSET="${DEVCONTAINER_ASSETS_DIR}/browser/browser-env.sh"
readonly _BROWSER_ENV_MARKER='devcontainer-browser-env'
readonly _BROWSER_BASHRC_PATH="${BROWSER_BASHRC_PATH:-/etc/bash.bashrc}"

# ----- CORE SETUP -------------------------------------------------------------

# browser_bashrc_with_env <bashrc_path>: prints the existing bashrc followed by the browser-env snippet
# Stdout: the existing bashrc, when there is one, followed by the browser-env snippet
browser_bashrc_with_env() {
	if [[ -e "$1" ]]; then
		cat -- "$1" || return 1
	fi
	cat -- "$_BROWSER_ENV_ASSET"
}

# browser_setup: module entry; appends the browser-env snippet to the system-wide bashrc unless its marker is already there
browser_setup() {
	if grep -qF "$_BROWSER_ENV_MARKER" "$_BROWSER_BASHRC_PATH" 2>/dev/null; then
		log_debug "BROWSER wrapper snippet already present, skipping"
		return 0
	fi
	atomic_write "$_BROWSER_BASHRC_PATH" browser_bashrc_with_env "$_BROWSER_BASHRC_PATH" || return 1
	log_detail "Pointed BROWSER at the devcontainer-browser wrapper"
}

export -f browser_setup browser_bashrc_with_env
