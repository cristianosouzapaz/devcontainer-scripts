#!/bin/bash

[[ -n "${_PERSISTENT_DATA_REGISTRY_SH_LOADED:-}" ]] && return 0
readonly _PERSISTENT_DATA_REGISTRY_SH_LOADED=1

# Registry access for persistent-data categories.

_PERSISTENT_DATA_REGISTRY="${PERSISTENT_DATA_REGISTRY:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/config/persistent-data.json}"

# persistent_data_registry_validate: Validates the persistent-data registry.
# Args: none.
# Returns: 0 when valid, 1 otherwise.
persistent_data_registry_validate() {
	local schema_errors category_errors

	if ! command -v jq >/dev/null 2>&1; then
		log_error 'Persistent-data registry requires jq'
		return 1
	fi
	if [[ ! -r "$_PERSISTENT_DATA_REGISTRY" ]]; then
		log_error "Persistent-data registry is not readable: $_PERSISTENT_DATA_REGISTRY"
		return 1
	fi

	schema_errors=$(jq -r '
		if (.schemaVersion | type) != "number" or .schemaVersion < 1 or (.schemaVersion | floor) != .schemaVersion then "invalid schemaVersion" else empty end,
		if (.categories | type) != "array" then "categories must be an array" else empty end
	' "$_PERSISTENT_DATA_REGISTRY" 2>/dev/null) || schema_errors='invalid JSON'
	if [[ -n "$schema_errors" ]]; then
		log_error "Invalid persistent-data registry: $schema_errors"
		return 1
	fi

	category_errors=$(jq -r '
		.categories as $categories |
		if ([ $categories[].id ] | unique | length) != ($categories | length) then "duplicate category id" else empty end,
		$categories[] |
		if (type != "object") then "category must be an object"
		elif (has("id") and has("scope") and has("relativePath") and has("label") and has("group") and has("binary") and has("statusCheck") and has("resettable") | not) then "missing category field"
		elif (.id | type) != "string" or (.id | test("^[a-z0-9-]+$") | not) then "invalid category id"
		elif (.scope != "shared" and .scope != "project") then "invalid scope"
		elif (.group != "authentication" and .group != "tool") then "invalid group"
		elif (.statusCheck != "directory" and .statusCheck != "claude" and .statusCheck != "codex" and .statusCheck != "github") then "invalid statusCheck"
		elif (.relativePath | type) != "string" or (.relativePath | startswith("/")) or ([.relativePath | split("/")[]] | any(. == "" or . == "." or . == "..")) then "invalid relativePath"
		elif (.label | type) != "string" or (.label | length) == 0 then "invalid label"
		elif ((.binary | type) != "string" and .binary != null) then "invalid binary"
		elif (.resettable | type) != "boolean" then "invalid resettable"
		else empty end
	' "$_PERSISTENT_DATA_REGISTRY" 2>/dev/null) || category_errors='invalid categories'
	if [[ -n "$category_errors" ]]; then
		log_error "Invalid persistent-data registry: $category_errors"
		return 1
	fi
	return 0
}

# persistent_data_category: Prints the JSON record for a registered category.
# Args: category id.
# Returns: 0 when found, 1 otherwise.
persistent_data_category() {
	local category_id="$1" category

	persistent_data_registry_validate || return 1
	category=$(jq -c --arg id "$category_id" '.categories[] | select(.id == $id)' "$_PERSISTENT_DATA_REGISTRY") || return 1
	if [[ -z "$category" ]]; then
		log_error "Unknown persistent-data category: $category_id"
		return 1
	fi
	printf '%s\n' "$category"
}

# persistent_data_category_ids: Prints registered category IDs in registry order.
# Args: none.
# Returns: 0 when the registry is valid, 1 otherwise.
persistent_data_category_ids() {
	persistent_data_registry_validate || return 1
	jq -r '.categories[].id' "$_PERSISTENT_DATA_REGISTRY"
}

export -f persistent_data_registry_validate persistent_data_category persistent_data_category_ids
