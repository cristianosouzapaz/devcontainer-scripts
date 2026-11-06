# shellcheck shell=bash
[[ -n "${_INSTALL_USER_SH_LOADED:-}" ]] && return 0
readonly _INSTALL_USER_SH_LOADED=1

# Runs untrusted third-party code (package-manager lifecycle scripts) as dep-install,
# an unprivileged account that cannot reach a secret of the root setup: setup runs as
# root, so code it starts directly could read any file root can, the setup processes'
# memory and the Docker socket. A session first proves that boundary at run time, as
# dep-install, and fails closed naming whatever it can still reach.

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# Documented in README.md#configuration-variables:
# - INSTALL_ENV_<NAME>

# ----- INTERNAL CONSTANTS -----------------------------------------------------

readonly _INSTALL_USER_NAME="dep-install"
readonly _INSTALL_USER_HOME="/home/${_INSTALL_USER_NAME}"
readonly _INSTALL_USER_FIRST_ID=1990
readonly _INSTALL_USER_LOCK="/run/lock/devcontainer-install-user.lock"
# why: an allowlist, so only what an install needs of the setup environment (toolchain, locale, registry auth, proxies, CA) reaches it; INSTALL_ENV_<NAME> adds NAME
readonly -a _INSTALL_USER_ENV_DEFAULTS=(
	PATH LANG LC_ALL LC_CTYPE TERM COREPACK_ENABLE_DOWNLOAD_PROMPT GIT_TERMINAL_PROMPT
	NPM_TOKEN NODE_AUTH_TOKEN NODE_EXTRA_CA_CERTS
	HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy
)

# why: empty until ensure_install_user and install_user_session fill them, so as_install_user refuses to run outside a session
_INSTALL_USER_UID=""
_INSTALL_USER_GID=""
_INSTALL_USER_SESSION_DIR=""
declare -ga _INSTALL_USER_SESSION_ENV=()

# ----- FUNCTIONS --------------------------------------------------------------

# install_user_secret_paths <pid...>: prints "<kind> <path>" for every secret the install must not reach, one per line, the setup processes being the pids
# Stdout: one "<kind> <path>" line per secret path
# Notes: the one list of what the self-check probes, each path resolved from the
#   variable its tool reads. kind is token (a clone-token file, waived by
#   --expose-clone-token), credential (an agent login, stronger than a clone token),
#   socket (the Docker daemon) or proc (a setup process). A new tool with a login is
#   one credential line here.
install_user_secret_paths() {
	local pid
	printf 'token %s\n' "${_ENV_FILE_PATH:-/root/.config/devcontainer/.env}"
	# why: the mount target before 4.3.0; a project still generating it exposes the .env file
	printf 'token %s\n' /tmp/.env
	[[ -z "${_MODULE_SECRET_FILE:-}" ]] || printf 'token %s\n' "$_MODULE_SECRET_FILE"
	printf 'token %s\n' "$HOME/.git-credentials"
	printf 'credential %s\n' "${GH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gh}/hosts.yml"
	printf 'credential %s\n' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json"
	printf 'credential %s\n' "${CODEX_HOME:-$HOME/.codex}/auth.json"
	printf 'credential %s\n' "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/auth.json"
	printf 'socket %s\n' /var/run/docker.sock /var/run/docker-host.sock
	[[ "${DOCKER_HOST:-}" != unix://* ]] || printf 'socket %s\n' "${DOCKER_HOST#unix://}"
	for pid in "$@"; do
		printf 'proc /proc/%s/%s\n' "$pid" environ "$pid" mem
	done
}

# ensure_install_user: creates or realigns dep-install (no supplementary groups, nologin) and hands it the pnpm store, setting _INSTALL_USER_UID
# Returns: 1, with the reason logged, when the account cannot be set up.
# Notes: serialized on a lock, since parallel setups share /etc/passwd. An existing
#   account keeps its uid; a new one gets the first id from _INSTALL_USER_FIRST_ID free
#   as both uid and gid, never another account's, which would hand that account's
#   files to the install. The pnpm store under PNPM_HOME is persisted across rebuilds,
#   where the uid may differ, so it is handed to whatever uid the account has.
ensure_install_user() {
	local name="$_INSTALL_USER_NAME" uid store
	if [[ "$EUID" -ne 0 ]]; then
		log_error "The install user ${name} needs root to be set up; setup runs as uid ${EUID}"
		return 1
	fi
	mkdir -p "${_INSTALL_USER_LOCK%/*}" || return 1
	(
		flock -w 60 9 || { log_error "Timed out waiting for the install-user lock ${_INSTALL_USER_LOCK}"; exit 1; }
		if ! getent passwd "$name" >/dev/null; then
			uid="$_INSTALL_USER_FIRST_ID"
			while getent passwd "$uid" >/dev/null || getent group "$uid" >/dev/null; do
				uid=$((uid + 1))
			done
			getent group "$name" >/dev/null || groupadd -g "$uid" "$name" || exit 1
			useradd -u "$uid" -g "$name" -d "$_INSTALL_USER_HOME" -M -s /usr/sbin/nologin "$name" || exit 1
		fi
		usermod -G '' -s /usr/sbin/nologin "$name" || exit 1
		uid=$(id -u "$name") || exit 1
		install -d -m 700 -o "$uid" -g "$(id -g "$name")" "$_INSTALL_USER_HOME" || exit 1
		if [[ -n "${PNPM_HOME:-}" && -d "$PNPM_HOME" ]]; then
			store="$(readlink -f -- "$PNPM_HOME")/store"
			if [[ ! -d "$store" ]]; then
				install -d -m 755 -o "$uid" -g "$(id -g "$name")" "$store" || exit 1
			elif [[ "$(stat -c %u -- "$store")" != "$uid" ]]; then
				chown -R -h "$name:" -- "$store" || exit 1
			fi
		fi
	) 9>"$_INSTALL_USER_LOCK" || {
		log_error "Could not set up the install user ${name}"
		return 1
	}
	_INSTALL_USER_UID=$(id -u "$name")
	_INSTALL_USER_GID=$(id -g "$name")
}

# install_user_self_check <expose_token>: probes, as dep-install, every path of install_user_secret_paths and fails when one is reachable
# Returns: 1 when a secret is reachable, naming each one; a token path is only a
#   warning when expose_token is true.
install_user_self_check() {
	local expose_token="$1" kind path rc=0 caller="$BASHPID"
	# shellcheck disable=SC2016 # why: the probe script expands its own variables, as the install user
	while read -r kind path; do
		[[ -n "$kind" ]] || continue
		if [[ "$kind" == token && "$expose_token" == true ]]; then
			log_item_warning "GIT_TOKEN_DURING_INSTALL=true: the install can read ${path}"
			continue
		fi
		case "$path" in
			/tmp/.env) log_error "${path} is readable by ${_INSTALL_USER_NAME}: mount the .env file at /root/.config/devcontainer/.env instead (regenerate devcontainer.json with project-init)" ;;
			*) log_error "${path} (${kind}) is reachable by ${_INSTALL_USER_NAME}: the dependency install would see it" ;;
		esac
		rc=1
	done < <(install_user_secret_paths "$$" "$caller" | install_user_exec_raw /bin/bash -c '
		while read -r kind path; do
			case "$kind" in
				socket) [[ -S "$path" && -w "$path" ]] ;;
				proc) (exec 3<"$path") 2>/dev/null ;;
				*) [[ -e "$path" ]] && head -c 1 -- "$path" >/dev/null 2>&1 ;;
			esac && printf "%s %s\n" "$kind" "$path"
		done
		exit 0')
	return "$rc"
}

# install_user_handover <dir> <uid> <gid>: gives everything in dir but .git to uid:gid, and lets gid create entries in dir itself
# Notes: dir and .git stay root-owned, so git never meets a repository it does not
#   own; the sticky bit keeps the install from renaming .git or any entry it does not
#   own. Symlinks are changed, never followed. 0 0 gives dir back to root.
install_user_handover() {
	local dir="$1" uid="$2" gid="$3" entry rc=0
	for entry in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
		[[ -e "$entry" || -L "$entry" ]] || continue
		[[ "${entry##*/}" != .git ]] || continue
		chown -R -h "$uid:$gid" -- "$entry" || rc=1
	done
	if [[ "$uid" -eq 0 ]]; then
		chgrp 0 -- "$dir" && chmod g-w,-t -- "$dir" || rc=1
	else
		chgrp "$gid" -- "$dir" && chmod g+w,+t -- "$dir" || rc=1
	fi
	return "$rc"
}

# install_user_exec_raw <command...>: runs the command as dep-install with the session environment, no groups, no capabilities and no inherited descriptors above stderr
install_user_exec_raw() {
	local fd
	(
		for fd in /proc/"$BASHPID"/fd/*; do
			fd="${fd##*/}"
			[[ "$fd" -le 2 ]] || eval "exec ${fd}>&-" 2>/dev/null || true
		done
		exec setpriv --reuid="$_INSTALL_USER_UID" --regid="$_INSTALL_USER_GID" --clear-groups \
			--no-new-privs --inh-caps=-all --bounding-set=-all \
			env -i "${_INSTALL_USER_SESSION_ENV[@]}" "$@"
	)
}

# as_install_user <command...>: runs an external command as dep-install inside an install_user_session
# Returns: the command's status, or 1 outside a session.
as_install_user() {
	if [[ -z "$_INSTALL_USER_SESSION_DIR" ]]; then
		log_error "as_install_user called outside an install_user_session: $*"
		return 1
	fi
	install_user_exec_raw "$@"
}

# install_user_session [--expose-clone-token <store_file>] <dir> <command...>: runs the command in this shell with dir handed to dep-install, for its as_install_user calls
# Returns: the command's status; 2, with nothing run, when the boundary cannot be
#   established (account, self-check, handover); 1 when dir cannot be given back to root.
# Notes: not a subshell, so the command can record failures in the shared error stack.
#   The environment is the allowlist (_INSTALL_USER_ENV_DEFAULTS, plus NAME for every
#   INSTALL_ENV_<NAME>) with dep-install's own HOME, USER and a session TMPDIR;
#   PNPM_HOME is resolved past /root. A user-level ~/.npmrc is handed over as a copy.
#   --expose-clone-token hands over a throwaway copy of the git credential store with a
#   GIT_CONFIG_GLOBAL that uses it, and waives the self-check's token paths. dir always
#   goes back to root, which also repairs a session a killed setup left behind.
install_user_session() {
	local expose_token=false store_file="" dir name rc=0 session uid gid
	if [[ "${1:-}" == --expose-clone-token ]]; then
		expose_token=true store_file="$2"
		shift 2
	fi
	dir="$1"
	shift

	ensure_install_user || return 2
	uid="$_INSTALL_USER_UID" gid="$_INSTALL_USER_GID"
	session=$(mktemp -d "${_INSTALL_USER_HOME}/.session.XXXXXX") || return 2
	_INSTALL_USER_SESSION_ENV=(HOME="$_INSTALL_USER_HOME" USER="$_INSTALL_USER_NAME" LOGNAME="$_INSTALL_USER_NAME" TMPDIR="$session/tmp")
	for name in "${_INSTALL_USER_ENV_DEFAULTS[@]}"; do
		[[ -z "${!name+set}" ]] || _INSTALL_USER_SESSION_ENV+=("$name=${!name}")
	done
	for name in "${!INSTALL_ENV_@}"; do
		[[ -z "${name#INSTALL_ENV_}" ]] || _INSTALL_USER_SESSION_ENV+=("${name#INSTALL_ENV_}=${!name}")
	done
	[[ -z "${PNPM_HOME:-}" || ! -d "$PNPM_HOME" ]] || _INSTALL_USER_SESSION_ENV+=(PNPM_HOME="$(readlink -f -- "$PNPM_HOME")")
	mkdir -m 700 "$session/tmp" || rc=2
	if [[ "$rc" -eq 0 && -f "$HOME/.npmrc" ]]; then
		cp -- "$HOME/.npmrc" "$session/npmrc" && _INSTALL_USER_SESSION_ENV+=(NPM_CONFIG_USERCONFIG="$session/npmrc") || rc=2
	fi
	if [[ "$rc" -eq 0 && "$expose_token" == true ]]; then
		( umask 077 && cp -- "$store_file" "$session/git-credentials" 2>/dev/null || : >"$session/git-credentials" ) || rc=2
		printf '[credential]\n\thelper = store --file=%s\n' "$session/git-credentials" >"$session/gitconfig" || rc=2
		_INSTALL_USER_SESSION_ENV+=(GIT_CONFIG_GLOBAL="$session/gitconfig")
	fi
	[[ "$rc" -ne 0 ]] || chown -R "$uid:$gid" -- "$session" || rc=2

	if [[ "$rc" -eq 0 ]]; then
		_INSTALL_USER_SESSION_DIR="$session"
		if ! install_user_self_check "$expose_token"; then
			log_error "The dependency install would not be isolated from setup secrets; it is not run"
			rc=2
		elif ! install_user_handover "$dir" "$uid" "$gid"; then
			log_error "Could not hand ${dir} to ${_INSTALL_USER_NAME}"
			rc=2
		else
			"$@" || rc=$?
		fi
	fi

	_INSTALL_USER_SESSION_DIR=""
	_INSTALL_USER_SESSION_ENV=()
	rm -rf -- "$session"
	if ! install_user_handover "$dir" 0 0; then
		log_error "Could not give ${dir} back to root"
		rc=1
	fi
	return "$rc"
}
