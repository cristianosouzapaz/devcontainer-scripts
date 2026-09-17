#!/bin/bash
set -euo pipefail

# MODULE_NAME="git"
# MODULE_DESCRIPTION="Configures git credentials, validates token, clones or updates repositories"
# MODULE_ENTRY="git_setup"
# MODULE_AFTER="persistent-data"
# MODULE_SECRETS="GIT_CLONE_TOKEN GIT_CLONE_TOKEN_*"

# ----- OVERVIEW ---------------------------------------------------------------
#
# Clones or updates the project's Git repositories in the workspace and installs
# their dependencies. One clone token is resolved per host (GIT_CLONE_TOKEN_<HOST>,
# then GIT_CLONE_TOKEN), so repositories from different HTTP(S) hosts can be mixed.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../lib" && pwd)/loader.sh"

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# Documented in README.md#configuration-variables:
# - AUTO_UPDATE
# - CLEAN_CREDENTIALS
# - DEFAULT_BRANCH
# - GIT_CLONE_TOKEN
# - GIT_CLONE_TOKEN_<HOST>
# - GIT_EMAIL
# - GIT_USER
# - PROJECT_NAME
# - REPO_SOURCE
# - REPO_SOURCE_N
# - REQUIRE_DEPENDENCY_INSTALL
# - VALIDATE_TOKEN

# ----- INTERNAL CONSTANTS -----------------------------------------------------

readonly _GIT_CREDENTIALS_FILE="$HOME/.git-credentials"

_PKG_INSTALL_TIMEOUT="${_PKG_INSTALL_TIMEOUT:-300}"
_WORKSPACE_DIR="${_WORKSPACE_DIR:-/workspace}"

# ----- HELPER FUNCTIONS -------------------------------------------------------

# unset_clone_tokens: unsets GIT_CLONE_TOKEN and every GIT_CLONE_TOKEN_<HOST>
# Notes: registered as a module cleanup, so run_module runs it right after git_setup
#   ends, whatever its outcome, and no later module sees a clone token.
unset_clone_tokens() {
	local var_name
	unset GIT_CLONE_TOKEN
	for var_name in "${!GIT_CLONE_TOKEN_@}"; do
		unset "$var_name"
	done
	return 0
}

# remove_credentials_store: removes the git credentials file on exit when CLEAN_CREDENTIALS is true
remove_credentials_store() {
	[[ "$CLEAN_CREDENTIALS" == "true" ]] && rm -f "$_GIT_CREDENTIALS_FILE"
	return 0
}

# url_host <url>: prints the host[:port] of a scheme:// URL, or an empty line for any other address
url_host() {
	local url="${1:-}" host
	[[ "$url" == *://* ]] || { echo ""; return 0; }
	host="${url#*://}"
	host="${host%%/*}"
	echo "$host"
}

# url_scheme <url>: prints the scheme of a scheme:// URL
url_scheme() {
	local url="${1:-}"
	echo "${url%%://*}"
}

# token_env_var_name <host>: prints the per-host token variable name (gitlab.example.com → GIT_CLONE_TOKEN_GITLAB_EXAMPLE_COM)
token_env_var_name() {
	local host="${1:-}" normalized
	normalized=$(printf '%s' "${host^^}" | tr -c 'A-Z0-9' '_')
	echo "GIT_CLONE_TOKEN_${normalized}"
}

# resolve_token_for_host <host>: prints GIT_CLONE_TOKEN_<HOST>, else GIT_CLONE_TOKEN, else an empty line
resolve_token_for_host() {
	local host="${1:-}" var_name
	var_name=$(token_env_var_name "$host")
	if [[ -n "${!var_name:-}" ]]; then
		echo "${!var_name}"
	else
		echo "${GIT_CLONE_TOKEN:-}"
	fi
}

# configure_git_credentials <repo_url...>: sets git's identity and writes one credential store entry per host among the URLs, keeping each URL's scheme
# Notes: an address with no scheme:// host (a path, an scp-style address) gets no
#   entry; a host with no resolvable token is skipped with a warning.
configure_git_credentials() {
	local -a repo_urls=("$@")
	local -A seen_hosts=()
	local url host scheme token credential_lines=""

	if ! check_env_var GIT_USER; then
		push_error "$DEVCONTAINER_VALIDATION_ERROR" "${LINENO}" "configure_git_credentials" "GIT_USER" "GIT_USER is not set"
		log_error "GIT_USER is required for git configuration"
		return 1
	fi

	if ! validate_env_var_format GIT_EMAIL email; then
		push_error "$DEVCONTAINER_VALIDATION_ERROR" "${LINENO}" "configure_git_credentials" "GIT_EMAIL=${GIT_EMAIL}" "Invalid or missing GIT_EMAIL"
		log_error "GIT_EMAIL is not a valid email address: ${GIT_EMAIL}"
		return 1
	fi

	git config --global credential.helper store
	git config --global user.email "${GIT_EMAIL}"
	git config --global user.name "${GIT_USER}"

	for url in "${repo_urls[@]}"; do
		host=$(url_host "$url")
		[[ -n "$host" ]] || continue
		[[ -v "seen_hosts[$host]" ]] && continue
		seen_hosts["$host"]=1

		token=$(resolve_token_for_host "$host")
		if [[ -z "$token" ]]; then
			log_item_warning "No GIT_CLONE_TOKEN resolvable for host '${host}' — credentials not written for it"
			continue
		fi

		scheme=$(url_scheme "$url")
		credential_lines+="${scheme}://${GIT_USER}:${token}@${host}"$'\n'
	done

	if [[ -n "$credential_lines" ]]; then
		atomic_write "$_GIT_CREDENTIALS_FILE" printf '%s' "$credential_lines"
		chmod 600 "$_GIT_CREDENTIALS_FILE"
	fi
	log_item_success "Git credentials configured"
}

# detect_package_manager: prints the package manager from package.json's packageManager, else from the lock file (pnpm > npm > yarn, warning when several exist), else npm
detect_package_manager() {
	local declared_pm=""
	local -a found_locks=()
	if check_command node; then
		declared_pm=$(node -e "try{const p=JSON.parse(require('fs').readFileSync('package.json','utf8'));if(p.packageManager){const m=p.packageManager.match(/^(\w+)@/);if(m)console.log(m[1]);}}catch(e){}" 2>/dev/null || true)
	fi
	if [[ -n "$declared_pm" ]]; then
		log_debug "Package manager declared in package.json: ${declared_pm}"
		echo "$declared_pm"
		return 0
	fi

	[[ -f "pnpm-lock.yaml" ]]    && found_locks+=("pnpm-lock.yaml")
	[[ -f "package-lock.json" ]] && found_locks+=("package-lock.json")
	[[ -f "yarn.lock" ]]         && found_locks+=("yarn.lock")

	if [[ "${#found_locks[@]}" -gt 1 ]]; then
		log_item_warning "Multiple lock files found: ${found_locks[*]} — using pnpm > npm > yarn priority"
	fi

	[[ -f "pnpm-lock.yaml" ]]    && echo "pnpm" && return 0
	[[ -f "package-lock.json" ]] && echo "npm"  && return 0
	[[ -f "yarn.lock" ]]         && echo "yarn" && return 0

	log_debug "No lock file found, defaulting to npm"
	echo "npm"
}

# configure_pnpm: points the pnpm store outside the workspace and widens the network retry budget (5 retries, 120s cap)
# Notes: best effort with output discarded: a failure must not abort the module before
#   the install attempt runs its own failure handling, including the warning path when
#   REQUIRE_DEPENDENCY_INSTALL is false. The persistent-data module persists the store.
configure_pnpm() {
	pnpm config set store-dir /root/.local/share/pnpm/store >/dev/null 2>&1 || true
	pnpm config set fetch-retries 5 >/dev/null 2>&1 || true
	pnpm config set fetch-retry-maxtimeout 120000 >/dev/null 2>&1 || true
}

# install_dependencies: installs the current directory's dependencies with the detected package manager, skipping without package.json
# Returns: 0 also for a failed install, unless REQUIRE_DEPENDENCY_INSTALL is true.
# Notes: each attempt is bounded by _PKG_INSTALL_TIMEOUT seconds. pnpm gets --force so
#   a persisted, incompatible node_modules is recreated without an interactive prompt,
#   and its unfrozen fallback is skipped when the frozen-lockfile attempt timed out
#   (exit code 124).
install_dependencies() {
	local pm exit_code skip_fallback

	[[ -f "package.json" ]] || {
		log_debug "No package.json found, skipping dependency installation"
		return 0
	}

	pm="$(detect_package_manager)"
	start_spinner "Installing dependencies with ${pm}"

	case "$pm" in
		pnpm)
			skip_fallback=false
			configure_pnpm
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
		push_error "$DEVCONTAINER_FATAL_ERROR" "${LINENO}" "install_dependencies" "${pm} install" "Dependency installation failed"
		log_error "Dependency installation failed with ${pm}"
		return 1
	fi
	log_item_warning "Dependency installation failed with ${pm} — run '${pm} install' in the container to retry"
	return 0
}

# install_dependencies_without_tokens: runs install_dependencies with every clone token removed from the environment, then restores them
# Notes: a package-manager lifecycle script from the cloned repository is arbitrary
#   code and must never see a clone credential; the tokens come back because a later
#   repository still needs its own. Not a subshell: install_dependencies records
#   failures in the shared error stack, which a subshell would discard.
install_dependencies_without_tokens() {
	local rc=0 var_name
	local -a token_vars=()
	local -A saved_tokens=()

	[[ -n "${GIT_CLONE_TOKEN:-}" ]] && token_vars+=("GIT_CLONE_TOKEN")
	for var_name in "${!GIT_CLONE_TOKEN_@}"; do
		token_vars+=("$var_name")
	done
	for var_name in "${token_vars[@]}"; do
		saved_tokens["$var_name"]="${!var_name}"
		unset "$var_name"
	done

	install_dependencies || rc=$?

	for var_name in "${token_vars[@]}"; do
		export "$var_name=${saved_tokens[$var_name]}"
	done
	return "$rc"
}

# setup_repository <resolved_url>: in the current directory, fast-forwards an existing repository when AUTO_UPDATE is true, or clones resolved_url
# Notes: the clone is skipped with a warning when no token resolves for the URL's
#   host, since it cannot succeed without credentials. A failed git init, remote add
#   or fetch removes the .git this attempt created and fails the module; a checkout
#   conflict after a successful fetch stays a warning.
setup_repository() {
	local resolved_url="${1:-}"
	local current_branch fetch_output merge_output resolved_host resolved_token
	local clone_rc=0 clone_step="git init -b $DEFAULT_BRANCH" checkout_output
	log_detail "Checking repository status in $(pwd)"

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

	resolved_host=$(url_host "$resolved_url")
	resolved_token=$(resolve_token_for_host "$resolved_host")
	if [[ -z "$resolved_token" ]]; then
		log_item_warning "No GIT_CLONE_TOKEN resolvable for host '${resolved_host}' — skipping repository initialization"
		return 0
	fi

	start_spinner "Cloning repository from $resolved_url"
	spinner_stream log_debug git init -b "$DEFAULT_BRANCH" || clone_rc=$?
	if [[ $clone_rc -eq 0 ]]; then
		clone_step="git remote add origin $resolved_url"
		git remote add origin "$resolved_url" || clone_rc=$?
	fi
	if [[ $clone_rc -eq 0 ]]; then
		clone_step="git fetch origin"
		spinner_stream log_debug git fetch origin || clone_rc=$?
	fi
	spinner_cleanup

	if [[ $clone_rc -ne 0 ]]; then
		push_error "$DEVCONTAINER_NETWORK_ERROR" "${LINENO}" "setup_repository" "$clone_step" "Failed to clone repository from ${resolved_url}"
		log_error "Failed to clone repository from ${resolved_url}"
		rm -rf ./.git
		return 1
	fi

	# why: no --force, so existing local config files are never overwritten
	if checkout_output=$(git checkout "$DEFAULT_BRANCH" 2>&1); then
		log_debug "${checkout_output}"
		log_item_success "Repository initialized"
	else
		log_debug "${checkout_output}"
		log_item_warning "Repository initialized but checkout skipped (conflicts likely). Please check manually"
	fi
}

# validate_same_host <url...>: warns when the repository URLs span more than one host
# Notes: informational only; each host resolves its own token, so mixed hosts work.
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

# validate_token_access <repo_url>: confirms access with git ls-remote through the credential store, when VALIDATE_TOKEN is true and a token resolves for the URL's host
validate_token_access() {
	local url="${1:-}" host token
	host=$(url_host "$url")
	token=$(resolve_token_for_host "$host")
	[[ -n "$token" ]] || { log_debug "No resolvable GIT_CLONE_TOKEN for validation"; return 0; }
	[[ "${VALIDATE_TOKEN}" == "true" ]] || return 0
	log_debug "Validating token via git ls-remote $url"
	if git ls-remote "$url" HEAD >/dev/null 2>&1; then
		log_item_success "Token validated"
	else
		push_error "$DEVCONTAINER_AUTH_ERROR" "${LINENO}" "validate_token_access" "git ls-remote $url" "Token validation failed"
		log_error "Token validation failed"
		return 1
	fi
}

# ----- CORE SETUP -------------------------------------------------------------

# run_in_repo <dir> <command...>: runs the command in dir, then returns to the previous directory
# Returns: the command's status, or 1 when a directory change fails.
# Notes: not a subshell: setup_repository and install_dependencies record failures in
#   the shared error stack, which a subshell would discard. The command runs bare and
#   its status is read on the next line: under live errexit a failure stops the
#   process and the directory no longer matters; under a caller's if or ||, errexit
#   is off, so the status is captured and the cd back still runs.
run_in_repo() {
	local dir="$1" previous_dir rc=0
	shift

	previous_dir="$(pwd)"
	cd "$dir" || return 1
	"$@"
	rc=$?
	cd "$previous_dir" || return 1
	return "$rc"
}

# git_setup: module entry; writes credentials, then clones or updates each REPO_SOURCE_N repository and installs its dependencies, skipping when none is set
# Notes: one repository lives in _WORKSPACE_DIR/<PROJECT_NAME>; two or more each get
#   the folder named after their URL, a repeated folder name being skipped. A
#   dependency-install failure fails the module only when REQUIRE_DEPENDENCY_INSTALL
#   is true, and in multi-repo only after every repository has been attempted.
git_setup() {
	local -a _trimmed_entries=()
	local entry folder_name
	local -A _seen_folders=()
	local deps_failed=false
	register_cleanup remove_credentials_store
	# why: a rejected token must fail the clone, not prompt on a lifecycle hook's terminal
	export GIT_TERMINAL_PROMPT=0

	collect_numbered_repo_entries _trimmed_entries REPO_SOURCE
	if [[ "${#_trimmed_entries[@]}" -eq 0 ]]; then
		log_debug "No REPO_SOURCE set — skipping git setup"
		module_skip
		return 0
	fi

	configure_git_credentials "${_trimmed_entries[@]}"

	if [[ "${#_trimmed_entries[@]}" -eq 1 ]]; then
		validate_token_access "${_trimmed_entries[0]}"
		mkdir -p "${_WORKSPACE_DIR}/${PROJECT_NAME}"
		run_in_repo "${_WORKSPACE_DIR}/${PROJECT_NAME}" setup_repository "${_trimmed_entries[0]}"
		run_in_repo "${_WORKSPACE_DIR}/${PROJECT_NAME}" install_dependencies_without_tokens
	else
		validate_same_host "${_trimmed_entries[@]}"
		for entry in "${_trimmed_entries[@]}"; do
			folder_name="$(repo_entry_folder_name "$entry")"
			if [[ -v "_seen_folders[$folder_name]" ]]; then
				log_item_warning "Skipping '${entry}': folder '${folder_name}' already processed"
				continue
			fi
			_seen_folders["$folder_name"]=1
			validate_token_access "$entry"
			mkdir -p "${_WORKSPACE_DIR}/${folder_name}"
			run_in_repo "${_WORKSPACE_DIR}/${folder_name}" setup_repository "$entry"
			run_in_repo "${_WORKSPACE_DIR}/${folder_name}" install_dependencies_without_tokens || deps_failed=true
		done
		if [[ "$deps_failed" == true ]]; then
			return 1
		fi
	fi
}

export -f run_in_repo unset_clone_tokens remove_credentials_store url_host url_scheme token_env_var_name resolve_token_for_host configure_git_credentials detect_package_manager configure_pnpm install_dependencies install_dependencies_without_tokens setup_repository validate_same_host validate_token_access git_setup
