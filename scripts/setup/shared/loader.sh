#!/bin/bash

[[ -n "${_LOADER_SH_LOADED:-}" ]] && return 0
readonly _LOADER_SH_LOADED=1

# Shared utilities loader - Sources all shared utility scripts

# Get the directory of this script
SHARED_DIR="$(dirname "${BASH_SOURCE[0]}")"

# Source all shared utilities
source "$SHARED_DIR/env-loader.sh"
source "$SHARED_DIR/error-handler.sh"
source "$SHARED_DIR/logging.sh"
source "$SHARED_DIR/module-registry.sh"
source "$SHARED_DIR/retry.sh"
source "$SHARED_DIR/validation.sh"

# ----- ENVIRONMENT VARIABLES --------------------------------------------------

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
# REPO_SOURCE             Where to clone from. Repo name is taken from the workspace folder,
#                         except when a full URL is provided.
#                         Owner shorthand (e.g. "myorg") → github.com/myorg/<folder>.git
#                         Base URL (e.g. "https://gitlab.com/myorg") → <base>/<folder>.git
#                         Full URL (e.g. "https://github.com/org/repo.git") → used as-is
#                         Default: (auto-constructed from GIT_USER)
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
SSH_SIGNING="${SSH_SIGNING:-true}"
STRUCTURED_LOGS="${STRUCTURED_LOGS:-false}"
VALIDATE_TOKEN="${VALIDATE_TOKEN:-true}"
