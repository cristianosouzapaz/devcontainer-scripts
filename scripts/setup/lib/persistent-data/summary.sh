# shellcheck shell=bash
[[ -n "${_PERSISTENT_DATA_SUMMARY_SH_LOADED:-}" ]] && return 0
readonly _PERSISTENT_DATA_SUMMARY_SH_LOADED=1

# Logs the persistent-data blocks of the setup summary: Data, the names of the volumes
# that hold the user's data, and Sign-ins, the sign-in state of each agent and tool.
# Container paths stay at DEBUG; devcontainer-data shows them on demand.
#
# Mounts come from the kernel's mount table, so the summary needs no Docker access;
# without a readable table both blocks are silently skipped. Categories come only from
# the inventory; no second list of categories or volumes is kept here.

# ----- CONFIGURATION VARIABLES ------------------------------------------------

# Documented in README.md#configuration-variables:
# - STRUCTURED_LOGS

# ----- INTERNAL CONSTANTS -----------------------------------------------------

_MOUNTINFO_PATH="${_MOUNTINFO_PATH:-/proc/self/mountinfo}"

# ----- PUBLIC STATE -----------------------------------------------------------

# why: set by persistent_data_summary_sign_ins for the Action needed block that follows it
declare -ga SIGN_IN_ACTIONS=()

# ----- INTERNAL HELPERS -------------------------------------------------------

# persistent_data_summary_list_mounts: prints "<volume>|<destination>" for each named volume mounted on this container, nothing when the mount table cannot be read
# Stdout: one "<volume>|<destination>" line per named volume
# Notes: field 4 of a mountinfo line, the mount's root, is .../volumes/<name>/_data
#   for a named volume, also under a relocated Docker data root.
persistent_data_summary_list_mounts() {
	local root destination

	[[ -r "$_MOUNTINFO_PATH" ]] || return 0
	while read -r _ _ _ root destination _; do
		[[ "$root" =~ /volumes/([^/]+)/_data$ ]] || continue
		printf '%s|%s\n' "${BASH_REMATCH[1]}" "$destination"
	done <"$_MOUNTINFO_PATH"
}

# persistent_data_summary_mounts: reads the mount table into the caller's shared_root, project_root, shared_mounted, project_mounted, shared_volume and workspace_volume
# Returns: 1 when no named volume is mounted or a root cannot be resolved.
# Notes: sets the caller's locals through dynamic scope.
persistent_data_summary_mounts() {
	local mounts mount_name mount_dest

	mounts="$(persistent_data_summary_list_mounts)"
	if [[ -z "$mounts" ]]; then
		log_debug "Skipping persistent-data summary — no volume mounts found"
		return 1
	fi
	shared_root="$(persistent_data_root shared)" || return 1
	project_root="$(persistent_data_root project)" || return 1
	shared_mounted=false
	project_mounted=false
	shared_volume=''
	workspace_volume=''
	while IFS='|' read -r mount_name mount_dest; do
		[[ -n "$mount_name" ]] || continue
		case "$mount_dest" in
		"$shared_root") shared_mounted=true; shared_volume="$mount_name" ;;
		"$project_root") project_mounted=true; workspace_volume="$mount_name" ;;
		esac
	done <<<"$mounts"
}

# persistent_data_summary_github_identity: prints the account name from gh auth status, failing when not authenticated
# Stdout: the account name, one line
# Returns: 1 when not authenticated; any other non-zero status from the probe unchanged.
# Notes: asks the CLI rather than reading hosts.yml.
persistent_data_summary_github_identity() {
	local output rc=0
	command -v gh >/dev/null 2>&1 || return 1
	output="$(agent_probe gh auth status 2>&1)" || rc=$?
	[[ "$rc" -eq 0 ]] || return "$rc"
	sed -n 's/.*Logged in to [^ ]* account \([^ ]*\).*/\1/p' <<<"$output" | head -1
}

# persistent_data_summary_identity <identity>: prints the account behind an identity, from the agent pack's identity hook or persistent_data_summary_<identity>_identity, failing for an unknown identity or when not authenticated
# Stdout: the account, one line
# Returns: 1 when not authenticated or the identity is unknown; 124 or 137 when the probe timed out; any other status when the check itself failed.
persistent_data_summary_identity() {
	local probe="$1" identity_function

	identity_function="persistent_data_summary_${probe}_identity"
	if declare -F "$identity_function" >/dev/null; then
		"$identity_function"
		return
	fi
	agent_identity "$probe"
}

# persistent_data_summary_identity_state <identity>: prints the sign-in state behind an identity probe, as "<state>|<text>"
# Stdout: "signed-in|<account>", "signed-out|", "no-answer|no answer in <n>s" or "unchecked|could not check", one line
# Notes: only status 1 means signed out; a probe that never answered or failed says nothing about the sign-in.
persistent_data_summary_identity_state() {
	local identity probe_rc=0

	identity="$(persistent_data_summary_identity "$1")" || probe_rc=$?
	case "$probe_rc" in
	0 | 1)
		if [[ "$probe_rc" -eq 0 && -n "$identity" ]]; then
			printf 'signed-in|%s\n' "$identity"
		else
			printf '%s\n' 'signed-out|'
		fi
		;;
	124 | 137) printf 'no-answer|no answer in %ss\n' "$_AGENT_PROBE_TIMEOUT" ;;
	*) printf '%s\n' 'unchecked|could not check' ;;
	esac
}

# persistent_data_summary_row <width> <name> <value>: prints a row of a block, the name padded to width, or as "name: value" in structured logs
# Stdout: the row, one line
persistent_data_summary_row() {
	if [[ "$STRUCTURED_LOGS" == "true" ]]; then
		printf '%s: %s\n' "$2" "$3"
	else
		printf '%-*s  %s\n' "$1" "$2" "$3"
	fi
}

# ----- PUBLIC FUNCTIONS -------------------------------------------------------

# persistent_data_summary_data: logs the Data block: the shared and the workspace volume names, with every category's container path at DEBUG
persistent_data_summary_data() {
	local shared_root project_root shared_mounted project_mounted shared_volume workspace_volume
	local category_id fields label scope relative_path path mounted
	local -a ids=()

	persistent_data_summary_mounts || return 0
	[[ -n "$shared_volume" || -n "$workspace_volume" ]] || return 0

	log_info 'Data'
	[[ -z "$shared_volume" ]] ||
		log_item_info "$(persistent_data_summary_row 16 'Shared volume' "$shared_volume")"
	[[ -z "$workspace_volume" ]] ||
		log_item_info "$(persistent_data_summary_row 16 'Workspace volume' "$workspace_volume")"

	mapfile -t ids < <(inventory_ids all)
	for category_id in "${ids[@]}"; do
		[[ -n "$category_id" ]] || continue
		fields=$(inventory_fields all "$category_id" label scope relativePath) || continue
		IFS=$'\x1f' read -r label scope relative_path <<<"$fields"
		# why: inventory_validate allows only the shared and project scopes
		if [[ "$scope" == "shared" ]]; then
			mounted="$shared_mounted"; path="$shared_root/$relative_path"
		else
			mounted="$project_mounted"; path="$project_root/$relative_path"
		fi
		[[ "$mounted" == "true" ]] || path+=' (not mounted)'
		log_debug "${label} (${category_id}) -> ${path}"
	done
	return 0
}

# persistent_data_summary_sign_ins: logs the Sign-ins block, one row per authentication category, and sets SIGN_IN_ACTIONS to a login action per missing sign-in
# Notes: a category whose CLI is missing reads "not installed", and one whose volume is
#   not mounted "not mounted": neither is a missing sign-in, so neither is an action.
#   Nor is a probe that timed out ("no answer in <n>s") or failed otherwise ("could not check").
#   An agent CODING_AGENTS does not select gets no row.
persistent_data_summary_sign_ins() {
	local shared_root project_root shared_mounted project_mounted shared_volume workspace_volume
	local category_id fields label binary probe hint scope mounted width=0
	local -a ids=() sign_in_rows=()
	local row state kind text probe_state detail

	SIGN_IN_ACTIONS=()
	persistent_data_summary_mounts || return 0

	# why: an agent CODING_AGENTS does not list has no sign-in to ask for; devcontainer-data still reaches its data
	mapfile -t ids < <(inventory_selected_ids; inventory_ids categories)
	for category_id in "${ids[@]}"; do
		[[ -n "$category_id" ]] || continue
		fields=$(inventory_fields all "$category_id" label binary identity loginHint scope) || continue
		IFS=$'\x1f' read -r label binary probe hint scope <<<"$fields"
		[[ -n "$probe" ]] || continue
		mounted="$project_mounted"
		[[ "$scope" != "shared" ]] || mounted="$shared_mounted"

		if [[ -n "$binary" ]] && ! command -v "$binary" >/dev/null 2>&1; then
			state='info|not installed'
		elif [[ "$mounted" != "true" ]]; then
			state='info|not mounted'
		else
			IFS='|' read -r probe_state detail <<<"$(persistent_data_summary_identity_state "$probe")"
			case "$probe_state" in
			signed-in) state="success|signed in (${detail})" ;;
			signed-out)
				state='info|not signed in'
				SIGN_IN_ACTIONS+=("${label} not signed in: run \`${hint}\`")
				;;
			# why: a probe that never answered or failed says nothing about the sign-in, so asking the user to log in would be a false alarm
			*) state="info|${detail}" ;;
			esac
		fi
		sign_in_rows+=("${label}|${state}")
		((${#label} > width)) && width=${#label}
	done

	((${#sign_in_rows[@]} == 0)) && return 0
	log_info 'Sign-ins'
	for row in "${sign_in_rows[@]}"; do
		IFS='|' read -r label kind text <<<"$row"
		if [[ "$kind" == 'success' ]]; then
			log_item_success "$(persistent_data_summary_row "$width" "$label" "$text")"
		else
			log_item_info "$(persistent_data_summary_row "$width" "$label" "$text")"
		fi
	done
	return 0
}

export -f persistent_data_summary_list_mounts persistent_data_summary_mounts \
	persistent_data_summary_github_identity persistent_data_summary_identity persistent_data_summary_identity_state \
	persistent_data_summary_row persistent_data_summary_data persistent_data_summary_sign_ins
