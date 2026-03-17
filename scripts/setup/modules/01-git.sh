#!/bin/bash
set -euo pipefail

# MODULE_NAME="git"
# MODULE_DESCRIPTION="Configures git credentials, validates token, clones or updates repository"
# MODULE_ENTRY="git_setup"

# Git repository setup module - Simplified for Bind Mounts and Named Volumes
#
# This module initializes or updates a Git repository in the current directory.
# It configures git credentials, validates token access on any HTTPS git host
# (GitHub, GitLab, Gitea, Bitbucket, etc.),
# clones or fetches the repository, and installs dependencies using pnpm or npm.
# Shared utilities provide logging, error handling, and environment variable loading.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(dirname "${BASH_SOURCE[0]}")/../shared/loader.sh"

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# This module uses the following configuration variables:
# - AUTO_UPDATE
# - CLEAN_CREDENTIALS
# - DEFAULT_BRANCH
# - GIT_CLONE_TOKEN (from .config/.env)
# - GIT_EMAIL
# - GIT_USER
# - REPO_SOURCE
# - VALIDATE_TOKEN

# ----- PATH AND STRUCTURE VARIABLES -------------------------------------------

readonly _GIT_CREDENTIALS_FILE="$HOME/.git-credentials"
readonly _GITHUB_BASE_URL="https://github.com"

# ----- HELPER FUNCTIONS -------------------------------------------------------

# _configure_git_credentials <repo_url>: Writes the credential store entry for GIT_CLONE_TOKEN.
# Derives the credential host from repo_url; falls back to github.com when repo_url is empty.
_configure_git_credentials() {
	local repo_url="${1:-}" credential_host
	if ! check_env_var GIT_USER; then
		push_error "$VALIDATION_ERROR" "${LINENO}" "_configure_git_credentials" "GIT_USER" "GIT_USER is not set"
		log_error "GIT_USER is required for git configuration"
		return 1
	fi

	if ! validate_env_var_format GIT_EMAIL email; then
		push_error "$VALIDATION_ERROR" "${LINENO}" "_configure_git_credentials" "GIT_EMAIL=${GIT_EMAIL}" "Invalid or missing GIT_EMAIL"
		log_error "GIT_EMAIL is not a valid email address: ${GIT_EMAIL}"
		return 1
	fi

	git config --global credential.helper ''
	git config --global credential.helper store
	git config --global user.email "${GIT_EMAIL}"
	git config --global user.name "${GIT_USER}"

	if [[ -n "${GIT_CLONE_TOKEN}" ]]; then
		if [[ "$repo_url" == https://* ]]; then
			credential_host="${repo_url#https://}"
			credential_host="${credential_host%%/*}"
		else
			credential_host="${_GITHUB_BASE_URL#https://}"
		fi
		echo "https://${GIT_USER}:${GIT_CLONE_TOKEN}@${credential_host}" >"$_GIT_CREDENTIALS_FILE"
		chmod 600 "$_GIT_CREDENTIALS_FILE"
	fi
	log_success "Git credentials configured"
}

# _validate_token_access <repo_url>: Runs git ls-remote to confirm token access.
# No-ops when GIT_CLONE_TOKEN is unset, VALIDATE_TOKEN != true, or url is empty.
# Relies on the credential store written by _configure_git_credentials.
_validate_token_access() {
	local url="${1:-}"
	check_env_var GIT_CLONE_TOKEN || { log_debug "GIT_CLONE_TOKEN not set"; return 0; }
	[[ "${VALIDATE_TOKEN}" == "true" ]] || return 0
	[[ -n "$url" ]] || { log_debug "No repo URL — skipping token validation"; return 0; }
	log_debug "Validating token via git ls-remote $url"
	if git ls-remote "$url" HEAD >/dev/null 2>&1; then
		log_success "Token validated"
	else
		push_error "$AUTH_ERROR" "${LINENO}" "_validate_token_access" "git ls-remote $url" "Token validation failed"
		log_error "Token validation failed"
		return 1
	fi
}

# _resolve_repo_url <folder_name>: Builds a full clone URL from REPO_SOURCE and folder_name.
#   *.git suffix  → used as-is
#   contains ://  → treated as base URL; appends /<folder_name>.git
#   plain string  → GitHub owner/org shorthand; builds github.com/<owner>/<folder_name>.git
#   empty         → falls back to github.com/<GIT_USER>/<folder_name>.git
# Returns 1 if REPO_SOURCE is set but fails validation.
_resolve_repo_url() {
	local folder_name="$1"

	if [[ -z "${REPO_SOURCE:-}" ]]; then
		if [[ -n "${GIT_USER:-}" ]]; then
			echo "${_GITHUB_BASE_URL}/${GIT_USER}/${folder_name}.git"
		fi
		return
	fi

	if [[ "$REPO_SOURCE" == *.git ]]; then
		if ! validate_url "$REPO_SOURCE"; then
			push_error "$VALIDATION_ERROR" "${LINENO}" "_resolve_repo_url" "REPO_SOURCE=$REPO_SOURCE" "Invalid full URL in REPO_SOURCE"
			return 1
		fi
		echo "$REPO_SOURCE"
	elif [[ "$REPO_SOURCE" == *://* ]]; then
		if ! validate_url "$REPO_SOURCE"; then
			push_error "$VALIDATION_ERROR" "${LINENO}" "_resolve_repo_url" "REPO_SOURCE=$REPO_SOURCE" "Invalid base URL in REPO_SOURCE"
			return 1
		fi
		echo "${REPO_SOURCE%/}/${folder_name}.git"
	else
		if [[ ! "$REPO_SOURCE" =~ ^[A-Za-z0-9_-]+$ ]]; then
			push_error "$VALIDATION_ERROR" "${LINENO}" "_resolve_repo_url" "REPO_SOURCE=$REPO_SOURCE" "Invalid owner shorthand in REPO_SOURCE"
			return 1
		fi
		echo "${_GITHUB_BASE_URL}/${REPO_SOURCE}/${folder_name}.git"
	fi
}

# _setup_repository <resolved_url>: Three cases: (1) .git exists → optionally fast-forward merge;
# (2) GIT_CLONE_TOKEN absent → skip; (3) no .git → init, add remote, fetch, and checkout.
_setup_repository() {
	local resolved_url="${1:-}"
	local current_branch fetch_output merge_output init_output current_folder_name
	log_info "Checking repository status in $(pwd)"

	# CASE 1: Repo exists (Bind mount with .git or volume with previous clone)
	if [[ -d ".git" ]]; then
		log_info "Existing repository detected"
		if [[ "${AUTO_UPDATE}" == "true" ]]; then
			current_branch=$(git symbolic-ref --short HEAD 2>/dev/null) || true
			if [[ -n "${current_branch}" ]]; then
				log_debug "Fetching origin/${current_branch}"
				fetch_output=$(git fetch origin "${current_branch}" 2>&1) || {
					log_warning "Could not auto-update repository"
					return 0
				}
				log_debug "${fetch_output}"
				merge_output=$(git merge --ff-only "origin/${current_branch}" 2>&1) || {
					log_warning "Could not auto-update repository"
					return 0
				}
				log_debug "${merge_output}"
				if [[ "${merge_output}" == *"Already up to date"* ]]; then
					log_info "Repository already up to date"
				else
					log_success "Repository auto-updated"
				fi
			else
				log_warning "Detached HEAD — skipping auto-update"
			fi
		fi
		return 0
	fi

	# CASE 2: Skip if no token — cannot clone without credentials
	if [[ -z "${GIT_CLONE_TOKEN:-}" ]]; then
		log_warning "GIT_CLONE_TOKEN not set — skipping repository initialization"
		return 0
	fi

	# CASE 3: Resolve repository source to a full URL
	if [[ -z "$resolved_url" ]]; then
		current_folder_name=$(basename "$(pwd)")
		if ! resolved_url="$(_resolve_repo_url "$current_folder_name")"; then
			log_error "Failed to resolve repository URL: invalid REPO_SOURCE='${REPO_SOURCE:-}'"
			return 1
		fi
	fi

	log_info "Initializing repository from $resolved_url"
	init_output=$(git init -b "$DEFAULT_BRANCH" 2>&1)
	log_debug "${init_output}"
	git remote add origin "$resolved_url"
	fetch_output=$(git fetch origin 2>&1)
	log_debug "${fetch_output}"

	# Try to checkout without overwriting existing local config files
	local checkout_output
	if checkout_output=$(git checkout "$DEFAULT_BRANCH" 2>&1); then
		log_debug "${checkout_output}"
		log_success "Repository initialized"
	else
		log_debug "${checkout_output}"
		log_warning "Repository initialized but checkout skipped (conflicts likely). Please check manually"
	fi
}

# _install_dependencies [pnpm_store_dir]: Skips when package.json is absent.
# Tries pnpm frozen-lockfile, then pnpm (no lockfile), then npm as a last resort.
_install_dependencies() {
	local pnpm_store_dir="${1:-.pnpm-store}"

	[[ -f "package.json" ]] || {
		log_debug "No package.json found, skipping dependency installation"
		return 0
	}

	log_info "Installing dependencies"
	pnpm config set store-dir "$pnpm_store_dir" >/dev/null 2>&1

	log_debug "Attempting pnpm install --frozen-lockfile"
	if pnpm install --frozen-lockfile >/dev/null 2>&1; then
		log_success "Dependencies installed with pnpm"
		return 0
	fi
	log_debug "Attempting pnpm install (no lockfile)"
	if pnpm install >/dev/null 2>&1; then
		log_success "Dependencies installed with pnpm (fallback)"
		return 0
	fi
	log_debug "Attempting npm install"
	if check_command npm && npm install >/dev/null 2>&1; then
		log_warning "pnpm failed, fell back to npm"
		log_success "Dependencies installed with npm"
		return 0
	else
		push_error "$FATAL_ERROR" "${LINENO}" "_install_dependencies" "pnpm/npm install" "Dependency installation failed"
		log_error "Dependency installation failed"
		return 1
	fi
}

# _cleanup_sensitive_data: Unsets GIT_CLONE_TOKEN; removes the credentials file when CLEAN_CREDENTIALS=true.
_cleanup_sensitive_data() {
	unset GIT_CLONE_TOKEN
	[[ "$CLEAN_CREDENTIALS" == "true" ]] && rm -f "$_GIT_CREDENTIALS_FILE"
	return 0
}

# ----- CORE SETUP -------------------------------------------------------------

# git_setup: Module entry point. Orchestrates _configure_git_credentials,
# _validate_token_access, _setup_repository, and _install_dependencies.
git_setup() {
	local folder_name repo_url
	setup_error_traps || true
	register_cleanup _cleanup_sensitive_data

	folder_name=$(basename "$(pwd)")
	repo_url="$(_resolve_repo_url "$folder_name")" || repo_url=""

	if ! _configure_git_credentials "$repo_url"; then
		return 1
	fi
	if ! _validate_token_access "$repo_url"; then
		return 1
	fi

	_setup_repository "$repo_url"
	_install_dependencies
}
