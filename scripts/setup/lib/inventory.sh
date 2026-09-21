# shellcheck shell=bash
[[ -n "${_INVENTORY_SH_LOADED:-}" ]] && return 0
readonly _INVENTORY_SH_LOADED=1

# Reads and validates the inventory that lists the coding agents, their
# shipped assets, and the persistent-data categories.

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_DEVCONTAINER_INVENTORY="${DEVCONTAINER_INVENTORY:-${DEVCONTAINER_SCRIPTS_DIR}/inventory.json}"
# why: tests .resettable against null, since // true would also replace an explicit false
# shellcheck disable=SC2016 # jq variables, not shell expansions.
readonly _INVENTORY_ENTRY_FILTER='
	(if $section == "all" then "agents", "categories" else $section end) as $source |
	.[$source][] | select(.id == $id) |
	if $source == "agents" then . + {identity: .id, binary: .command, scope: "shared"} else . end |
	if .resettable == null then .resettable = true else . end
'

# ----- FUNCTIONS --------------------------------------------------------------

# inventory_validate: validates the whole document as written, without caching, logging the offending entries and fields
inventory_validate() {
	local errors

	if ! command -v jq >/dev/null 2>&1; then
		log_error 'Inventory requires jq'
		return 1
	fi
	if [[ ! -r "$_DEVCONTAINER_INVENTORY" ]]; then
		log_error "Inventory is not readable: $_DEVCONTAINER_INVENTORY"
		return 1
	fi
	errors=$(jq -rs '
		def safe_relative_path: type == "string" and length > 0 and (startswith("/") | not)
			and (split("/") | all(. != "" and . != "." and . != ".."));
		def nonempty_string: type == "string" and length > 0;
		def matches($pattern): if type == "string" then test($pattern) else false end;
		def valid_asset:
			if type != "object" then false
			elif ((keys_unsorted - ["id", "type", "source", "target"]) | length) != 0 then false
			elif (.id | nonempty_string | not) then false
			elif (.type as $type | ["managed-file", "seed-file", "merge-json", "merge-toml", "append-once", "package"] | index($type) == null) then false
			elif (.source | nonempty_string | not) then false
			elif (.type != "package" and (.source | safe_relative_path | not)) then false
			elif (.type == "package") then (has("target") | not)
			elif (has("target") | not) then false
			elif (.type == "append-once") then (.target | type == "string" and startswith("/"))
			else (.target | safe_relative_path) end;
		def valid_assets:
			type == "array" and all(.[]; valid_asset) and ((map(.id) | unique | length) == length);
		if length != 1 then "expected one JSON document"
		elif (.[0] | type) != "object" then "document must be an object"
		else .[0] |
			if (.persistentDataLayoutVersion | type) != "number" then "invalid persistentDataLayoutVersion"
			elif .persistentDataLayoutVersion < 1 or (.persistentDataLayoutVersion | floor) != .persistentDataLayoutVersion then "invalid persistentDataLayoutVersion"
			elif (.agents | type) != "array" then "agents must be an array"
			elif (.categories | type) != "array" then "categories must be an array"
			else . as $document |
				("agents", "categories") as $section |
				.[$section] | to_entries[] | .key as $index | .value |
				"\($section)[\($index)]" as $position |
				if type != "object" then "\($position): invalid entry (expected object)"
				else . as $entry |
					(if $section == "agents" then
						["id", "label", "command", "npmPackage", "loginHint", "herdrIntegration", "relativePath", "homeLink", "assets", "resettable"]
					else ["id", "scope", "relativePath", "homeLink", "label", "identity", "binary", "loginHint", "assets", "resettable"] end) as $allowed |
					(
						(keys_unsorted[] | select(. as $key | $allowed | index($key) | not) | "unexpected " + .),
						(if (.id | matches(if $section == "agents" then "^[a-z][a-z0-9_]*$" else "^[a-z0-9-]+$" end) | not) then "invalid id"
						elif ([$document.agents[], $document.categories[] | objects | select(.id == $entry.id)] | length) > 1 then "duplicate id" else empty end),
						(if (.label | nonempty_string | not) then "invalid label" else empty end),
						(if (.relativePath | safe_relative_path | not) then "invalid relativePath" else empty end),
						(if (has("homeLink") | not) or (.homeLink != null and (.homeLink | safe_relative_path | not)) then "invalid homeLink" else empty end),
						(if has("resettable") and (.resettable | type) != "boolean" then "invalid resettable" else empty end),
						(if has("assets") and (.assets | valid_assets | not) then "invalid assets" else empty end),
						(if $section == "agents" then
							(["command", "npmPackage", "loginHint"][] as $field | if (.[$field] | nonempty_string | not) then "invalid " + $field else empty end),
							(if (.herdrIntegration | type) != "boolean" then "invalid herdrIntegration" else empty end),
							(if (.id | type) == "string" then
								(if .relativePath != "config/" + .id then "invalid relativePath (expected config/<id>)" else empty end),
								(if .homeLink != null and .homeLink != "." + .id then "invalid homeLink (expected .<id> or null)" else empty end)
							else empty end)
						else
							(if .scope != "shared" and .scope != "project" then "invalid scope" else empty end),
							(if has("identity") and (.identity | matches("^[a-z][a-z0-9_]*$") | not) then "invalid identity" else empty end),
							(if has("identity") != has("loginHint") then "identity and loginHint must appear together" else empty end),
							(if has("loginHint") and (.loginHint | nonempty_string | not) then "invalid loginHint" else empty end),
							(if has("binary") and (.binary | nonempty_string | not) then "invalid binary" else empty end),
							(if has("binary") and (has("identity") | not) then "invalid binary (requires identity)" else empty end)
						end)
					) | "\($position) \($entry.id | tojson): \(.)"
				end
			end
		end
	' "$_DEVCONTAINER_INVENTORY" 2>/dev/null) || errors='invalid JSON'
	if [[ -n "$errors" ]]; then
		log_error "Invalid inventory: $errors"
		return 1
	fi
	return 0
}

# inventory_ids <agents|categories|all>: prints the entry IDs of a section in document order
inventory_ids() {
	local section="$1"

	case "$section" in
	agents|categories|all) ;;
	*)
		log_error "Unknown inventory section: $section"
		return 1
		;;
	esac
	jq -r --arg section "$section" '(if $section == "all" then .agents[], .categories[] else .[$section][] end) | .id' "$_DEVCONTAINER_INVENTORY" || return 1
}

# inventory_entry <agents|categories|all> <id>: prints one entry as compact JSON, with the conventional fields filled in
inventory_entry() {
	local section="$1" id="$2" entry

	case "$section" in
	agents|categories|all) ;;
	*)
		log_error "Unknown inventory section: $section"
		return 1
		;;
	esac
	entry=$(jq -c --arg section "$section" --arg id "$id" \
		"$_INVENTORY_ENTRY_FILTER" "$_DEVCONTAINER_INVENTORY") || return 1
	if [[ -z "$entry" ]]; then
		log_error "Unknown inventory entry: $section $id"
		return 1
	fi
	printf '%s\n' "$entry"
}

# inventory_fields <agents|categories|all> <id> <field...>: prints the requested fields of an entry joined by unit separators, a null or absent field as empty
inventory_fields() {
	local section="$1" id="$2"

	shift 2
	case "$section" in
	agents|categories|all) ;;
	*)
		log_error "Unknown inventory section: $section"
		return 1
		;;
	esac
	jq -er --arg section "$section" --arg id "$id" --args "$_INVENTORY_ENTRY_FILTER"'
		| . as $entry | [$ARGS.positional[] | $entry[.] |
		if . == null then "" else tostring end] | join("\u001f")
	' "$@" <"$_DEVCONTAINER_INVENTORY" || {
		log_error "Unknown inventory entry: $section $id"
		return 1
	}
}

# inventory_assets <agents|categories> <id>: prints each declared asset as compact JSON, one per line
inventory_assets() {
	local section="$1" id="$2"

	case "$section" in
	agents|categories) ;;
	*)
		log_error "Unknown inventory section: $section"
		return 1
		;;
	esac
	jq -c --arg section "$section" --arg id "$id" \
		'(.[ $section ][] | select(.id == $id) | .assets // [])[]' \
		"$_DEVCONTAINER_INVENTORY" || return 1
}

# inventory_layout_version: prints the persistent-data layout version
inventory_layout_version() {
	jq -r '.persistentDataLayoutVersion' "$_DEVCONTAINER_INVENTORY"
}

export -f inventory_layout_version inventory_validate inventory_ids inventory_entry inventory_fields inventory_assets
