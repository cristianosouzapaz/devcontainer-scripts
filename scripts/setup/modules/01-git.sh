#!/bin/bash
set -euo pipefail

# MODULE_NAME="git"
# MODULE_DESCRIPTION="Configures git credentials, validates token, clones or updates repositories"
# MODULE_ENTRY="git_setup"

# Git repository setup module
#
# This module initializes or updates Git repositories in the container workspace.
# It configures git credentials, validates token access on any HTTPS git host
# (GitHub, GitLab, Gitea, Bitbucket, etc.),
# clones or fetches repositories, and installs dependencies using the package manager
# detected from the project (pnpm, npm, or yarn).
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
# - PROJECT_NAME
# - REPO_SOURCE     
# - REPO_SOURCE_N
# - VALIDATE_TOKEN

# ----- PATH AND STRUCTURE VARIABLES -------------------------------------------

readonly _GIT_CREDENTIALS_FILE="$HOME/.git-credentials"
readonly _PKG_INSTALL_TIMEOUT=180

# Test seam — not readonly so tests can override it
_WORKSPACE_DIR="${_WORKSPACE_DIR:-/workspace}"

# ----- HELPER FUNCTIONS -------------------------------------------------------

# _cleanup_sensitive_data: Unsets GIT_CLONE_TOKEN; removes the credentials file when CLEAN_CREDENTIALS=true.
_cleanup_sensitive_data() {
	unset GIT_CLONE_TOKEN
	[[ "$CLEAN_CREDENTIALS" == "true" ]] && rm -f "$_GIT_CREDENTIALS_FILE"
	return 0
}

# _collect_repo_entries <nameref>: Populates an array with clone URLs from numbered env vars.
# Reads REPO_SOURCE_1, REPO_SOURCE_2, … until the first unset or empty variable.
# Falls back to REPO_SOURCE when no numbered variables are set.
_collect_repo_entries() {
	local -n _out_entries="$1"
	local i=1 url var

	while true; do
		var="REPO_SOURCE_${i}"
		url="${!var:-}"
		[[ -z "$url" ]] && break
		_out_entries+=("$url")
		i=$(( i + 1 ))
	done

	if [[ "${#_out_entries[@]}" -eq 0 ]] && [[ -n "${REPO_SOURCE:-}" ]]; then
		_out_entries+=("${REPO_SOURCE}")
	fi
}

# _configure_git_credentials <repo_url>: Writes the credential store entry for GIT_CLONE_TOKEN.
# Derives the credential host from repo_url; falls back to github.com when repo_url is not HTTPS.
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
			credential_host="github.com"
		fi
		echo "https://${GIT_USER}:${GIT_CLONE_TOKEN}@${credential_host}" >"$_GIT_CREDENTIALS_FILE"
		chmod 600 "$_GIT_CREDENTIALS_FILE"
	fi
	log_success "Git credentials configured"
}

# _detect_package_manager: Prints the package manager to use for the current project.
# Priority: packageManager field in package.json >
#           lock file presence (pnpm-lock.yaml > package-lock.json > yarn.lock) > npm default.
# Logs a warning when multiple lock files are detected.
_detect_package_manager() {
	# 1. packageManager field in package.json (Node.js standard)
	local declared_pm
	declared_pm=$(node -e "try{const p=JSON.parse(require('fs').readFileSync('package.json','utf8'));if(p.packageManager){const m=p.packageManager.match(/^(\w+)@/);if(m)console.log(m[1]);}}catch(e){}" 2>/dev/null || true)
	if [[ -n "$declared_pm" ]]; then
		log_debug "Package manager declared in package.json: ${declared_pm}"
		echo "$declared_pm"
		return 0
	fi

	# 2. Lock file detection — warn when multiple are present
	local -a found_locks=()
	[[ -f "pnpm-lock.yaml" ]]    && found_locks+=("pnpm-lock.yaml")
	[[ -f "package-lock.json" ]] && found_locks+=("package-lock.json")
	[[ -f "yarn.lock" ]]         && found_locks+=("yarn.lock")

	if [[ "${#found_locks[@]}" -gt 1 ]]; then
		log_warning "Multiple lock files found: ${found_locks[*]} — using pnpm > npm > yarn priority"
	fi

	[[ -f "pnpm-lock.yaml" ]]    && echo "pnpm" && return 0
	[[ -f "package-lock.json" ]] && echo "npm"  && return 0
	[[ -f "yarn.lock" ]]         && echo "yarn" && return 0

	# 3. Safe default
	log_debug "No lock file found, defaulting to npm"
	echo "npm"
}

# _install_dependencies: Skips when package.json is absent.
# Detects the package manager via _detect_package_manager and runs the appropriate install.
# When pnpm is used, the store is set to an absolute path outside the workspace.
# Each install attempt is bounded by _PKG_INSTALL_TIMEOUT seconds; for pnpm, the unfrozen
# fallback is skipped when the frozen-lockfile attempt times out (exit code 124).
_install_dependencies() {
	[[ -f "package.json" ]] || {
		log_debug "No package.json found, skipping dependency installation"
		return 0
	}

	local pm install_output exit_code skip_fallback
	pm="$(_detect_package_manager)"
	log_info "Installing dependencies with ${pm}"

	case "$pm" in
		pnpm)
			skip_fallback=false
			pnpm config set store-dir /root/.local/share/pnpm/store >/dev/null 2>&1
			if [[ -f "pnpm-lock.yaml" ]]; then
				exit_code=0
				install_output=$(timeout "$_PKG_INSTALL_TIMEOUT" pnpm install --frozen-lockfile 2>&1) || exit_code=$?
				log_debug "${install_output}"
				if [[ $exit_code -eq 0 ]]; then
					log_success "Dependencies installed with pnpm (frozen-lockfile)"
					return 0
				fi
				if [[ $exit_code -eq 124 ]]; then
					skip_fallback=true
				fi
			fi
			if [[ "$skip_fallback" == false ]]; then
				exit_code=0
				install_output=$(timeout "$_PKG_INSTALL_TIMEOUT" pnpm install 2>&1) || exit_code=$?
				log_debug "${install_output}"
				if [[ $exit_code -eq 0 ]]; then
					log_success "Dependencies installed with pnpm"
					return 0
				fi
			fi
			;;
		yarn)
			exit_code=0
			install_output=$(timeout "$_PKG_INSTALL_TIMEOUT" yarn install --frozen-lockfile --non-interactive 2>&1) || exit_code=$?
			log_debug "${install_output}"
			if [[ $exit_code -eq 0 ]]; then
				log_success "Dependencies installed with yarn"
				return 0
			fi
			;;
		npm)
			exit_code=0
			install_output=$(timeout "$_PKG_INSTALL_TIMEOUT" npm install 2>&1) || exit_code=$?
			log_debug "${install_output}"
			if [[ $exit_code -eq 0 ]]; then
				log_success "Dependencies installed with npm"
				return 0
			fi
			;;
	esac

	push_error "$FATAL_ERROR" "${LINENO}" "_install_dependencies" "${pm} install" "Dependency installation failed"
	log_error "Dependency installation failed with ${pm}"
	return 1
}

# _setup_repository <resolved_url>: Two cases: (1) .git exists → optionally fast-forward merge;
# (2) GIT_CLONE_TOKEN absent → skip; otherwise clones from resolved_url.
# The caller must cd to the target directory before calling this function.
_setup_repository() {
	local resolved_url="${1:-}"
	local current_branch fetch_output merge_output init_output
	log_info "Checking repository status in $(pwd)"

	# CASE 1: Repo exists (volume with previous clone)
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

# _validate_same_host <url...>: Soft check — logs a warning if not all URLs share the same host.
# Always returns 0; same-host enforcement is the responsibility of the PS1 input layer.
_validate_same_host() {
	local first_host="" host url

	for url in "$@"; do
		host="${url#*://}"
		host="${host%%/*}"
		if [[ -z "$first_host" ]]; then
			first_host="$host"
		elif [[ "$host" != "$first_host" ]]; then
			log_warning "Multi-repo: host '${host}' differs from '${first_host}' — same-host constraint may be violated"
		fi
	done
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

# ----- CORE SETUP -------------------------------------------------------------

# git_setup: Module entry point. Collects repository URLs from REPO_SOURCE_N env vars,
# configures git credentials, validates token access, then clones or updates each repository.
# Single-repo (one entry): operates in _WORKSPACE_DIR/<PROJECT_NAME>.
# Multi-repo (two or more entries): loops over all entries, skipping duplicate folder names.
git_setup() {
	local -a _trimmed_entries=()
	local entry folder_name
	local -A _seen_folders=()
	setup_error_traps || true
	register_cleanup _cleanup_sensitive_data

	_collect_repo_entries _trimmed_entries
	if [[ "${#_trimmed_entries[@]}" -eq 0 ]]; then
		log_info "No REPO_SOURCE set — skipping git setup"
		return 0
	fi

	_configure_git_credentials "${_trimmed_entries[0]}" || return 1
	_validate_token_access    "${_trimmed_entries[0]}" || return 1

	if [[ "${#_trimmed_entries[@]}" -eq 1 ]]; then
		cd "${_WORKSPACE_DIR}/${PROJECT_NAME}"
		_setup_repository "${_trimmed_entries[0]}"
		_install_dependencies
	else
		_validate_same_host "${_trimmed_entries[@]}" || true
		for entry in "${_trimmed_entries[@]}"; do
			folder_name="$(repo_entry_folder_name "$entry")"
			if [[ -v "_seen_folders[$folder_name]" ]]; then
				log_warning "Skipping '${entry}': folder '${folder_name}' already processed"
				continue
			fi
			_seen_folders["$folder_name"]=1
			cd "${_WORKSPACE_DIR}/${folder_name}"
			_setup_repository "$entry"
			_install_dependencies
		done
	fi
}
