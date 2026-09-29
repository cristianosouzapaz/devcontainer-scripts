# shellcheck shell=bash
[[ -n "${_GLOBAL_AGENT_ASSETS_SH_LOADED:-}" ]] && return 0
readonly _GLOBAL_AGENT_ASSETS_SH_LOADED=1

# Persistent, machine-wide sync state shared by the sync entrypoint and diagnostics.

# global_agent_assets_metadata_path: prints the private metadata file in the agents category
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

export -f global_agent_assets_metadata_path global_agent_assets_metadata_validate_path \
	global_agent_assets_metadata_valid global_agent_assets_metadata_write global_agent_assets_metadata_read
