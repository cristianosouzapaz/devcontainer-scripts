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
# shellcheck disable=SC2034 # consumed by devcontainer-setup.sh, lib/herdr.sh and lib/inventory.sh
readonly DEVCONTAINER_CORE_DIR="${DEVCONTAINER_SETUP_DIR}/core"
# shellcheck disable=SC2034 # consumed by devcontainer-setup.sh
readonly DEVCONTAINER_MODULES_DIR="${DEVCONTAINER_SETUP_DIR}/modules"
readonly DEVCONTAINER_AGENTS_DIR="${DEVCONTAINER_CORE_DIR}/coding-agents"
# shellcheck disable=SC2034 # consumed by sync-agent-assets.sh
readonly DEVCONTAINER_INSTALLER_ROOT="${DEVCONTAINER_SCRIPTS_DIR}/installer"
# shellcheck disable=SC2034 # runtime consumers must never fall back to the mutable bootstrap root
readonly DEVCONTAINER_INSTALLER_DIR="${DEVCONTAINER_INSTALLER_ROOT}/current"
# shellcheck disable=SC2034 # consumed by the Bats suite (entrypoints/, lib/loader, conventions/shellcheck)
readonly DEVCONTAINER_BIN_DIR="${DEVCONTAINER_SCRIPTS_DIR}/bin"

# shellcheck source=public/scripts/setup/lib/atomic-write.sh
source "$DEVCONTAINER_LIB_DIR/atomic-write.sh"
# shellcheck source=public/scripts/setup/lib/editor.sh
source "$DEVCONTAINER_LIB_DIR/editor.sh"
# shellcheck source=public/scripts/setup/lib/env-loader.sh
source "$DEVCONTAINER_LIB_DIR/env-loader.sh"
# shellcheck source=public/scripts/setup/lib/error-handler.sh
source "$DEVCONTAINER_LIB_DIR/error-handler.sh"
# shellcheck source=public/scripts/setup/lib/logging.sh
source "$DEVCONTAINER_LIB_DIR/logging.sh"
# shellcheck source=public/scripts/setup/lib/module-registry.sh
source "$DEVCONTAINER_LIB_DIR/module-registry.sh"
# shellcheck source=public/scripts/setup/lib/install-user.sh
source "$DEVCONTAINER_LIB_DIR/install-user.sh"
# shellcheck source=public/scripts/setup/lib/inventory.sh
source "$DEVCONTAINER_LIB_DIR/inventory.sh"
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
# shellcheck source=public/scripts/setup/lib/global-agent-assets.sh
source "$DEVCONTAINER_LIB_DIR/global-agent-assets.sh"

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# Documented in README.md#configuration-variables:
# - CLEAN_CREDENTIALS
# - CODING_AGENTS: read by inventory.sh, which defaults it to the packs marked default
# - EXTRA_FOLDER_N
# - GIT_CLONE_TOKEN
# - GIT_SIGNING_KEY
# - GIT_EMAIL
# - GIT_TOKEN_DURING_INSTALL
# - GIT_USER
# - LOG_LEVEL
# - NGROK_AUTHTOKEN
# - REPO_SOURCE
# - REQUIRE_DEPENDENCY_INSTALL
# - SSH_SIGNING
# - STRUCTURED_LOGS
# - PERSIST_<NAME>

CLEAN_CREDENTIALS="${CLEAN_CREDENTIALS:-false}"
GIT_SIGNING_KEY="${GIT_SIGNING_KEY:-}"
GIT_CLONE_TOKEN="${GIT_CLONE_TOKEN:-}"
GIT_EMAIL="${GIT_EMAIL:-}"
GIT_TOKEN_DURING_INSTALL="${GIT_TOKEN_DURING_INSTALL:-false}"
GIT_USER="${GIT_USER:-}"
LOG_LEVEL="${LOG_LEVEL:-INFO}"
NGROK_AUTHTOKEN="${NGROK_AUTHTOKEN:-}"
REPO_SOURCE="${REPO_SOURCE:-}"
REQUIRE_DEPENDENCY_INSTALL="${REQUIRE_DEPENDENCY_INSTALL:-false}"
SSH_SIGNING="${SSH_SIGNING:-true}"
STRUCTURED_LOGS="${STRUCTURED_LOGS:-false}"
