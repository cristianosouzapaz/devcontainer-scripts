# shellcheck shell=bash

# MODULE_NAME="editor"
# MODULE_DESCRIPTION="Points BROWSER and the code command at the live editor connection in every interactive shell"
# MODULE_ENTRY="editor_setup"
# MODULE_AFTER=""
# MODULE_SECRETS=""

# ----- OVERVIEW ---------------------------------------------------------------
#
# Appends the editor-env snippet to the system-wide bashrc once, so every
# interactive shell sets BROWSER to devcontainer-browser and defines a code
# function calling devcontainer-editor, after VS Code has set its own
# commit-bound helper and CLI. A re-run finds the snippet's marker and writes
# nothing.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../lib" && pwd)/loader.sh"

# ----- INTERNAL CONSTANTS -----------------------------------------------------

readonly _EDITOR_ENV_ASSET="${DEVCONTAINER_MODULES_DIR}/editor/assets/editor-env.sh"
readonly _EDITOR_ENV_MARKER='devcontainer-editor-env'
readonly _EDITOR_BASHRC_PATH="${EDITOR_BASHRC_PATH:-/etc/bash.bashrc}"

# ----- CORE SETUP -------------------------------------------------------------

# editor_bashrc_with_env <bashrc_path>: prints the existing bashrc followed by the editor-env snippet
# Stdout: the existing bashrc, when there is one, followed by the editor-env snippet
editor_bashrc_with_env() {
	if [[ -e "$1" ]]; then
		cat -- "$1" || return 1
	fi
	cat -- "$_EDITOR_ENV_ASSET"
}

# editor_setup: module entry; appends the editor-env snippet to the system-wide bashrc unless its marker is already there
editor_setup() {
	if grep -qF "$_EDITOR_ENV_MARKER" "$_EDITOR_BASHRC_PATH" 2>/dev/null; then
		log_debug "Editor snippet already present in ${_EDITOR_BASHRC_PATH}, skipping"
		log_item_success "Links and code open in the connected editor (already set up)"
		return 0
	fi
	atomic_write "$_EDITOR_BASHRC_PATH" editor_bashrc_with_env "$_EDITOR_BASHRC_PATH" || return 1
	log_debug "Pointed BROWSER at devcontainer-browser and code at devcontainer-editor in ${_EDITOR_BASHRC_PATH}"
	log_item_success "Links and code open in the connected editor"
}

export -f editor_setup editor_bashrc_with_env
