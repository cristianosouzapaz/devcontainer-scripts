# shellcheck shell=bash
[[ -n "${_LOADER_SH_LOADED:-}" ]] && return 0
readonly _LOADER_SH_LOADED=1

# Single entry point for the shared utility layer: modules source this, never an
# individual shared file. Also sets the container's environment-variable defaults.
#
# The one place that knows the layout of the script tree: every anchor is absolute
# and derived from this file's own location, so nothing downstream depends on the
# working directory (modules cd into the workspace mid-run) or spells out a ../ hop.

# ----- SCRIPT TREE ANCHORS ----------------------------------------------------

DEVCONTAINER_LIB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly DEVCONTAINER_LIB_DIR
readonly DEVCONTAINER_SETUP_DIR="${DEVCONTAINER_LIB_DIR%/*}"
readonly DEVCONTAINER_SCRIPTS_DIR="${DEVCONTAINER_SETUP_DIR%/*}"
# shellcheck disable=SC2034 # consumed by devcontainer-setup.sh
readonly DEVCONTAINER_MODULES_DIR="${DEVCONTAINER_SETUP_DIR}/modules"
# shellcheck disable=SC2034 # consumed by modules/coding-agents.sh and lib/herdr.sh
readonly DEVCONTAINER_ASSETS_DIR="${DEVCONTAINER_SETUP_DIR}/assets"
# shellcheck disable=SC2034 # consumed by lib/provisioning.sh and modules/coding-agents.sh
readonly DEVCONTAINER_CONFIG_DIR="${DEVCONTAINER_SCRIPTS_DIR}/config"
# shellcheck disable=SC2034 # consumed by sync-agent-assets.sh
readonly DEVCONTAINER_INSTALLER_DIR="${DEVCONTAINER_SCRIPTS_DIR}/installer"
# shellcheck disable=SC2034 # consumed by the Bats suite (entrypoints/, lib/loader, conventions/shellcheck)
readonly DEVCONTAINER_BIN_DIR="${DEVCONTAINER_SCRIPTS_DIR}/bin"

# shellcheck source=public/scripts/setup/lib/atomic-write.sh
source "$DEVCONTAINER_LIB_DIR/atomic-write.sh"
# shellcheck source=public/scripts/setup/lib/env-loader.sh
source "$DEVCONTAINER_LIB_DIR/env-loader.sh"
# shellcheck source=public/scripts/setup/lib/error-handler.sh
source "$DEVCONTAINER_LIB_DIR/error-handler.sh"
# shellcheck source=public/scripts/setup/lib/logging.sh
source "$DEVCONTAINER_LIB_DIR/logging.sh"
# shellcheck source=public/scripts/setup/lib/module-registry.sh
source "$DEVCONTAINER_LIB_DIR/module-registry.sh"
# shellcheck source=public/scripts/setup/lib/provisioning.sh
source "$DEVCONTAINER_LIB_DIR/provisioning.sh"
# shellcheck source=public/scripts/setup/lib/persistent-data/paths.sh
source "$DEVCONTAINER_LIB_DIR/persistent-data/paths.sh"
# shellcheck source=public/scripts/setup/lib/persistent-data/locks.sh
source "$DEVCONTAINER_LIB_DIR/persistent-data/locks.sh"
# shellcheck source=public/scripts/setup/lib/persistent-data/schema.sh
source "$DEVCONTAINER_LIB_DIR/persistent-data/schema.sh"
# shellcheck source=public/scripts/setup/lib/persistent-data/links.sh
source "$DEVCONTAINER_LIB_DIR/persistent-data/links.sh"
# shellcheck source=public/scripts/setup/lib/persistent-data/summary.sh
source "$DEVCONTAINER_LIB_DIR/persistent-data/summary.sh"
# shellcheck source=public/scripts/setup/lib/retry.sh
source "$DEVCONTAINER_LIB_DIR/retry.sh"
# shellcheck source=public/scripts/setup/lib/spinner.sh
source "$DEVCONTAINER_LIB_DIR/spinner.sh"
# shellcheck source=public/scripts/setup/lib/validation.sh
source "$DEVCONTAINER_LIB_DIR/validation.sh"
# shellcheck source=public/scripts/setup/lib/herdr.sh
source "$DEVCONTAINER_LIB_DIR/herdr.sh"

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# Documented in README.md#configuration-variables:
# - AGENT_ASSETS_REF
# - AUTO_UPDATE
# - CLEAN_CREDENTIALS
# - DEBUG_MODE
# - DEFAULT_BRANCH
# - DUMP_ERROR_STACK
# - EXTRA_FOLDER_N
# - GIT_CLONE_TOKEN
# - GIT_SIGNING_KEY
# - GIT_EMAIL
# - GIT_USER
# - LOG_FILE
# - LOG_LEVEL
# - NGROK_AUTHTOKEN
# - REPO_SOURCE
# - REQUIRE_DEPENDENCY_INSTALL
# - SSH_SIGNING
# - STRUCTURED_LOGS
# - VALIDATE_TOKEN
# - PERSIST_<NAME>

AGENT_ASSETS_REF="${AGENT_ASSETS_REF:-}"
AUTO_UPDATE="${AUTO_UPDATE:-false}"
CLEAN_CREDENTIALS="${CLEAN_CREDENTIALS:-false}"
DEBUG_MODE="${DEBUG_MODE:-false}"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
DUMP_ERROR_STACK="${DUMP_ERROR_STACK:-true}"
GIT_SIGNING_KEY="${GIT_SIGNING_KEY:-}"
GIT_CLONE_TOKEN="${GIT_CLONE_TOKEN:-}"
GIT_EMAIL="${GIT_EMAIL:-}"
GIT_USER="${GIT_USER:-}"
LOG_FILE="${LOG_FILE:-}"
LOG_LEVEL="${LOG_LEVEL:-INFO}"
NGROK_AUTHTOKEN="${NGROK_AUTHTOKEN:-}"
REPO_SOURCE="${REPO_SOURCE:-}"
REQUIRE_DEPENDENCY_INSTALL="${REQUIRE_DEPENDENCY_INSTALL:-false}"
SSH_SIGNING="${SSH_SIGNING:-true}"
STRUCTURED_LOGS="${STRUCTURED_LOGS:-false}"
VALIDATE_TOKEN="${VALIDATE_TOKEN:-true}"
