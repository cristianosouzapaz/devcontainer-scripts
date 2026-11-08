# shellcheck shell=bash

# MODULE_NAME="ssh-signing"
# MODULE_DESCRIPTION="Configures git SSH commit signing with GIT_SIGNING_KEY"
# MODULE_ENTRY="ssh_signing_setup"
# MODULE_AFTER="git"
# MODULE_SECRETS="GIT_SIGNING_KEY"

# ----- OVERVIEW ---------------------------------------------------------------
#
# Opt-in: configures Git SSH commit signing when SSH_SIGNING is true and
# GIT_SIGNING_KEY names the key. Signing then goes through the SSH agent the editor
# forwards, so any host agent (1Password, OpenSSH, Keychain) works inside the
# container and the private key never leaves it. The agent may not be forwarded yet
# at setup time (the devcontainer CLI), so it is not required here. Without a key,
# signing is left off, and settings an earlier run wrote without one are removed:
# commit.gpgsign without user.signingkey makes every git commit fail.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../lib" && pwd)/loader.sh"

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# Documented in README.md#configuration-variables:
# - GIT_SIGNING_KEY
# - SSH_SIGNING
# - SSH_AUTH_SOCK: path of the agent socket the SSH agent forwarding sets

# ----- HELPER FUNCTIONS -------------------------------------------------------

# is_signing_configured <ssh_keygen_path>: succeeds when git's global config already signs commits over SSH with this ssh-keygen and GIT_SIGNING_KEY
is_signing_configured() {
	local ssh_keygen_path="$1"

	[[ "$(git config --global gpg.format 2>/dev/null || true)" == "ssh" ]] || return 1
	[[ "$(git config --global gpg.ssh.program 2>/dev/null || true)" == "${ssh_keygen_path}" ]] || return 1
	[[ "$(git config --global commit.gpgsign 2>/dev/null || true)" == "true" ]] || return 1
	[[ "$(git config --global user.signingkey 2>/dev/null || true)" == "${GIT_SIGNING_KEY}" ]]
}

# configure_git_signing <ssh_keygen_path>: writes git's global SSH signing settings for GIT_SIGNING_KEY
# Notes: writes exactly the settings is_signing_configured checks, so the two stay in
#   lockstep.
configure_git_signing() {
	local ssh_keygen_path="$1"

	git config --global gpg.format ssh
	git config --global gpg.ssh.program "${ssh_keygen_path}"
	git config --global user.signingkey "${GIT_SIGNING_KEY}"
	git config --global commit.gpgsign true
}

# remove_keyless_signing: removes the signing settings an earlier run left on without user.signingkey
remove_keyless_signing() {
	local key
	[[ "$(git config --global commit.gpgsign 2>/dev/null || true)" == "true" ]] || return 0
	[[ -z "$(git config --global user.signingkey 2>/dev/null || true)" ]] || return 0
	for key in commit.gpgsign gpg.format gpg.ssh.program; do
		git config --global --unset-all "$key" || true
	done
	log_debug "Removed commit signing settings left on without a signing key"
}

# ----- CORE SETUP -------------------------------------------------------------

# ssh_signing_setup: module entry; configures SSH commit signing for GIT_SIGNING_KEY unless already in place, skipping when SSH_SIGNING is not true or no key is set, failing without ssh-keygen
# Notes: the registry injects the key only into this module's subshell.
ssh_signing_setup() {
	local ssh_keygen_path

	if [[ "${SSH_SIGNING:-}" != "true" ]]; then
		log_debug "SSH_SIGNING is not true; ssh-signing was not selected during project init"
		module_skip 'not selected'
		return 0
	fi

	if [[ -z "${GIT_SIGNING_KEY:-}" ]]; then
		remove_keyless_signing
		module_skip --action 'set GIT_SIGNING_KEY, or deselect ssh-signing in the picker' \
			'GIT_SIGNING_KEY not set — commit signing left off'
		return 0
	fi

	check_command ssh-keygen || {
		log_error "ssh-keygen not found; cannot configure SSH commit signing"
		return 1
	}

	[[ -S "${SSH_AUTH_SOCK:-}" ]] || log_debug "No SSH agent socket yet; signing works once the agent is forwarded"
	ssh_keygen_path="$(command -v ssh-keygen)"
	log_debug "ssh-keygen found at: ${ssh_keygen_path}"

	if is_signing_configured "${ssh_keygen_path}"; then
		log_item_success "SSH commit signing already on"
		return 0
	fi
	configure_git_signing "${ssh_keygen_path}"
	log_item_success "SSH commit signing configured"
}

export -f is_signing_configured configure_git_signing remove_keyless_signing ssh_signing_setup
