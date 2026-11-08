# shellcheck shell=bash

# CORE_NAME="git"
# CORE_DESCRIPTION="Configures git credentials, validates token, clones or updates repositories"
# CORE_ENTRY="git_setup"
# CORE_AFTER="persistent-data"
# CORE_SECRETS="GIT_CLONE_TOKEN GIT_CLONE_TOKEN_*"
# CORE_PERSIST="github pnpm-store"

# ----- OVERVIEW ---------------------------------------------------------------
#
# Clones or updates the project's Git repositories in the workspace and installs
# their dependencies. One clone token is resolved per host (GIT_CLONE_TOKEN_<HOST>,
# then GIT_CLONE_TOKEN), so repositories from different HTTP(S) hosts can be mixed.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../lib" && pwd)/loader.sh"

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# Documented in README.md#configuration-variables:
# - CLEAN_CREDENTIALS
# - GIT_CLONE_TOKEN
# - GIT_CLONE_TOKEN_<HOST>
# - GIT_EMAIL
# - GIT_TOKEN_DURING_INSTALL
# - GIT_USER
# - PROJECT_NAME
# - REPO_SOURCE
# - REPO_SOURCE_N
# - REQUIRE_DEPENDENCY_INSTALL

# ----- INTERNAL CONSTANTS -----------------------------------------------------

readonly _GIT_CREDENTIALS_FILE="$HOME/.git-credentials"

_PKG_INSTALL_TIMEOUT="${_PKG_INSTALL_TIMEOUT:-300}"
_WORKSPACE_DIR="${_WORKSPACE_DIR:-/workspace}"
# why: a dropped connection otherwise hangs on kernel retransmits for half a minute, so each of 3 attempts is bounded
_GIT_NETWORK_ATTEMPTS=3
_GIT_NETWORK_TIMEOUT="${_GIT_NETWORK_TIMEOUT:-15}"
# why: a server preparing a big pack sends only keepalives, so a fetch is given up only when the connection is dead: under 1 byte/s for 60s over HTTP
_GIT_FETCH_STALL_TIME=60
# why: over SSH, a peer that answers no keepalive for 15s is dead
readonly _GIT_SSH_KEEPALIVE='ssh -o ServerAliveInterval=5 -o ServerAliveCountMax=3'
_GIT_NETWORK_BACKOFF="${_GIT_NETWORK_BACKOFF:-1}"

# ----- HELPER FUNCTIONS -------------------------------------------------------

# is_scoped_store_helper <key>: succeeds when a URL-scoped credential.<url>.helper key holds exactly the section scope_credentials_to_store writes: an empty helper, then store
# Notes: tells setup's own sections from helpers the user configured, such as
#   gh auth setup-git, which setup must never remove.
is_scoped_store_helper() {
	[[ "$(git config --global --get-all "$1" 2>/dev/null)" == $'\nstore' ]]
}

# remove_credentials_store: removes the git credentials file and every URL-scoped store helper setup wrote, on exit when CLEAN_CREDENTIALS is true
# Notes: with those sections gone, every host falls back to the editor's forwarded
#   credentials; any other helper section is left alone.
remove_credentials_store() {
	local key
	[[ "$CLEAN_CREDENTIALS" == "true" ]] || return 0
	rm -f "$_GIT_CREDENTIALS_FILE"
	while IFS= read -r key; do
		if [[ -n "$key" ]] && is_scoped_store_helper "$key"; then
			git config --global --unset-all "$key" 2>/dev/null || true
		fi
	done < <(git config --global --name-only --get-regexp '^credential\..+\.helper$' 2>/dev/null || true)
	return 0
}

# url_host <url>: prints the host[:port] of a scheme:// URL, or an empty line for any other address
# Stdout: the host[:port], or an empty line
url_host() {
	local url="${1:-}" host
	[[ "$url" == *://* ]] || { echo ""; return 0; }
	host="${url#*://}"
	host="${host%%/*}"
	echo "$host"
}

# url_scheme <url>: prints the scheme of a scheme:// URL
# Stdout: the scheme, one line
url_scheme() {
	local url="${1:-}"
	echo "${url%%://*}"
}

# token_env_var_name <host>: prints the per-host token variable name (gitlab.example.com → GIT_CLONE_TOKEN_GITLAB_EXAMPLE_COM)
# Stdout: the variable name, one line
token_env_var_name() {
	local host="${1:-}" normalized
	normalized=$(printf '%s' "${host^^}" | tr -c 'A-Z0-9' '_')
	echo "GIT_CLONE_TOKEN_${normalized}"
}

# resolve_token_for_host <host>: prints GIT_CLONE_TOKEN_<HOST>, else GIT_CLONE_TOKEN, else an empty line
# Stdout: the token, or an empty line
resolve_token_for_host() {
	local host="${1:-}" var_name
	var_name=$(token_env_var_name "$host")
	if [[ -n "${!var_name:-}" ]]; then
		echo "${!var_name}"
	else
		echo "${GIT_CLONE_TOKEN:-}"
	fi
}

# stage_git_credentials <repo_url...>: writes one credential store entry per host with a token among the URLs, keeping each URL's scheme, then replaces the store with them
# Stdout: "<scheme>://<host>" per host written, one per line
# Returns: 1 when the store could not be written; the live store is then left as it was.
# Notes: an address with no scheme:// host (a path, an scp-style address) gets no
#   entry. A subshell, so its EXIT trap removes a staged file left by a failure.
stage_git_credentials() {
	local -A seen_hosts=()
	local url host scheme token staged_file=""
	(
		trap '[[ -z "$staged_file" ]] || rm -f -- "$staged_file"' EXIT

		for url in "$@"; do
			host=$(url_host "$url")
			[[ -n "$host" ]] || continue
			[[ -v "seen_hosts[$host]" ]] && continue
			seen_hosts["$host"]=1

			token=$(resolve_token_for_host "$host")
			if [[ -z "$token" ]]; then
				log_item_info "No token for ${host}: credentials not written"
				continue
			fi
			if [[ -z "$staged_file" ]]; then
				staged_file=$(mktemp "${_GIT_CREDENTIALS_FILE}.XXXXXX") || exit 1
			fi
			scheme=$(url_scheme "$url")
			printf 'protocol=%s\nhost=%s\nusername=%s\npassword=%s\n\n' "$scheme" "$host" "$GIT_USER" "$token" |
				git credential-store --file "$staged_file" store || exit 1
			printf '%s://%s\n' "$scheme" "$host"
		done

		[[ -n "$staged_file" ]] || exit 0
		chmod 600 -- "$staged_file" || exit 1
		mv -f -- "$staged_file" "$_GIT_CREDENTIALS_FILE" || exit 1
	)
}

# scope_credentials_to_store <url>: makes the credential store the only helper git asks for the host
# Notes: the empty helper resets the list built so far, so a generic credential.helper
#   VS Code writes on attach (its forwarding helper) never answers for this host, and
#   git keeps using the clone token after the editor disconnects.
scope_credentials_to_store() {
	local key="credential.$1.helper"
	git config --global --unset-all "$key" || true
	git config --global --add "$key" ''
	git config --global --add "$key" store
}

# unscope_credentials <url>: removes the host's URL-scoped store helper when setup wrote it, leaving any helper the user configured
unscope_credentials() {
	local key="credential.$1.helper"
	is_scoped_store_helper "$key" || return 0
	git config --global --unset-all "$key" || true
}

# configure_git_credentials <repo_url...>: sets git's identity, writes one credential store entry per host with a token, and scopes the store to each such host
# Notes: one line per host; a host without a token keeps the editor's forwarded
#   credentials, which is enough for public repositories, so a section an earlier run
#   scoped to a host that now has no token, or is no longer listed, is removed. A helper
#   the user configured is never touched.
configure_git_credentials() {
	local written url key

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

	written=$(stage_git_credentials "$@") || return 1
	while IFS= read -r url; do
		[[ -n "$url" ]] || continue
		scope_credentials_to_store "$url"
		log_item_success "Credentials written for ${url#*://}"
	done <<<"$written"
	while IFS= read -r key; do
		url="${key#credential.}"
		url="${url%.helper}"
		[[ -z "$key" ]] || grep -qxF -- "$url" <<<"$written" || unscope_credentials "$url"
	done < <(git config --global --name-only --get-regexp '^credential\..+\.helper$' 2>/dev/null || true)
}

# detect_package_manager: prints the package manager from package.json's packageManager, else from the lock file (pnpm > npm > yarn, warning when several exist), else npm
# Stdout: pnpm, npm or yarn, one line
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
		log_item_warning "${PWD##*/}: several lock files (${found_locks[*]}), pnpm > npm > yarn picked; remove the ones the project does not use"
	fi

	[[ -f "pnpm-lock.yaml" ]]    && echo "pnpm" && return 0
	[[ -f "package-lock.json" ]] && echo "npm"  && return 0
	[[ -f "yarn.lock" ]]         && echo "yarn" && return 0

	log_debug "No lock file found, defaulting to npm"
	echo "npm"
}

# configure_pnpm: points the install user's pnpm store outside the workspace and widens the network retry budget (5 retries, 120s cap)
# Notes: best effort with output discarded: a failure must not abort the module before
#   the install attempt runs its own failure handling, including the warning path when
#   REQUIRE_DEPENDENCY_INSTALL is false. The persistent-data module persists the store;
#   its path is resolved past the /root link, which the install user cannot traverse.
configure_pnpm() {
	local store
	store="$(readlink -m -- "${PNPM_HOME:-/root/.local/share/pnpm}")/store"
	as_install_user pnpm config set store-dir "$store" >/dev/null 2>&1 || true
	as_install_user pnpm config set fetch-retries 5 >/dev/null 2>&1 || true
	as_install_user pnpm config set fetch-retry-maxtimeout 120000 >/dev/null 2>&1 || true
}

# install_dependencies: installs the current directory's dependencies with the detected package manager, logging one outcome line prefixed with the repository folder
# Returns: 0 also for a failed install, unless REQUIRE_DEPENDENCY_INSTALL is true.
# Notes: each attempt is bounded by _PKG_INSTALL_TIMEOUT seconds. pnpm gets --force so
#   a persisted, incompatible node_modules is recreated without an interactive prompt,
#   and its unfrozen fallback is skipped when the frozen-lockfile attempt timed out
#   (exit code 124). The package manager's own output stays at DEBUG.
install_dependencies() {
	local pm exit_code=1 skip_fallback=false repo="${PWD##*/}"

	pm="$(detect_package_manager)"
	start_spinner "Installing ${repo} dependencies with ${pm}"

	case "$pm" in
		pnpm)
			configure_pnpm
			if [[ -f "pnpm-lock.yaml" ]]; then
				exit_code=0
				spinner_stream log_debug as_install_user timeout "$_PKG_INSTALL_TIMEOUT" pnpm install --frozen-lockfile --force || exit_code=$?
				[[ $exit_code -ne 124 ]] || skip_fallback=true
			fi
			if [[ $exit_code -ne 0 && "$skip_fallback" == false ]]; then
				exit_code=0
				spinner_stream log_debug as_install_user timeout "$_PKG_INSTALL_TIMEOUT" pnpm install --force || exit_code=$?
			fi
			;;
		yarn)
			exit_code=0
			spinner_stream log_debug as_install_user timeout "$_PKG_INSTALL_TIMEOUT" yarn install --frozen-lockfile --non-interactive || exit_code=$?
			;;
		npm)
			exit_code=0
			spinner_stream log_debug as_install_user timeout "$_PKG_INSTALL_TIMEOUT" npm install || exit_code=$?
			;;
	esac

	if [[ $exit_code -eq 0 ]]; then
		stop_spinner 0 "${repo}: dependencies installed with ${pm}"
		return 0
	fi
	spinner_cleanup
	if [[ "${REQUIRE_DEPENDENCY_INSTALL}" == "true" ]]; then
		push_error "$DEVCONTAINER_FATAL_ERROR" "${LINENO}" "install_dependencies" "${pm} install" "Dependency installation failed"
		log_error "${repo}: dependencies failed with ${pm}"
		return 1
	fi
	log_item_warning "${repo}: dependencies failed with ${pm}: run '${pm} install'"
	return 0
}

# install_dependencies_without_tokens: runs install_dependencies with every package-manager call as the install user, out of reach of the clone token unless GIT_TOKEN_DURING_INSTALL hands it a copy, skipping without package.json
# Returns: install_dependencies' status; a boundary that cannot be established counts
#   as a failed install, fatal only when REQUIRE_DEPENDENCY_INSTALL is true.
# Notes: a lifecycle script from the cloned repository is arbitrary code, and setup runs
#   as root: install_user_session (lib/install-user.sh) proves, as the install user, that
#   no setup secret is reachable before anything runs. GIT_TOKEN_DURING_INSTALL=true
#   hands that user a throwaway copy of the credential store, for dependencies that are
#   private git repositories cloned with the same token. Every path logs exactly one
#   outcome line for the repository.
install_dependencies_without_tokens() {
	local rc=0 repo="${PWD##*/}"
	local -a session_opts=()

	if [[ ! -f "package.json" ]]; then
		log_item_info "${repo}: dependencies skipped (no package.json)"
		return 0
	fi
	[[ "${GIT_TOKEN_DURING_INSTALL}" != "true" ]] || session_opts=(--expose-clone-token "$_GIT_CREDENTIALS_FILE")
	install_user_session "${session_opts[@]}" "$PWD" install_dependencies || rc=$?
	[[ "$rc" -eq 2 ]] || return "$rc"
	if [[ "${REQUIRE_DEPENDENCY_INSTALL}" == "true" ]]; then
		push_error "$DEVCONTAINER_FATAL_ERROR" "${LINENO}" "install_dependencies_without_tokens" "install_user_session" "Dependency installation not isolated"
		log_error "${repo}: dependencies not installed: the install could not be isolated (see errors above)"
		return 1
	fi
	log_item_warning "${repo}: dependencies not installed: the install could not be isolated (see errors above)"
	return 0
}

# git_network <label> <git_args...>: runs a git network call with its output at DEBUG, retried with a line per retried attempt, each attempt given up once its connection is dead
# Returns: retry_command's status.
# Notes: ls-remote transfers almost nothing, so it is bounded by _GIT_NETWORK_TIMEOUT
#   seconds of wall clock. A fetch is never bounded by its total time, so a large first
#   clone always finishes: over HTTP it is given up after _GIT_FETCH_STALL_TIME seconds
#   under 1 byte/s, and over SSH after 15s without a keepalive answer, unless the user
#   set GIT_SSH_COMMAND, GIT_SSH or core.sshCommand, which are kept as they are.
git_network() {
	local label="$1"
	local -a bound=(--label "$label") limits=()
	shift
	if [[ "$1" == ls-remote ]]; then
		bound+=(--timeout "$_GIT_NETWORK_TIMEOUT")
	else
		limits=(GIT_HTTP_LOW_SPEED_LIMIT=1 "GIT_HTTP_LOW_SPEED_TIME=${_GIT_FETCH_STALL_TIME}")
		if [[ -z "${GIT_SSH_COMMAND:-}" && -z "${GIT_SSH:-}" && -z "$(git config core.sshCommand 2>/dev/null || true)" ]]; then
			limits+=("GIT_SSH_COMMAND=${_GIT_SSH_KEEPALIVE}")
		fi
	fi
	retry_command "${bound[@]}" "$_GIT_NETWORK_ATTEMPTS" "$_GIT_NETWORK_BACKOFF" \
		spinner_stream log_debug env "${limits[@]}" git "$@"
}

# update_repository <repo>: fast-forwards the current repository's branch from origin, logging one outcome line
# Notes: never fails the module: a repository that cannot be updated is kept as it is,
#   with a warning naming what to do.
update_repository() {
	local repo="$1" current_branch merge_output

	current_branch=$(git symbolic-ref --short HEAD 2>/dev/null) || true
	if [[ -z "${current_branch}" ]]; then
		log_item_warning "${repo}: not updated: detached HEAD; check out a branch to get updates"
		return 0
	fi
	start_spinner "Updating ${repo} from origin/${current_branch}"
	if ! git_network "${repo}: update" fetch origin "${current_branch}"; then
		spinner_cleanup
		log_item_warning "${repo}: not updated: fetching origin/${current_branch} ${RETRY_LAST_CAUSE}; run 'git pull' to retry"
		return 0
	fi
	# why: the up-to-date check below reads git's English message, which a translated locale would change
	if ! merge_output=$(LC_ALL=C git merge --ff-only "origin/${current_branch}" 2>&1); then
		spinner_cleanup
		log_debug "${merge_output}"
		log_item_warning "${repo}: not updated: ${current_branch} has diverged from origin/${current_branch}; merge or rebase it by hand"
		return 0
	fi
	spinner_cleanup
	log_debug "${merge_output}"
	if [[ "${merge_output}" == *"Already up to date"* ]]; then
		log_item_success "${repo}: already up to date$(retry_suffix)"
	else
		log_item_success "${repo}: updated from origin/${current_branch}$(retry_suffix)"
	fi
}

# setup_repository <resolved_url>: in the current directory, fast-forwards an existing repository, or clones resolved_url onto the remote's default branch, logging one outcome line prefixed with the folder name
# Notes: the clone is skipped with a warning when no token resolves for the URL's
#   host, since it cannot succeed without credentials. A failed git init, remote add or
#   fetch removes the .git this attempt created and fails the module; a checkout
#   conflict after a successful fetch stays a warning. An empty repository stays on an
#   unborn main, and a remote that declares no HEAD is checked out on main with a warning.
setup_repository() {
	local resolved_url="${1:-}" repo="${PWD##*/}"
	local resolved_host resolved_token branch retried
	local clone_rc=0 clone_step checkout_output
	log_debug "Checking repository status in $(pwd)"

	if [[ -d ".git" ]]; then
		update_repository "$repo"
		return 0
	fi

	resolved_host=$(url_host "$resolved_url")
	resolved_token=$(resolve_token_for_host "$resolved_host")
	if [[ -z "$resolved_token" ]]; then
		log_item_warning "${repo}: not cloned: no token for ${resolved_host}; set GIT_CLONE_TOKEN or $(token_env_var_name "$resolved_host")"
		return 0
	fi

	start_spinner "Cloning ${repo} from ${resolved_url}"
	clone_step="git init -b main"
	spinner_stream log_debug git init -b main || clone_rc=$?
	if [[ $clone_rc -eq 0 ]]; then
		clone_step="git remote add origin $resolved_url"
		git remote add origin "$resolved_url" || clone_rc=$?
	fi
	if [[ $clone_rc -eq 0 ]]; then
		clone_step="git fetch origin"
		git_network "${repo}: clone" fetch origin || clone_rc=$?
		retried=$(retry_suffix)
	fi
	# why: set-head --auto needs the fetched ref it points to, and fails for good on a remote that advertises no HEAD, so it is asked once and a failure falls back to main
	if [[ $clone_rc -eq 0 && -n "$(git for-each-ref --count=1 refs/remotes/origin)" ]]; then
		spinner_stream log_debug timeout "$_GIT_NETWORK_TIMEOUT" git remote set-head origin --auto || true
	fi
	spinner_cleanup

	if [[ $clone_rc -ne 0 ]]; then
		push_error "$DEVCONTAINER_NETWORK_ERROR" "${LINENO}" "setup_repository" "$clone_step" "Failed to clone repository from ${resolved_url}"
		log_error "${repo}: clone from ${resolved_url} failed at ${clone_step}"
		rm -rf ./.git
		return 1
	fi

	if [[ -z "$(git for-each-ref --count=1 refs/remotes/origin)" ]]; then
		log_item_success "${repo}: cloned (empty repository, branch main)${retried}"
		return 0
	fi
	branch=$(git symbolic-ref --short -q refs/remotes/origin/HEAD) || true
	branch="${branch#origin/}"
	if [[ -z "$branch" ]] && ! git rev-parse -q --verify refs/remotes/origin/main >/dev/null; then
		log_item_warning "${repo}: cloned, but no branch checked out: the remote declares no default branch (HEAD) and has no main; run 'git checkout <branch>'"
		return 0
	fi
	# why: the workspace may already hold local config files the clone also tracks; a plain checkout refuses to overwrite them, and the warning sends the user to resolve it
	if checkout_output=$(git checkout "${branch:-main}" 2>&1); then
		log_debug "${checkout_output}"
		if [[ -z "$branch" ]]; then
			log_item_warning "${repo}: cloned onto main: the remote declares no default branch (HEAD)"
		else
			log_item_success "${repo}: cloned (branch ${branch})${retried}"
		fi
	else
		branch="${branch:-main}"
		log_debug "${checkout_output}"
		log_item_warning "${repo}: cloned, but ${branch} not checked out: files in the folder conflict with it; move them aside and run 'git checkout ${branch}'"
	fi
}

# validate_token_access <repo_url>: confirms access with git ls-remote through the credential store, when a token resolves for the URL's scheme:// host
# Notes: a path or scp-style address gets no credential, so there is no token to validate.
validate_token_access() {
	local url="${1:-}" host token
	host=$(url_host "$url")
	[[ -n "$host" ]] || return 0
	token=$(resolve_token_for_host "$host")
	[[ -n "$token" ]] || { log_debug "No token for ${host}: not validated"; return 0; }
	start_spinner "Validating the token for ${host}"
	if git_network 'Token validation' ls-remote "$url" HEAD; then
		stop_spinner 0 "Token validated$(retry_suffix)"
	else
		push_error "$DEVCONTAINER_AUTH_ERROR" "${LINENO}" "validate_token_access" "git ls-remote $url" "Token validation failed"
		stop_spinner 1 "Token validation failed for ${host}: ${RETRY_LAST_CAUSE}"
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

# git_setup: core entry; writes credentials, then clones or updates each REPO_SOURCE_N repository and installs its dependencies, skipping when none is set
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
		module_skip 'no REPO_SOURCE'
		return 0
	fi

	configure_git_credentials "${_trimmed_entries[@]}"

	if [[ "${#_trimmed_entries[@]}" -eq 1 ]]; then
		validate_token_access "${_trimmed_entries[0]}"
		mkdir -p "${_WORKSPACE_DIR}/${PROJECT_NAME}"
		run_in_repo "${_WORKSPACE_DIR}/${PROJECT_NAME}" setup_repository "${_trimmed_entries[0]}"
		run_in_repo "${_WORKSPACE_DIR}/${PROJECT_NAME}" install_dependencies_without_tokens
	else
		for entry in "${_trimmed_entries[@]}"; do
			folder_name="$(repo_entry_folder_name "$entry")"
			if [[ -v "_seen_folders[$folder_name]" ]]; then
				log_item_warning "${folder_name}: ${entry} skipped: another repository already uses this folder; give each REPO_SOURCE_N a distinct repository name"
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

export -f run_in_repo is_scoped_store_helper unscope_credentials remove_credentials_store url_host url_scheme token_env_var_name resolve_token_for_host stage_git_credentials scope_credentials_to_store configure_git_credentials detect_package_manager configure_pnpm install_dependencies install_dependencies_without_tokens git_network update_repository setup_repository validate_token_access git_setup
