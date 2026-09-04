#!/bin/bash
set -euo pipefail

# MODULE_NAME="herdr"
# MODULE_DESCRIPTION="Initializes project Herdr configuration and agent integrations"
# MODULE_ENTRY="herdr_setup"
# MODULE_AFTER="persistent-data,coding-agents"

# ----- OVERVIEW ---------------------------------------------------------------
#
# Initializes the project's Herdr configuration and its Claude/Codex agent
# integrations. Guards on the Herdr command, then applies the locked
# config + integration sequence (see setup/lib/herdr.sh).

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(dirname "${BASH_SOURCE[0]}")/../lib/loader.sh"

# ----- CORE SETUP -------------------------------------------------------------

# herdr_setup: Registers the module's error traps, then runs the locked
# config + integration apply sequence (herdr_apply, see setup/lib/herdr.sh),
# which guards on the Herdr command before taking any lock.
# Returns: 0 on success, 1 when configuration or integration setup fails.
herdr_setup() {
	setup_error_traps
	herdr_apply
}

export -f herdr_setup
