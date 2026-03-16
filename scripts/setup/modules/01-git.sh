#!/bin/bash
set -euo pipefail

# MODULE_NAME="git"
# MODULE_DESCRIPTION="Configures git credentials, validates token, clones or updates repository"
# MODULE_ENTRY="git_setup"

# Git repository setup module - Simplified for Bind Mounts and Named Volumes
#
# This module initializes or updates a Git repository in the current directory.
# It configures Git credentials, validates GitHub token access, clones or
# fetches the repository, installs dependencies using pnpm or npm, and
# cleans up sensitive data afterward. It leverages shared utilities for logging,
# error handling, retries, and environment variable loading.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(dirname "${BASH_SOURCE[0]}")/../shared/loader.sh"

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# This module uses the following configuration variables:
# - AUTO_UPDATE
# - CLEAN_CREDENTIALS
# - DEFAULT_BRANCH
# - GITHUB_CLONE_TOKEN (from .config/.env)
# - GITHUB_EMAIL
# - GITHUB_USER
# - REPO_SOURCE
# - VALIDATE_TOKEN

# ----- PATH AND STRUCTURE VARIABLES -------------------------------------------

readonly _GIT_CREDENTIALS_FILE="$HOME/.git-credentials"
readonly _GITHUB_API_URL="https://api.github.com/user"
readonly _GITHUB_BASE_URL="https://github.com"
readonly _PNPM_STORE_DIR=".pnpm-store"

# ----- HELPER FUNCTIONS -------------------------------------------------------

# _configure_git_credentials: Sets up Git credentials for authentication
_configure_git_credentials() {
	if ! check_env_var GITHUB_USER; then
		push_error $VALIDATION_ERROR "${LINENO}" "_configure_git_credentials" "GITHUB_USER" "GITHUB_USER is not set"
		log_error "GITHUB_USER is required for git configuration"
		return 1
	fi

	if ! validate_env_var_format GITHUB_EMAIL email; then
		push_error $VALIDATION_ERROR "${LINENO}" "_configure_git_credentials" "GITHUB_EMAIL=${GITHUB_EMAIL}" "Invalid or missing GITHUB_EMAIL"
		log_error "GITHUB_EMAIL is not a valid email address: ${GITHUB_EMAIL}"
		return 1
	fi

	git config --global credential.helper store
	git config --global user.email "${GITHUB_EMAIL}"
	git config --global user.name "${GITHUB_USER}"

	if [[ -n "${GITHUB_CLONE_TOKEN}" ]]; then
		echo "https://${GITHUB_CLONE_TOKEN}@${_GITHUB_BASE_URL#https://}" >"$_GIT_CREDENTIALS_FILE"
		chmod 600 "$_GIT_CREDENTIALS_FILE"
	fi
}

# _validate_github_access: Validates GitHub access using the provided token
_validate_github_access() {
	check_env_var GITHUB_CLONE_TOKEN || {
		log_debug "GITHUB_CLONE_TOKEN not set"
		return 0
	}

	if [[ "${VALIDATE_TOKEN}" == "true" ]] && check_command curl; then
		if retry_curl 3 1 10 -H "Authorization: token $GITHUB_CLONE_TOKEN" "$_GITHUB_API_URL"; then
			log_debug "Token validated"
			return 0
		else
			push_error $AUTH_ERROR "${LINENO}" "_validate_github_access" "curl $_GITHUB_API_URL" "Token validation failed"
			log_error "Token validation failed"
			return 1
		fi
	fi
}

# ----- CORE SETUP -------------------------------------------------------------

# _resolve_repo_url <folder_name>
# Resolves REPO_SOURCE into a full git URL using the following rules:
#   *.git suffix  → used as-is (full explicit URL)
#   contains ://  → base URL on a custom host; appends /<folder>.git
#   non-empty     → GitHub owner/org shorthand; builds github.com/<owner>/<folder>.git
#   empty         → falls back to github.com/<GITHUB_USER>/<folder>.git
# Returns 1 and logs an error if REPO_SOURCE is set but invalid.
_resolve_repo_url() {
	local folder_name="$1"

	if [[ -z "${REPO_SOURCE:-}" ]]; then
		if [[ -n "${GITHUB_USER:-}" ]]; then
			echo "${_GITHUB_BASE_URL}/${GITHUB_USER}/${folder_name}.git"
		fi
		return
	fi

	if [[ "$REPO_SOURCE" == *.git ]]; then
		if ! validate_url "$REPO_SOURCE"; then
			push_error $VALIDATION_ERROR "${LINENO}" "_resolve_repo_url" "REPO_SOURCE=$REPO_SOURCE" "Invalid full URL in REPO_SOURCE"
			return 1
		fi
		echo "$REPO_SOURCE"
	elif [[ "$REPO_SOURCE" == *://* ]]; then
		if ! validate_url "$REPO_SOURCE"; then
			push_error $VALIDATION_ERROR "${LINENO}" "_resolve_repo_url" "REPO_SOURCE=$REPO_SOURCE" "Invalid base URL in REPO_SOURCE"
			return 1
		fi
		echo "${REPO_SOURCE%/}/${folder_name}.git"
	else
		if [[ ! "$REPO_SOURCE" =~ ^[A-Za-z0-9_-]+$ ]]; then
			push_error $VALIDATION_ERROR "${LINENO}" "_resolve_repo_url" "REPO_SOURCE=$REPO_SOURCE" "Invalid owner shorthand in REPO_SOURCE"
			return 1
		fi
		echo "${_GITHUB_BASE_URL}/${REPO_SOURCE}/${folder_name}.git"
	fi
}

# _setup_repository: Initializes or updates the Git repository in the current directory
_setup_repository() {
	local current_branch
	log_info "Checking repository status in $(pwd)"

	# CASE 1: Repo exists (Bind mount with .git or volume with previous clone)
	if [[ -d ".git" ]]; then
		log_info "Existing repository detected"
		if [[ "${AUTO_UPDATE}" == "true" ]]; then
			current_branch=$(git symbolic-ref --short HEAD 2>/dev/null) || true
			if [[ -n "${current_branch}" ]]; then
				git fetch origin "${current_branch}" --quiet &&
					git pull --quiet --ff-only origin "${current_branch}" || \
					log_warning "Could not auto-update repository"
			else
				log_warning "Detached HEAD — skipping auto-update"
			fi
		fi
		return 0
	fi

	# CASE 2: Skip if no token — cannot clone without credentials
	if [[ -z "${GITHUB_CLONE_TOKEN:-}" ]]; then
		log_warning "GITHUB_CLONE_TOKEN not set — skipping repository initialization"
		return 0
	fi

	# CASE 3: Resolve repository source to a full URL
	local current_folder_name resolved_url
	current_folder_name=$(basename "$(pwd)")
	if ! resolved_url="$(_resolve_repo_url "$current_folder_name")"; then
		log_error "Failed to resolve repository URL: invalid REPO_SOURCE='${REPO_SOURCE:-}'"
		return 1
	fi

	log_info "Initializing repository from $resolved_url"
	git init -b "$DEFAULT_BRANCH"
	git remote add origin "$resolved_url"
	git fetch origin

	# Try to checkout without overwriting existing local config files
	if git checkout "$DEFAULT_BRANCH" 2>/dev/null; then
		log_success "Repository initialized"
	else
		log_warning "Repository initialized but checkout skipped (conflicts likely). Please check manually"
	fi
}

# _install_dependencies: Installs project dependencies using pnpm or npm
_install_dependencies() {
	local pnpm_store_dir="${1:-.pnpm-store}"

	[[ -f "package.json" ]] || {
		log_debug "No package.json found, skipping dependency installation"
		return 0
	}

	log_info "Installing dependencies"
	pnpm config set store-dir "$pnpm_store_dir"

	if pnpm install --frozen-lockfile >/dev/null 2>&1; then
		log_success "Dependencies installed with pnpm"
		return 0
	elif pnpm install >/dev/null 2>&1; then
		log_success "Dependencies installed with pnpm (fallback)"
		return 0
	elif check_command npm && npm install >/dev/null 2>&1; then
		log_warning "pnpm failed, fell back to npm"
		log_success "Dependencies installed with npm"
		return 0
	else
		push_error $FATAL_ERROR "${LINENO}" "_install_dependencies" "pnpm/npm install" "Dependency installation failed"
		log_error "Dependency installation failed"
		return 1
	fi
}

# _cleanup_sensitive_data: Removes sensitive data from environment and files
_cleanup_sensitive_data() {
	unset GITHUB_CLONE_TOKEN
	[[ "$CLEAN_CREDENTIALS" == "true" ]] && rm -f "$_GIT_CREDENTIALS_FILE"
	return 0
}

# ----- CORE SETUP -------------------------------------------------------------

# git_setup: Entry point for the git module.
# Configures credentials, validates token access, clones or updates the
# repository, and installs project dependencies.
# Returns: 0 on success, 1 on failure.
git_setup() {
	log_info "Starting Git setup"
	setup_error_traps || true
	register_cleanup _cleanup_sensitive_data

	if ! _configure_git_credentials; then
		return 1
	fi
	if ! _validate_github_access; then
		return 1
	fi

	_setup_repository
	_install_dependencies "$_PNPM_STORE_DIR"
}
