#!/bin/bash
set -euo pipefail

# MODULE_NAME="herdr"
# MODULE_DESCRIPTION="Initializes project Herdr configuration and agent integrations"
# MODULE_ENTRY="herdr_setup"
# MODULE_AFTER="persistent-data,coding-agents"
# MODULE_SECRETS=""

# ----- OVERVIEW ---------------------------------------------------------------
#
# Initializes the project's Herdr configuration and coding-agent integrations
# through the shared herdr_apply sequence.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../lib" && pwd)/loader.sh"

# ----- CORE SETUP -------------------------------------------------------------

# herdr_setup: module entry; runs herdr_apply
herdr_setup() {
	herdr_apply
}

export -f herdr_setup
