# shellcheck shell=bash
[[ -n "${_INVENTORY_SH_LOADED:-}" ]] && return 0
readonly _INVENTORY_SH_LOADED=1

# Assembles and reads the inventory: the coding agents, one pack folder each under
# coding-agents/, and the persistent-data categories each setup unit declares in its
# CORE_PERSIST or MODULE_PERSIST metadata and defines in its <unit>.persist.json.
# Nothing else lists an agent or a category. Every lookup sees every agent; the
# _selected readers see only the agents CODING_AGENTS selects.

# ----- INTERNAL CONSTANTS -----------------------------------------------------

# why: tests point the readers at a whole assembled document; the shipped tree never sets it
_DEVCONTAINER_INVENTORY="${DEVCONTAINER_INVENTORY:-}"
# shellcheck disable=SC2016 # jq variables, not shell expansions.
readonly _INVENTORY_ASSEMBLE_FILTER='
	($owners | split("\n") | map(select(length > 0) | split("\t") | {key: .[0], value: (.[1] | split(" ") | map(select(length > 0)))}) | from_entries) as $declared |
	reduce inputs as $document ({agents: [], categories: []};
		input_filename as $file |
		if ($file | endswith("/agent.json")) then
			($file | split("/") | .[-2]) as $id |
			.agents += [$document + {id: $id, relativePath: ("config/" + $id), homeLink: ("." + $id),
				assetsDir: (($file | rtrimstr("agent.json")) + "assets")}]
		else
			.categories += [$declared[$file][] as $id | (if ($document | type) == "object" then $document[$id] else null end) as $category |
				(if ($category | type) == "object" then $category else {} end) + {id: $id}]
		end) |
	.agents |= sort_by(.id) | .categories |= sort_by(.id)
'
# why: tests .resettable against null, since // true would also replace an explicit false
# shellcheck disable=SC2016 # jq variables, not shell expansions.
readonly _INVENTORY_ENTRY_FILTER='
	(if $section == "all" then "agents", "categories" else $section end) as $source |
	.[$source][] | select(.id == $id) |
	if $source == "agents" then . + {identity: .id, binary: .command, scope: "shared"} else . end |
	if .resettable == null then .resettable = true else . end
'

# ----- INTERNAL HELPERS -------------------------------------------------------

# inventory_assemble: prints the inventory assembled from the agent packs and the units' persistent-data declarations
# Stdout: the inventory as one JSON document
# Returns: 1 when jq is missing or a pack or declaration file cannot be read or parsed.
inventory_assemble() {
	local unit persist owners='' unit_file
	local -a sources=()

	command -v jq >/dev/null 2>&1 || return 1
	for unit in "$DEVCONTAINER_CORE_DIR"/*.sh "$DEVCONTAINER_MODULES_DIR"/*.sh; do
		[[ -f "$unit" ]] || continue
		persist=$(registry_read_meta "$unit" 'PERSIST')
		[[ -n "$persist" ]] || continue
		unit_file="${unit%.sh}.persist.json"
		sources+=("$unit_file")
		owners+="${unit_file}"$'\t'"${persist}"$'\n'
	done
	for unit in "$DEVCONTAINER_AGENTS_DIR"/*/agent.json; do
		[[ -f "$unit" ]] && sources+=("$unit")
	done
	if [[ "${#sources[@]}" -eq 0 ]]; then
		printf '%s\n' '{"agents":[],"categories":[]}'
		return 0
	fi
	jq -cn --arg owners "$owners" "$_INVENTORY_ASSEMBLE_FILTER" "${sources[@]}"
}

# inventory_document: prints the inventory, from DEVCONTAINER_INVENTORY when set, else assembled from the tree
# Stdout: the inventory as one JSON document
inventory_document() {
	if [[ -n "$_DEVCONTAINER_INVENTORY" ]]; then
		jq -c . "$_DEVCONTAINER_INVENTORY"
		return
	fi
	inventory_assemble
}

# inventory_selected_agents: prints the coding agent IDs CODING_AGENTS lists, one per line, else those whose pack sets default
# Stdout: the selected agent IDs
inventory_selected_agents() {
	local -a ids=()

	# why: -d '' reads past newlines, so an ID on any line of the value counts; read then fails at the end of input
	read -rd '' -a ids <<<"${CODING_AGENTS:-}" || true
	[[ "${#ids[@]}" -gt 0 ]] || read -rd '' -a ids <<<"$_INVENTORY_DEFAULT_AGENTS" || true
	[[ "${#ids[@]}" -gt 0 ]] || return 0
	printf '%s\n' "${ids[@]}"
}

# inventory_check_selection: succeeds when every ID CODING_AGENTS lists names an agent pack, logging the valid IDs otherwise
inventory_check_selection() {
	local packs unknown valid

	packs=$(inventory_read -c '[.agents[].id]' 2>/dev/null) || return 0
	unknown=$(inventory_selected_agents | jq -Rr --argjson packs "$packs" 'select(. as $id | $packs | index($id) | not)')
	[[ -n "$unknown" ]] || return 0
	valid=$(jq -r 'join(" ")' <<<"$packs")
	log_error "Unknown coding agent in CODING_AGENTS: ${unknown//$'\n'/ } (valid: ${valid})"
	return 1
}

# inventory_select <document>: prints the inventory with only the agents CODING_AGENTS selects
# Stdout: the inventory as one JSON document
inventory_select() {
	local -a ids=()

	mapfile -t ids < <(inventory_selected_agents)
	jq -c '.agents |= map(select(.id as $id | $ARGS.positional | index($id)))' --args "${ids[@]}" <<<"$1"
}

# why: assembled once per process, since every lookup below would otherwise rescan the tree
_INVENTORY_DOCUMENT=$(inventory_document 2>/dev/null) || _INVENTORY_DOCUMENT=''
# why: the packs an unset CODING_AGENTS selects, the same ones the picker pre-checks
_INVENTORY_DEFAULT_AGENTS=$(jq -r '[.agents[] | select(.default == true).id] | join(" ")' <<<"$_INVENTORY_DOCUMENT" 2>/dev/null) \
	|| _INVENTORY_DEFAULT_AGENTS=''
# why: install, Herdr and the sync act on the selected agents only, while persistent data keeps every agent's category reachable
_INVENTORY_SELECTED=$(inventory_select "$_INVENTORY_DOCUMENT" 2>/dev/null) || _INVENTORY_SELECTED=''

# inventory_read <jq_argument...>: runs jq over the assembled inventory, failing when it could not be assembled
# Stdout: jq's output
inventory_read() {
	if [[ -z "$_INVENTORY_DOCUMENT" ]]; then
		log_error 'Inventory is unavailable: run inventory_validate for the cause'
		return 1
	fi
	jq "$@" <<<"$_INVENTORY_DOCUMENT"
}

# inventory_read_selected <jq_argument...>: runs jq over the inventory restricted to the agents CODING_AGENTS selects, failing when it could not be assembled
# Stdout: jq's output
inventory_read_selected() {
	if [[ -z "$_INVENTORY_SELECTED" ]]; then
		log_error 'Inventory is unavailable: run inventory_validate for the cause'
		return 1
	fi
	jq "$@" <<<"$_INVENTORY_SELECTED"
}

# ----- FUNCTIONS --------------------------------------------------------------

# inventory_selected_ids: prints the IDs of the agents CODING_AGENTS selects that have a pack, sorted by ID
# Stdout: one agent ID per line
inventory_selected_ids() {
	inventory_read_selected -r '.agents[].id'
}

# inventory_validate: assembles the inventory afresh and validates it, logging the offending entries and fields
inventory_validate() {
	local document errors

	if ! command -v jq >/dev/null 2>&1; then
		log_error 'Inventory requires jq'
		return 1
	fi
	if ! document=$(inventory_document 2>/dev/null); then
		log_error 'Inventory cannot be assembled: a pack agent.json or a unit .persist.json is missing or not JSON'
		return 1
	fi
	errors=$(jq -r '
		def safe_relative_path: type == "string" and length > 0 and (startswith("/") | not)
			and (split("/") | all(. != "" and . != "." and . != ".."));
		def nonempty_string: type == "string" and length > 0;
		def matches($pattern): if type == "string" then test($pattern) else false end;
		def valid_asset:
			if type != "object" then false
			elif ((keys_unsorted - ["id", "type", "source", "target", "enforce"]) | length) != 0 then false
			elif has("enforce") and (.type != "merge-toml" or (.enforce | type) != "array"
				or (.enforce | all(.[]; matches("^[A-Za-z_][A-Za-z0-9_-]*[[:space:]]*=")) | not)) then false
			elif (.id | nonempty_string | not) then false
			elif (.type as $type | ["managed-file", "merge-json", "merge-toml", "package"] | index($type) == null) then false
			elif (.source | nonempty_string | not) then false
			elif (.type == "package") then (has("target") | not)
			elif (.source | safe_relative_path | not) then false
			else (.target | safe_relative_path) end;
		def valid_assets:
			type == "array" and all(.[]; valid_asset) and ((map(.id) | unique | length) == length);
		def valid_exposure($modes):
			type == "object" and ((keys_unsorted - ["path", "mode"]) | length) == 0
			and (.mode as $mode | $modes | index($mode) != null)
			and (if .mode == "none" then (has("path") | not) else (.path | safe_relative_path) end);
		if (.agents | type) != "array" then "agents must be an array"
		elif (.categories | type) != "array" then "categories must be an array"
		else . as $document |
		("agents", "categories") as $section |
		.[$section] | to_entries[] | .key as $index | .value |
		"\($section)[\($index)]" as $position | . as $entry |
		(if $section == "agents" then
			["id", "relativePath", "homeLink", "assetsDir", "label", "default", "command", "npmPackage", "loginHint", "herdrIntegration", "assets", "resettable", "skills", "rules", "instructions", "projectInstructions", "skillsCliAgent", "credential"]
		else ["id", "scope", "relativePath", "homeLink", "label", "identity", "binary", "loginHint", "resettable"] end) as $allowed |
		(
			(keys_unsorted[] | select(. as $key | $allowed | index($key) | not) | "unexpected " + .),
			(if (.id | matches(if $section == "agents" then "^[a-z][a-z0-9_]*$" else "^[a-z0-9-]+$" end) | not) then "invalid id"
			elif ([$document.agents[], $document.categories[] | select(.id == $entry.id)] | length) > 1 then "duplicate id" else empty end),
			(if (.label | nonempty_string | not) then "invalid label" else empty end),
			(if (.relativePath | safe_relative_path | not) then "invalid relativePath" else empty end),
			(if (has("homeLink") | not) or (.homeLink != null and (.homeLink | safe_relative_path | not)) then "invalid homeLink" else empty end),
			(if has("resettable") and (.resettable | type) != "boolean" then "invalid resettable" else empty end),
			(if has("assets") and (.assets | valid_assets | not) then "invalid assets" else empty end),
			(if $section == "agents" then
				(["command", "npmPackage", "loginHint"][] as $field | if (.[$field] | nonempty_string | not) then "invalid " + $field else empty end),
				(if (.herdrIntegration | type) != "boolean" then "invalid herdrIntegration" else empty end),
				(if has("default") and (.default | type) != "boolean" then "invalid default" else empty end),
				(if (.skills | valid_exposure(["symlink", "none"]) | not) then "invalid skills" else empty end),
				(if has("rules") and (.rules | valid_exposure(["symlink", "none"]) | not) then "invalid rules" else empty end),
				(["instructions", "projectInstructions"][] as $field |
					if has($field) and (.[$field] | valid_exposure(["import", "copy", "none"]) | not) then "invalid " + $field else empty end),
				(if has("credential") and (.credential | type != "object" or ((keys_unsorted - ["env", "dir", "file"]) | length) != 0
					or (.env | matches("^[A-Z_][A-Z0-9_]*$") | not) or (.dir | safe_relative_path | not) or (.file | safe_relative_path | not))
					then "invalid credential" else empty end),
				(if has("skillsCliAgent") and (.skillsCliAgent | nonempty_string | not) then "invalid skillsCliAgent" else empty end)
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
	' <<<"$document" 2>/dev/null) || errors='invalid document'
	if [[ -n "$errors" ]]; then
		log_error "Invalid inventory: $errors"
		return 1
	fi
	return 0
}

# inventory_check_section <section>: succeeds for agents, categories or all, logging an error for any other
inventory_check_section() {
	[[ "$1" =~ ^(agents|categories|all)$ ]] && return 0
	log_error "Unknown inventory section: $1"
	return 1
}

# inventory_ids <agents|categories|all>: prints the entry IDs of a section, agents then categories, each sorted by ID
# Stdout: one entry ID per line
inventory_ids() {
	local section="$1"

	inventory_check_section "$section" || return 1
	inventory_read -r --arg section "$section" "(if \$section == \"all\" then .agents[], .categories[] else .[\$section][] end) | .id"
}

# inventory_entry <agents|categories|all> <id>: prints one entry as compact JSON, with the conventional fields filled in
# Stdout: the entry as one line of compact JSON
inventory_entry() {
	local section="$1" id="$2" entry

	inventory_check_section "$section" || return 1
	entry=$(inventory_read -c --arg section "$section" --arg id "$id" "$_INVENTORY_ENTRY_FILTER") || return 1
	if [[ -z "$entry" ]]; then
		log_error "Unknown inventory entry: $section $id"
		return 1
	fi
	printf '%s\n' "$entry"
}

# inventory_fields <agents|categories|all> <id> <field...>: prints the requested fields of an entry joined by unit separators, a null or absent field as empty
# Stdout: the fields joined by U+001F, one line
inventory_fields() {
	local section="$1" id="$2"

	shift 2
	inventory_check_section "$section" || return 1
	inventory_read -er --arg section "$section" --arg id "$id" --args "$_INVENTORY_ENTRY_FILTER
		| [\$ARGS.positional[] as \$field | .[\$field] | if . == null then \"\" else tostring end] | join(\"\\u001f\")
	" "$@" || {
		log_error "Unknown inventory entry: $section $id"
		return 1
	}
}

# inventory_assets <agent_id>: prints each asset the agent's pack declares as compact JSON, one per line
# Stdout: one asset as compact JSON per line
inventory_assets() {
	inventory_read -c --arg id "$1" "(.agents[] | select(.id == \$id) | .assets // [])[]"
}

# agent_asset <agent_id> <asset_id>: prints the agent's pack asset as compact JSON, empty when it declares none under that id
# Stdout: the asset as compact JSON, or nothing
agent_asset() {
	inventory_assets "$1" | jq -c --arg id "$2" 'select(.id == $id)'
}

# asset_target <agent_id> <asset_json>: prints the absolute path an agent asset is written to
# Stdout: the target file path, one line
# Notes: every target resolves under the agent's persistent-data category. The managed
#   home link points at that directory, so a CLI reading through the link sees the file
#   setup wrote.
asset_target() {
	local category_path

	category_path=$(persistent_data_category_path "$1") || return 1
	printf '%s/%s\n' "${category_path}" "$(jq -r '.target' <<<"$2")"
}

# inventory_asset_source <agent_id> <asset_json>: prints the shipped file an agent asset is written from, failing when it is missing
# Stdout: the shipped file path, one line
inventory_asset_source() {
	local assets_dir source

	assets_dir=$(inventory_fields agents "$1" assetsDir) || return 1
	source="${assets_dir}/$(jq -r '.source' <<<"$2")"
	if [[ ! -f "$source" ]]; then
		log_error "Pack asset source is missing: ${source}"
		return 1
	fi
	printf '%s\n' "$source"
}

# agent_probe <command> [args...]: runs an agent's diagnostic command under a fixed deadline
# Returns: the command's status; 124 or 137 for a timeout, 125 when timeout is unavailable.
agent_probe() {
	command -v timeout >/dev/null 2>&1 || return 125
	timeout --kill-after=2s 10s "$@"
}

# agent_identity <agent_id>: prints the account the agent is logged in as, through its pack's agent_<id>_identity hook
# Stdout: the identity, one line
# Returns: 1 when not authenticated or the pack has no identity hook; a probe timeout's status otherwise.
agent_identity() {
	local hook="agent_${1}_identity"

	declare -F "$hook" >/dev/null || return 1
	"$hook"
}

# ----- AGENT HOOKS ------------------------------------------------------------

for _inventory_hooks in "$DEVCONTAINER_AGENTS_DIR"/*/hooks.sh; do
	if [[ -f "$_inventory_hooks" ]]; then
		# shellcheck source=/dev/null
		source "$_inventory_hooks"
	fi
done
unset _inventory_hooks

export -f inventory_assemble inventory_document inventory_selected_agents inventory_check_selection inventory_select \
	inventory_read inventory_read_selected inventory_selected_ids inventory_validate inventory_check_section inventory_ids \
	inventory_entry inventory_fields inventory_assets agent_asset asset_target inventory_asset_source \
	agent_probe agent_identity
