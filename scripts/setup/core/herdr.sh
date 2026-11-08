# shellcheck shell=bash

# CORE_NAME="herdr"
# CORE_DESCRIPTION="Initializes project Herdr configuration and agent integrations"
# CORE_ENTRY="herdr_setup"
# CORE_AFTER="persistent-data,coding-agents"
# CORE_SECRETS=""
# CORE_PERSIST="herdr"

# ----- OVERVIEW ---------------------------------------------------------------
#
# Initializes the project's Herdr configuration and coding-agent integrations
# through the shared herdr_apply sequence.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../lib" && pwd)/loader.sh"

# ----- CORE SETUP -------------------------------------------------------------

# herdr_setup: core entry; writes the project's Herdr config and each selected agent's Herdr hook
herdr_setup() {
	herdr_apply
	log_item_success "Herdr configured for the coding agents"
}

export -f herdr_setup
