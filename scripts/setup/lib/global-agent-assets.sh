# shellcheck shell=bash
[[ -n "${_GLOBAL_AGENT_ASSETS_SH_LOADED:-}" ]] && return 0
readonly _GLOBAL_AGENT_ASSETS_SH_LOADED=1

# Persistent, machine-wide sync state shared by the sync entrypoint and diagnostics, and the
# source ref every installer refresh resolves, so a direct run and a sync activate the same release.

# ----- INSTALLER SOURCE -------------------------------------------------------

# scripts_ref_is_release: succeeds when the image's SCRIPTS_REF is empty or a release tag (vX.Y.Z)
scripts_ref_is_release() {
	[[ -z "${SCRIPTS_REF:-}" || "${SCRIPTS_REF}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

# resolve_assets_ref: prints the requested global-assets ref: the stable release channel when SCRIPTS_REF is a release, else SCRIPTS_REF itself
# Stdout: the ref, one line
# Notes: this is deliberately not persisted: refs are mutable input, while the resolved SHA is state.
#   Deriving it from SCRIPTS_REF keeps the image and the assets on one channel.
resolve_assets_ref() {
	if scripts_ref_is_release; then
		printf '%s\n' stable
	else
		printf '%s\n' "${SCRIPTS_REF}"
	fi
}

# resolve_assets_repo: prints the explicitly requested installer repository, defaulting to the public release source
# Stdout: the owner/name repository, one line
resolve_assets_repo() {
	local scripts_repo="${SCRIPTS_REPO:-cristianosouzapaz/devcontainer-scripts}"
	[[ "${scripts_repo}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$ ]] || return 1
	printf '%s\n' "${scripts_repo}"
}

# resolve_assets_sha <ref>: resolves a requested ref once to the immutable SHA used by every installer download
# Stdout: the 40-character SHA, one line
# Notes: a full SHA is used as is; any other ref is resolved with git ls-remote, peeled tag first,
#   because the GitHub REST API's unauthenticated budget is shared by the whole host IP. The lookup
#   never prompts for credentials, so a missing or private repository fails instead of hanging.
resolve_assets_sha() {
	local requested_ref="$1" scripts_repo refs sha="" wanted

	if [[ "$requested_ref" =~ ^[a-f0-9]{40}$ ]]; then
		printf '%s\n' "$requested_ref"
		return 0
	fi
	scripts_repo="$(resolve_assets_repo)" || return 1
	command -v git >/dev/null 2>&1 || return 1
	refs=$(GIT_TERMINAL_PROMPT=0 timeout --kill-after=2s 10s git ls-remote "https://github.com/${scripts_repo}.git" \
		"refs/tags/${requested_ref}^{}" "refs/tags/${requested_ref}" "refs/heads/${requested_ref}") || return 1
	for wanted in "refs/tags/${requested_ref}^{}" "refs/tags/${requested_ref}" "refs/heads/${requested_ref}"; do
		sha=$(awk -v ref="$wanted" '$2 == ref { print $1; exit }' <<<"$refs")
		[[ -z "$sha" ]] || break
	done
	[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || return 1
	printf '%s\n' "$sha"
}

# resolve_assets_source: sets ASSETS_REF and ASSETS_SHA to the installer source, falling back to the image's SCRIPTS_REF when the stable channel does not resolve
# Returns: 1 when no ref resolves; ASSETS_REF then names the last ref tried.
# Notes: a fork without the stable channel still installs a released ref, the one its
#   image was built from. A non-release SCRIPTS_REF is followed as is and never falls back.
resolve_assets_source() {
	local scripts_repo sha

	ASSETS_REF="$(resolve_assets_ref)"
	scripts_repo="$(resolve_assets_repo)" || return 1
	if ! sha="$(resolve_assets_sha "$ASSETS_REF")"; then
		[[ "$ASSETS_REF" == stable && -n "${SCRIPTS_REF:-}" ]] || return 1
		log_warning "Could not resolve ${scripts_repo}@${ASSETS_REF}; falling back to the image's SCRIPTS_REF (${SCRIPTS_REF})"
		ASSETS_REF="${SCRIPTS_REF}"
		sha="$(resolve_assets_sha "$ASSETS_REF")" || return 1
	fi
	# shellcheck disable=SC2034 # consumed by the caller, alongside ASSETS_REF
	ASSETS_SHA="$sha"
}

# ----- SYNC STATE -------------------------------------------------------------

# global_agent_assets_metadata_path: prints the private metadata file in the agents category
# Stdout: the metadata file path, one line
# Notes: state lives with the global assets it describes, rather than in a project root.
global_agent_assets_metadata_path() {
	local agents_path
	agents_path=$(persistent_data_category_path agents) || return 1
	printf '%s/.global-agent-assets.json\n' "$agents_path"
}

# global_agent_assets_metadata_validate_path: refuses an agents category or metadata file redirected outside shared storage
# Notes: sync writes this state, so unlike the read-only health consumer it must reject a
#   symlink before atomic_write can follow it.
global_agent_assets_metadata_validate_path() {
	local root root_real agents agents_real metadata metadata_real

	root=$(persistent_data_root shared) || return 1
	root_real=$(realpath -m "$root") || return 1
	agents=$(persistent_data_category_path agents) || return 1
	agents_real=$(realpath -m "$agents") || return 1
	metadata=$(global_agent_assets_metadata_path) || return 1
	metadata_real=$(realpath -m "$metadata") || return 1
	[[ "$agents_real" == "$root_real/agents" && "$metadata_real" == "$root_real/agents/.global-agent-assets.json" && ! -L "$metadata" ]]
}

# global_agent_assets_metadata_valid: accepts the versioned, immutable sync state schema
# Notes: reads JSON on stdin.
global_agent_assets_metadata_valid() {
	jq -e 'type == "object" and .version == 1 and
		(.requestedRef | type == "string" and length > 0) and
		(.resolvedRevision | type == "string" and test("^[a-f0-9]{40}$")) and
		(.timestamp | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
		(.state == "complete" or .state == "partial")' >/dev/null 2>&1
}

# global_agent_assets_metadata_write <requested-ref> <resolved-revision> <state>: atomically records a completed global sync
# Notes: callers hold the shared-data lock. The requested ref records operator intent;
#   the immutable resolved revision records precisely which tree was installed.
global_agent_assets_metadata_write() {
	local requested_ref="$1" resolved_revision="$2" state="$3" timestamp metadata

	timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ) || return 1
	metadata=$(global_agent_assets_metadata_path) || return 1
	global_agent_assets_metadata_validate_path || return 1
	mkdir -p "${metadata%/*}" || return 1
	# shellcheck disable=SC2016 # jq variables below are evaluated by jq, not this shell.
	atomic_write "$metadata" jq -cn \
		--arg requested_ref "$requested_ref" --arg resolved_revision "$resolved_revision" \
		--arg timestamp "$timestamp" --arg state "$state" \
		'{version: 1, requestedRef: $requested_ref, resolvedRevision: $resolved_revision,
		  timestamp: $timestamp, state: $state}'
}

# global_agent_assets_metadata_read: prints valid metadata, refusing malformed state
# Returns: 1 for missing, redirected, or malformed state so diagnostics never claim it is fresh.
global_agent_assets_metadata_read() {
	local metadata agents_path agents_real metadata_real

	metadata=$(global_agent_assets_metadata_path) || return 1
	global_agent_assets_metadata_validate_path || return 1
	agents_path=$(persistent_data_category_path agents) || return 1
	agents_real=$(realpath -m "$agents_path") || return 1
	metadata_real=$(realpath -m "$metadata") || return 1
	[[ "$metadata_real" == "$agents_real/.global-agent-assets.json" && -f "$metadata" && ! -L "$metadata" ]] || return 1
	global_agent_assets_metadata_valid < "$metadata" || return 1
	cat -- "$metadata"
}

export -f scripts_ref_is_release resolve_assets_ref resolve_assets_repo resolve_assets_sha resolve_assets_source global_agent_assets_metadata_path global_agent_assets_metadata_validate_path \
	global_agent_assets_metadata_valid global_agent_assets_metadata_write global_agent_assets_metadata_read
