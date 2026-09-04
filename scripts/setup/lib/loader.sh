#!/bin/bash

[[ -n "${_LOADER_SH_LOADED:-}" ]] && return 0
readonly _LOADER_SH_LOADED=1

# Single entry point for the shared utility layer: modules source this, never an
# individual shared file. Also sets the container's environment-variable defaults.

# ----- SCRIPT TREE ANCHORS ----------------------------------------------------
#
# The one place that knows the layout of the script tree. Every path below is
# absolute and derived from this file's own location, so nothing downstream
# depends on the working directory — modules `cd` into the workspace mid-run —
# and nothing else has to spell out a `../` hop of its own.

readonly DEVCONTAINER_LIB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly DEVCONTAINER_SETUP_DIR="${DEVCONTAINER_LIB_DIR%/*}"
readonly DEVCONTAINER_SCRIPTS_DIR="${DEVCONTAINER_SETUP_DIR%/*}"
readonly DEVCONTAINER_MODULES_DIR="${DEVCONTAINER_SETUP_DIR}/modules"
readonly DEVCONTAINER_ASSETS_DIR="${DEVCONTAINER_SETUP_DIR}/assets"
readonly DEVCONTAINER_CONFIG_DIR="${DEVCONTAINER_SCRIPTS_DIR}/config"
readonly DEVCONTAINER_INSTALLER_DIR="${DEVCONTAINER_SCRIPTS_DIR}/installer"
readonly DEVCONTAINER_BIN_DIR="${DEVCONTAINER_SCRIPTS_DIR}/bin"

source "$DEVCONTAINER_LIB_DIR/env-loader.sh"
source "$DEVCONTAINER_LIB_DIR/error-handler.sh"
source "$DEVCONTAINER_LIB_DIR/logging.sh"
source "$DEVCONTAINER_LIB_DIR/module-registry.sh"
source "$DEVCONTAINER_LIB_DIR/persistent-data/registry.sh"
source "$DEVCONTAINER_LIB_DIR/persistent-data/paths.sh"
source "$DEVCONTAINER_LIB_DIR/persistent-data/locks.sh"
source "$DEVCONTAINER_LIB_DIR/persistent-data/schema.sh"
source "$DEVCONTAINER_LIB_DIR/persistent-data/summary.sh"
source "$DEVCONTAINER_LIB_DIR/retry.sh"
source "$DEVCONTAINER_LIB_DIR/spinner.sh"
source "$DEVCONTAINER_LIB_DIR/validation.sh"
source "$DEVCONTAINER_LIB_DIR/herdr.sh"

# ----- ENVIRONMENT VARIABLES --------------------------------------------------

# AGENT_ASSETS_REF       devcontainer-scripts git ref that sync-agent-assets.sh fetches the
#                         machine-wide first-party agent assets from. Falls back to SCRIPTS_REF,
#                         then "main". Not used by the setup modules.
#                         Default: (empty -> SCRIPTS_REF -> main)
#
# AUTO_UPDATE             Automatically fetch and pull updates from remote repository (true/false)
#                         Default: false
#
# CLEAN_CREDENTIALS       Remove git credentials after setup (true/false)
#                         Default: false
#
# DEBUG_MODE              Enable debug output during setup (true/false)
#                         Default: false (can pass --debug flag)
#
# DEFAULT_BRANCH          Git branch to checkout and work with
#                         Default: main
#
# DUMP_ERROR_STACK        Print error stack trace when exiting (true/false)
#                         Default: true
#
# EXTRA_FOLDER_N          Numbered extra workspace folder names (EXTRA_FOLDER_1, EXTRA_FOLDER_2, …),
#                         each already bind-mounted by devcontainer.json at /workspace/<name>.
#                         Read by workspaces.sh to add extra roots to the .code-workspace file.
#                         Default: (none)
#
# GIT_CLONE_TOKEN         Global fallback token for authenticating git clone/fetch against any
#                         HTTP(S) git host. A host with its own GIT_CLONE_TOKEN_<HOST> variable
#                         uses that instead. Set in ~/.config/.env on the host; unset again at
#                         the end of setup when CLEAN_CREDENTIALS is true.
#                         Default: (empty)
#
# GIT_SIGNING_KEY         SSH public key used for commit signing (e.g. "ssh-ed25519 AAAA...")
#                         Set in ~/.config/.env on the host. Required for SSH commit signing
#                         via the forwarded 1Password SSH agent socket.
#                         Default: (empty)
#
# GIT_EMAIL               Email for git configuration (required)
#
# GIT_USER                Git username for git configuration and repository URLs (required)
#
# LOG_FILE                Path to log file (if empty, logs to stdout/stderr only)
#                         Default: (empty)
#
# LOG_LEVEL               Minimum log level: DEBUG, INFO, SUCCESS, WARNING, ERROR, FATAL
#                         Default: INFO
#
# NGROK_AUTHTOKEN         Authentication token for the ngrok tunnel. The ngrok module skips
#                         itself when this is empty. Set in ~/.config/.env on the host.
#                         Default: (empty)
#
# REPO_SOURCE             Where to clone from. Repo name is taken from the workspace folder,
#                         except when a full URL is provided.
#                         Owner shorthand (e.g. "myorg") → github.com/myorg/<folder>.git
#                         Base URL (e.g. "https://gitlab.com/myorg") → <base>/<folder>.git
#                         Full URL (e.g. "https://github.com/org/repo.git") → used as-is
#                         Default: (auto-constructed from GIT_USER)
#
# REQUIRE_DEPENDENCY_INSTALL  Fail container setup when the git module cannot install the
#                         project's dependencies (true/false). When false, a failed install
#                         is logged as a warning and setup continues.
#                         Default: false
#
# SSH_SIGNING             Enable SSH commit signing via Docker Desktop SSH agent forwarding (true/false)
#                         Default: true
#
# STRUCTURED_LOGS         Output logs in JSON format (true/false)
#                         Default: false
#
# VALIDATE_TOKEN          Validate git token connectivity on startup (true/false)
#                         Default: true
#
# PERSIST_<NAME>          Any variable in the .env file whose name begins with PERSIST_ is written
#                         to /etc/environment (with the prefix stripped) by persist_env_vars during
#                         setup, making <NAME> available to all container processes at runtime.
#                         Example: PERSIST_CONTEXT7_API_KEY=xxx → CONTEXT7_API_KEY in /etc/environment

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
