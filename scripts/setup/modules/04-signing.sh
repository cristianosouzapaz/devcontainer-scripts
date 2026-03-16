#!/bin/bash
set -euo pipefail

# MODULE_NAME="ssh-signing"
# MODULE_DESCRIPTION="Configures git SSH commit signing via SSH agent"
# MODULE_ENTRY="ssh_signing_setup"

# SSH signing setup module - Configures git to sign commits using the SSH key
# available via the SSH agent (SSH_AUTH_SOCK).
#
# This module is opt-in: it activates only when SSH_SIGNING=true and
# SSH_AUTH_SOCK points to a valid socket. VS Code forwards the host SSH agent
# automatically, so any agent on the host (1Password, OpenSSH, Keychain, etc.)
# is transparently available inside the container.
# The private key never leaves the agent.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(dirname "${BASH_SOURCE[0]}")/../shared/loader.sh"

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# This module uses the following configuration variables:
# - GIT_SIGNING_KEY (from .config/.env)
# - SSH_AUTH_SOCK   (standard Unix variable, set by the SSH agent / VS Code forwarding)
# - SSH_SIGNING

# ----- HELPER FUNCTIONS -------------------------------------------------------

# _is_signing_configured <ssh_keygen_path>
# Returns 0 if git is already configured for SSH signing with the expected values.
_is_signing_configured() {
	local ssh_keygen_path="$1"

	[[ "$(git config --global gpg.format 2>/dev/null || true)" == "ssh" ]] || return 1
	[[ "$(git config --global gpg.ssh.program 2>/dev/null || true)" == "${ssh_keygen_path}" ]] || return 1
	[[ "$(git config --global commit.gpgsign 2>/dev/null || true)" == "true" ]] || return 1

	if [[ -n "${GIT_SIGNING_KEY:-}" ]]; then
		[[ "$(git config --global user.signingkey 2>/dev/null || true)" == "${GIT_SIGNING_KEY}" ]] || return 1
	fi

	return 0
}

# _configure_git_signing <ssh_keygen_path>
# Writes SSH signing settings to the global git config.
_configure_git_signing() {
	local ssh_keygen_path="$1"

	log_debug "Configuring git for SSH commit signing"
	git config --global gpg.format ssh
	git config --global gpg.ssh.program "${ssh_keygen_path}"
	git config --global commit.gpgsign true

	if [[ -n "${GIT_SIGNING_KEY:-}" ]]; then
		git config --global user.signingkey "${GIT_SIGNING_KEY}"
	fi
	log_success "SSH commit signing configured"
}

# ----- CORE SETUP -------------------------------------------------------------

# ssh_signing_setup: Module entry point.
# Fails if ssh-keygen is unavailable. Delegates to _configure_git_signing
# only when not already correctly set; clears GIT_SIGNING_KEY on exit.
ssh_signing_setup() {
	setup_error_traps || true
	register_cleanup 'unset GIT_SIGNING_KEY'

	if [[ "${SSH_SIGNING:-}" != "true" ]]; then
		log_debug "SSH_SIGNING is not true; ssh-signing was not selected during project init"
		module_skip
		return 0
	fi

	if [[ ! -S "${SSH_AUTH_SOCK:-}" ]]; then
		log_debug "SSH_AUTH_SOCK is not set or is not a valid socket; ensure the SSH agent is running and forwarded"
		module_skip
		return 0
	fi

	check_command ssh-keygen || {
		log_error "ssh-keygen not found; cannot configure SSH commit signing"
		return 1
	}

	local ssh_keygen_path
	ssh_keygen_path="$(command -v ssh-keygen)"
	log_debug "ssh-keygen found at: ${ssh_keygen_path}"

	if _is_signing_configured "${ssh_keygen_path}"; then
		log_debug "SSH commit signing already configured, skipping"
	else
		if [[ -z "${GIT_SIGNING_KEY:-}" ]]; then
			log_warning "GIT_SIGNING_KEY is not set; user.signingkey will not be configured"
		fi
		_configure_git_signing "${ssh_keygen_path}"
	fi

	return 0
}
