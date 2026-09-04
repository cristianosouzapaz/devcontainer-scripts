#!/bin/bash
set -euo pipefail

# MODULE_NAME="ssh-signing"
# MODULE_DESCRIPTION="Configures git SSH commit signing via SSH agent"
# MODULE_ENTRY="ssh_signing_setup"
# MODULE_AFTER="git"

# ----- OVERVIEW ---------------------------------------------------------------
#
# Opt-in: configures Git SSH commit signing, and only when SSH_SIGNING=true and
# SSH_AUTH_SOCK points to a valid socket. VS Code forwards the host SSH agent
# automatically, so any host agent (1Password, OpenSSH, Keychain, …) works
# inside the container and the private key never leaves the agent.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(dirname "${BASH_SOURCE[0]}")/../lib/loader.sh"

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# This module uses the following configuration variables:
# - GIT_SIGNING_KEY (from .config/.env)
# - SSH_AUTH_SOCK   (standard Unix variable, set by the SSH agent / VS Code forwarding)
# - SSH_SIGNING

# ----- HELPER FUNCTIONS -------------------------------------------------------

# is_valid_socket: Checks whether the configured SSH agent endpoint is a Unix socket.
# Arguments: none; reads SSH_AUTH_SOCK.
# Returns: 0 when SSH_AUTH_SOCK points to a socket, 1 otherwise.
is_valid_socket() {
	[[ -S "${SSH_AUTH_SOCK:-}" ]]
}

# is_signing_configured <ssh_keygen_path>
# Returns 0 if git is already configured for SSH signing with the expected values.
is_signing_configured() {
	local ssh_keygen_path="$1"
	local configured_format configured_program configured_commit_signing configured_signing_key

	configured_format="$(git config --global gpg.format 2>/dev/null || true)"
	configured_program="$(git config --global gpg.ssh.program 2>/dev/null || true)"
	configured_commit_signing="$(git config --global commit.gpgsign 2>/dev/null || true)"
	[[ "${configured_format}" == "ssh" ]] || return 1
	[[ "${configured_program}" == "${ssh_keygen_path}" ]] || return 1
	[[ "${configured_commit_signing}" == "true" ]] || return 1

	if [[ -n "${GIT_SIGNING_KEY:-}" ]]; then
		configured_signing_key="$(git config --global user.signingkey 2>/dev/null || true)"
		[[ "${configured_signing_key}" == "${GIT_SIGNING_KEY}" ]] || return 1
	fi

	return 0
}

# configure_git_signing <ssh_keygen_path>
# Writes the same 3-4 settings is_signing_configured checks (signingkey only
# when GIT_SIGNING_KEY is set), so the two stay in lockstep by construction.
configure_git_signing() {
	local ssh_keygen_path="$1"

	log_debug "Configuring git for SSH commit signing"
	git config --global gpg.format ssh
	git config --global gpg.ssh.program "${ssh_keygen_path}"
	git config --global commit.gpgsign true

	if [[ -n "${GIT_SIGNING_KEY:-}" ]]; then
		git config --global user.signingkey "${GIT_SIGNING_KEY}"
	fi
	log_item_success "SSH commit signing configured"
}

# ----- CORE SETUP -------------------------------------------------------------

# ssh_signing_setup: Module entry point.
# Fails if ssh-keygen is unavailable. Delegates to configure_git_signing
# only when not already correctly set; clears GIT_SIGNING_KEY on exit.
# Arguments: none.
# Returns: 0 on success or skip; 1 when ssh-keygen is unavailable.
ssh_signing_setup() {
	local ssh_keygen_path

	setup_error_traps
	register_cleanup 'unset GIT_SIGNING_KEY'

	if [[ "${SSH_SIGNING:-}" != "true" ]]; then
		log_debug "SSH_SIGNING is not true; ssh-signing was not selected during project init"
		module_skip
		return 0
	fi

	if ! is_valid_socket; then
		log_debug "SSH_AUTH_SOCK is not set or is not a valid socket; ensure the SSH agent is running and forwarded"
		module_skip
		return 0
	fi

	check_command ssh-keygen || {
		log_error "ssh-keygen not found; cannot configure SSH commit signing"
		return 1
	}

	ssh_keygen_path="$(command -v ssh-keygen)"
	log_debug "ssh-keygen found at: ${ssh_keygen_path}"

	if is_signing_configured "${ssh_keygen_path}"; then
		log_debug "SSH commit signing already configured, skipping"
	else
		if [[ -z "${GIT_SIGNING_KEY:-}" ]]; then
			log_item_warning "GIT_SIGNING_KEY is not set; user.signingkey will not be configured"
		fi
		configure_git_signing "${ssh_keygen_path}"
	fi

	return 0
}

export -f is_valid_socket is_signing_configured configure_git_signing ssh_signing_setup
