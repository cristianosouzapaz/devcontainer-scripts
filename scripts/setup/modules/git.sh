#!/bin/bash
set -euo pipefail

# MODULE_NAME="git"
# MODULE_DESCRIPTION="Configures git credentials, validates token, clones or updates repositories"
# MODULE_ENTRY="git_setup"
# MODULE_AFTER="persistent-data"

# ----- OVERVIEW ---------------------------------------------------------------
#
# Initializes or updates the project's Git repositories in the container
# workspace: configures credentials, validates token access on any HTTP(S) Git
# host (GitHub, GitLab, Gitea, Bitbucket, …) resolving one clone token per host
# (see GIT_CLONE_TOKEN_<HOST>) so repos from different hosts can be mixed, then
# clones or fetches each repo and installs dependencies with the detected
# package manager (pnpm, npm, or yarn).

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(dirname "${BASH_SOURCE[0]}")/../lib/loader.sh"

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# This module uses the following configuration variables:
# - AUTO_UPDATE
# - CLEAN_CREDENTIALS
# - DEFAULT_BRANCH
# - GIT_CLONE_TOKEN (from .config/.env) — global fallback token
# - GIT_CLONE_TOKEN_<HOST> (from .config/.env) — per-host override, e.g. GIT_CLONE_TOKEN_GITLAB_EXAMPLE_COM
# - GIT_EMAIL
# - GIT_USER
# - PROJECT_NAME
# - REPO_SOURCE
# - REPO_SOURCE_N
# - REQUIRE_DEPENDENCY_INSTALL
# - VALIDATE_TOKEN

# ----- CONSTANTS --------------------------------------------------------------

readonly _GIT_CREDENTIALS_FILE="$HOME/.git-credentials"

# Test seams — not readonly so tests can override them
# _PKG_INSTALL_TIMEOUT: per-attempt dependency-install timeout, in seconds.
_PKG_INSTALL_TIMEOUT="${_PKG_INSTALL_TIMEOUT:-300}"
_WORKSPACE_DIR="${_WORKSPACE_DIR:-/workspace}"

# ----- HELPER FUNCTIONS -------------------------------------------------------

# cleanup_sensitive_data: Unsets GIT_CLONE_TOKEN and any per-host GIT_CLONE_TOKEN_* vars;
# removes the credentials file when CLEAN_CREDENTIALS=true.
cleanup_sensitive_data() {
	local var_name
	unset GIT_CLONE_TOKEN
	for var_name in "${!GIT_CLONE_TOKEN_@}"; do
		unset "$var_name"
	done
	[[ "$CLEAN_CREDENTIALS" == "true" ]] && rm -f "$_GIT_CREDENTIALS_FILE"
	return 0
}

# url_host <url>: Extracts "host[:port]" from a URL of any scheme (https://, http://, ...).
# Prints an empty string when the URL has no recognisable "scheme://" prefix.
url_host() {
	local url="${1:-}" host
	[[ "$url" == *://* ]] || { echo ""; return 0; }
	host="${url#*://}"
	host="${host%%/*}"
	echo "$host"
}

# url_scheme <url>: Extracts the scheme (e.g. "https") from a URL. Defaults to "https".
url_scheme() {
	local url="${1:-}"
	if [[ "$url" == *://* ]]; then
		echo "${url%%://*}"
	else
		echo "https"
	fi
}

# token_env_var_name <host>: Computes the per-host token variable name.
# Normalizes the host to uppercase, replacing every non-alphanumeric character with "_".
# Example: gitlab.example.com -> GIT_CLONE_TOKEN_GITLAB_EXAMPLE_COM
token_env_var_name() {
	local host="${1:-}" normalized
	normalized=$(printf '%s' "${host^^}" | tr -c 'A-Z0-9' '_')
	echo "GIT_CLONE_TOKEN_${normalized}"
}

# resolve_token_for_host <host>: Resolves the clone token for a given host.
# Priority: host-specific GIT_CLONE_TOKEN_<HOST> > global GIT_CLONE_TOKEN fallback.
# Prints an empty string when neither is set.
resolve_token_for_host() {
	local host="${1:-}" var_name
	var_name=$(token_env_var_name "$host")
	if [[ -n "${!var_name:-}" ]]; then
		echo "${!var_name}"
	else
		echo "${GIT_CLONE_TOKEN:-}"
	fi
}

# configure_git_credentials <repo_url...>: Writes one credential store entry per unique host
# found among the given repo URLs, resolving each host's token via resolve_token_for_host.
# Preserves each URL's actual scheme (http/https). Hosts with no resolvable token are skipped
# with a warning. Called with a single URL for the credential.helper bootstrap even when no
# repo URLs are known yet (repo_url may be empty in that case).
configure_git_credentials() {
	if ! check_env_var GIT_USER; then
		push_error "$VALIDATION_ERROR" "${LINENO}" "configure_git_credentials" "GIT_USER" "GIT_USER is not set"
		log_error "GIT_USER is required for git configuration"
		return 1
	fi

	if ! validate_env_var_format GIT_EMAIL email; then
		push_error "$VALIDATION_ERROR" "${LINENO}" "configure_git_credentials" "GIT_EMAIL=${GIT_EMAIL}" "Invalid or missing GIT_EMAIL"
		log_error "GIT_EMAIL is not a valid email address: ${GIT_EMAIL}"
		return 1
	fi

	git config --global credential.helper ''
	git config --global credential.helper store
	git config --global user.email "${GIT_EMAIL}"
	git config --global user.name "${GIT_USER}"

	local -a repo_urls=("$@")
	local -A _seen_hosts=()
	local url host scheme token credential_lines=""

	for url in "${repo_urls[@]}"; do
		[[ -n "$url" ]] || continue
		host=$(url_host "$url")
		[[ -n "$host" ]] || continue
		[[ -v "_seen_hosts[$host]" ]] && continue
		_seen_hosts["$host"]=1

		token=$(resolve_token_for_host "$host")
		if [[ -z "$token" ]]; then
			log_item_warning "No GIT_CLONE_TOKEN resolvable for host '${host}' — credentials not written for it"
			continue
		fi

		scheme=$(url_scheme "$url")
		credential_lines+="${scheme}://${GIT_USER}:${token}@${host}"$'\n'
	done

	if [[ -n "$credential_lines" ]]; then
		printf '%s' "$credential_lines" >"$_GIT_CREDENTIALS_FILE"
		chmod 600 "$_GIT_CREDENTIALS_FILE"
	fi
	log_item_success "Git credentials configured"
}

# detect_package_manager: Prints the package manager to use for the current project.
# Priority: packageManager field in package.json >
#           lock file presence (pnpm-lock.yaml > package-lock.json > yarn.lock) > npm default.
# Logs a warning when multiple lock files are detected.
detect_package_manager() {
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
		log_item_warning "Multiple lock files found: ${found_locks[*]} — using pnpm > npm > yarn priority"
	fi

	[[ -f "pnpm-lock.yaml" ]]    && echo "pnpm" && return 0
	[[ -f "package-lock.json" ]] && echo "npm"  && return 0
	[[ -f "yarn.lock" ]]         && echo "yarn" && return 0

	# 3. Safe default
	log_debug "No lock file found, defaulting to npm"
	echo "npm"
}

# install_dependencies: Skips when package.json is absent.
# Detects the package manager via detect_package_manager and runs the appropriate install.
# When pnpm is used, the store is set to an absolute path outside the workspace (persisted
# by the persistent-data module) and the network retry budget is widened for slow registries.
# Each install attempt is bounded by _PKG_INSTALL_TIMEOUT seconds. Pnpm receives --force so
# a persisted, incompatible node_modules directory is recreated without an interactive prompt;
# its unfrozen fallback is skipped when the frozen-lockfile attempt times out (exit code 124).
# A failed install is logged as a warning and returns 0 unless REQUIRE_DEPENDENCY_INSTALL=true,
# which restores the fatal push_error / non-zero return.
install_dependencies() {
	[[ -f "package.json" ]] || {
		log_debug "No package.json found, skipping dependency installation"
		return 0
	}

	local pm exit_code skip_fallback
	pm="$(detect_package_manager)"
	start_spinner "Installing dependencies with ${pm}"

	case "$pm" in
		pnpm)
			skip_fallback=false
			pnpm config set store-dir /root/.local/share/pnpm/store >/dev/null 2>&1
			# Widen the network retry budget for slow registries: 5 retries, 120s cap.
			pnpm config set fetch-retries 5 >/dev/null 2>&1
			pnpm config set fetch-retry-maxtimeout 120000 >/dev/null 2>&1
			if [[ -f "pnpm-lock.yaml" ]]; then
				exit_code=0
				spinner_stream log_debug timeout "$_PKG_INSTALL_TIMEOUT" pnpm install --frozen-lockfile --force || exit_code=$?
				if [[ $exit_code -eq 0 ]]; then
					spinner_cleanup
					log_item_success "Dependencies installed with pnpm (frozen-lockfile)"
					return 0
				fi
				if [[ $exit_code -eq 124 ]]; then
					skip_fallback=true
				fi
			fi
			if [[ "$skip_fallback" == false ]]; then
				exit_code=0
				spinner_stream log_debug timeout "$_PKG_INSTALL_TIMEOUT" pnpm install --force || exit_code=$?
				if [[ $exit_code -eq 0 ]]; then
					spinner_cleanup
					log_item_success "Dependencies installed with pnpm"
					return 0
				fi
			fi
			;;
		yarn)
			exit_code=0
			spinner_stream log_debug timeout "$_PKG_INSTALL_TIMEOUT" yarn install --frozen-lockfile --non-interactive || exit_code=$?
			if [[ $exit_code -eq 0 ]]; then
				spinner_cleanup
				log_item_success "Dependencies installed with yarn"
				return 0
			fi
			;;
		npm)
			exit_code=0
			spinner_stream log_debug timeout "$_PKG_INSTALL_TIMEOUT" npm install || exit_code=$?
			if [[ $exit_code -eq 0 ]]; then
				spinner_cleanup
				log_item_success "Dependencies installed with npm"
				return 0
			fi
			;;
	esac

	spinner_cleanup
	if [[ "${REQUIRE_DEPENDENCY_INSTALL}" == "true" ]]; then
		push_error "$FATAL_ERROR" "${LINENO}" "install_dependencies" "${pm} install" "Dependency installation failed"
		log_error "Dependency installation failed with ${pm}"
		return 1
	fi
	log_item_warning "Dependency installation failed with ${pm} — run '${pm} install' in the container to retry"
	return 0
}

# setup_repository <resolved_url>: Two cases: (1) .git exists → optionally fast-forward merge;
# (2) no token resolvable for resolved_url's host → skip; otherwise clones from resolved_url.
# The caller must cd to the target directory before calling this function.
setup_repository() {
	local resolved_url="${1:-}"
	local current_branch fetch_output merge_output
	log_detail "Checking repository status in $(pwd)"

	# CASE 1: Repo exists (volume with previous clone)
	if [[ -d ".git" ]]; then
		log_detail "Existing repository detected"
		if [[ "${AUTO_UPDATE}" == "true" ]]; then
			current_branch=$(git symbolic-ref --short HEAD 2>/dev/null) || true
			if [[ -n "${current_branch}" ]]; then
				log_debug "Fetching origin/${current_branch}"
				fetch_output=$(git fetch origin "${current_branch}" 2>&1) || {
					log_item_warning "Could not auto-update repository"
					return 0
				}
				log_debug "${fetch_output}"
				merge_output=$(git merge --ff-only "origin/${current_branch}" 2>&1) || {
					log_item_warning "Could not auto-update repository"
					return 0
				}
				log_debug "${merge_output}"
				if [[ "${merge_output}" == *"Already up to date"* ]]; then
					log_item_success "Repository already up to date"
				else
					log_item_success "Repository auto-updated"
				fi
			else
				log_item_warning "Detached HEAD — skipping auto-update"
			fi
		fi
		return 0
	fi

	# CASE 2: Skip if no token resolvable for this host — cannot clone without credentials
	local resolved_host resolved_token
	resolved_host=$(url_host "$resolved_url")
	resolved_token=$(resolve_token_for_host "$resolved_host")
	if [[ -z "$resolved_token" ]]; then
		log_item_warning "No GIT_CLONE_TOKEN resolvable for host '${resolved_host}' — skipping repository initialization"
		return 0
	fi

	start_spinner "Cloning repository from $resolved_url"
	spinner_stream log_debug git init -b "$DEFAULT_BRANCH"
	git remote add origin "$resolved_url"
	spinner_stream log_debug git fetch origin
	spinner_cleanup

	# Try to checkout without overwriting existing local config files
	local checkout_output
	if checkout_output=$(git checkout "$DEFAULT_BRANCH" 2>&1); then
		log_debug "${checkout_output}"
		log_item_success "Repository initialized"
	else
		log_debug "${checkout_output}"
		log_item_warning "Repository initialized but checkout skipped (conflicts likely). Please check manually"
	fi
}

# validate_same_host <url...>: Informational only — logs when a multi-repo setup spans more
# than one host. Multi-host setups are fully supported (each host resolves its own token via
# resolve_token_for_host); this is not a constraint, just a heads-up for the log.
validate_same_host() {
	local first_host="" host url

	for url in "$@"; do
		host=$(url_host "$url")
		if [[ -z "$first_host" ]]; then
			first_host="$host"
		elif [[ "$host" != "$first_host" ]]; then
			log_item_warning "Multi-repo: host '${host}' differs from '${first_host}' — same-host constraint may be violated"
		fi
	done
}

# validate_token_access <repo_url>: Runs git ls-remote to confirm token access.
# No-ops when no token is resolvable for the URL's host, VALIDATE_TOKEN != true, or url is empty.
# Relies on the credential store written by configure_git_credentials.
validate_token_access() {
	local url="${1:-}" host token
	host=$(url_host "$url")
	token=$(resolve_token_for_host "$host")
	[[ -n "$token" ]] || { log_debug "No resolvable GIT_CLONE_TOKEN for validation"; return 0; }
	[[ "${VALIDATE_TOKEN}" == "true" ]] || return 0
	[[ -n "$url" ]] || { log_debug "No repo URL — skipping token validation"; return 0; }
	log_debug "Validating token via git ls-remote $url"
	if git ls-remote "$url" HEAD >/dev/null 2>&1; then
		log_item_success "Token validated"
	else
		push_error "$AUTH_ERROR" "${LINENO}" "validate_token_access" "git ls-remote $url" "Token validation failed"
		log_error "Token validation failed"
		return 1
	fi
}

# ----- CORE SETUP -------------------------------------------------------------

# git_setup: Module entry point. Collects repository URLs from REPO_SOURCE_N env vars,
# configures git credentials, validates token access, then clones or updates each repository.
# Single-repo (one entry): operates in _WORKSPACE_DIR/<PROJECT_NAME>.
# Multi-repo (two or more entries): loops over all entries, skipping duplicate folder names.
# A dependency-install failure only aborts the module when REQUIRE_DEPENDENCY_INSTALL=true
# (see install_dependencies), and in multi-repo only after every repo has been attempted.
git_setup() {
	local -a _trimmed_entries=()
	local entry folder_name
	local -A _seen_folders=()
	local deps_failed=false
	setup_error_traps
	register_cleanup cleanup_sensitive_data

	collect_numbered_repo_entries _trimmed_entries REPO_SOURCE
	if [[ "${#_trimmed_entries[@]}" -eq 0 ]]; then
		log_debug "No REPO_SOURCE set — skipping git setup"
		module_skip
		return 0
	fi

	configure_git_credentials "${_trimmed_entries[@]}" || return 1

	if [[ "${#_trimmed_entries[@]}" -eq 1 ]]; then
		validate_token_access "${_trimmed_entries[0]}" || return 1
		mkdir -p "${_WORKSPACE_DIR}/${PROJECT_NAME}"
		cd "${_WORKSPACE_DIR}/${PROJECT_NAME}"
		setup_repository "${_trimmed_entries[0]}"
		install_dependencies || return 1
	else
		validate_same_host "${_trimmed_entries[@]}" || true
		for entry in "${_trimmed_entries[@]}"; do
			folder_name="$(repo_entry_folder_name "$entry")"
			if [[ -v "_seen_folders[$folder_name]" ]]; then
				log_item_warning "Skipping '${entry}': folder '${folder_name}' already processed"
				continue
			fi
			_seen_folders["$folder_name"]=1
			validate_token_access "$entry" || return 1
			mkdir -p "${_WORKSPACE_DIR}/${folder_name}"
			cd "${_WORKSPACE_DIR}/${folder_name}"
			setup_repository "$entry"
			install_dependencies || deps_failed=true
		done
		if [[ "$deps_failed" == true ]]; then
			return 1
		fi
	fi
}

export -f cleanup_sensitive_data url_host url_scheme token_env_var_name resolve_token_for_host configure_git_credentials detect_package_manager install_dependencies setup_repository validate_same_host validate_token_access git_setup
