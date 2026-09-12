#!/bin/bash

[[ -n "${_CODING_AGENTS_SH_LOADED:-}" ]] && return 0
readonly _CODING_AGENTS_SH_LOADED=1

# Catalog access for coding-agent CLI definitions.

# CODING_AGENTS_CATALOG (optional path): overrides the catalog location; defaults to
# coding-agents.json under DEVCONTAINER_CONFIG_DIR, which loader.sh publishes.
_CODING_AGENTS_CATALOG="${CODING_AGENTS_CATALOG:-${DEVCONTAINER_CONFIG_DIR}/coding-agents.json}"
# Path of the catalog last validated successfully, so accessors validate it once.
_CODING_AGENTS_VALIDATED=''

# coding_agents_validate: Validates the coding-agent catalog, once per catalog path.
# Args: none.
# Returns: 0 when valid, 1 otherwise.
coding_agents_validate() {
	local errors

	[[ "$_CODING_AGENTS_VALIDATED" == "$_CODING_AGENTS_CATALOG" ]] && return 0
	if ! command -v jq >/dev/null 2>&1; then
		log_error 'Coding-agent catalog requires jq'
		return 1
	fi
	if [[ ! -r "$_CODING_AGENTS_CATALOG" ]]; then
		log_error "Coding-agent catalog is not readable: $_CODING_AGENTS_CATALOG"
		return 1
	fi

	errors=$(jq -r '
		if (.agents | type) != "array" then "agents must be an array"
		elif ([.agents[].id] | unique | length) != (.agents | length) then "duplicate agent id"
		else
			.agents[] |
			if type != "object" then "agent must be an object"
			elif (has("id") and has("label") and has("command") and has("npmPackage") and has("herdrIntegration") and has("loginHint") | not) then "missing agent field"
			elif (.id | type) != "string" or (.id | test("^[a-z0-9-]+$") | not) then "invalid agent id"
			elif (.label | type) != "string" or length == 0 then "invalid agent label"
			elif (.command | type) != "string" or length == 0 then "invalid agent command"
			elif (.npmPackage | type) != "string" or length == 0 then "invalid agent npmPackage"
			elif (.herdrIntegration | type) != "boolean" then "invalid agent herdrIntegration"
			elif (.loginHint | type) != "string" or length == 0 then "invalid agent loginHint"
			else empty end
		end
	' "$_CODING_AGENTS_CATALOG" 2>/dev/null) || errors='invalid JSON'
	if [[ -n "$errors" ]]; then
		log_error "Invalid coding-agent catalog: $errors"
		return 1
	fi
	_CODING_AGENTS_VALIDATED="$_CODING_AGENTS_CATALOG"
}

# coding_agents_ids: Prints catalog agent IDs in install order.
# Args: none.
# Returns: 0 when the catalog is valid, 1 otherwise.
coding_agents_ids() {
	coding_agents_validate || return 1
	jq -r '.agents[].id' "$_CODING_AGENTS_CATALOG"
}

# coding_agents_field: Prints one field from a catalog agent.
# Args: $1 - agent id; $2 - field name.
# Returns: 0 when found, 1 otherwise.
coding_agents_field() {
	local agent_id="$1" field="$2" value

	coding_agents_validate || return 1
	value=$(jq -r --arg id "$agent_id" --arg field "$field" \
		'.agents[] | select(.id == $id) | .[$field]' "$_CODING_AGENTS_CATALOG") || return 1
	[[ -n "$value" && "$value" != 'null' ]] || return 1
	printf '%s\n' "$value"
}

export -f coding_agents_validate coding_agents_ids coding_agents_field
