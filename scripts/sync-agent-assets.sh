#!/bin/bash
set -euo pipefail

# Sync Global Agent Assets
#
# Refreshes the machine-wide agent skills/commands store that every devcontainer on
# this host shares (the `agents-data` volume, mounted at ~/.agents):
#
#   1. re-fetch the installer from devcontainer-scripts@<ref>
#   2. first-party instruction/prompt skills  → agents/index.js --global
#   3. first-party local skills               → skills/local/index.js --global
#   4. curated third-party skills             → skills/index.js --global
#
# Each installer reads its own `*.global.json` manifest, so this script passes no
# asset names. Idempotent: safe to re-run whenever an upstream template changes.
#
# Ref precedence for step 1: AGENT_ASSETS_REF -> SCRIPTS_REF -> main. A project
# pinned to a feature branch via SCRIPTS_REF therefore does not push that branch's
# first-party assets into the shared volume unless AGENT_ASSETS_REF opts in.

# ----- PATH AND STRUCTURE VARIABLES -----------------------------------------

# Test seams — not readonly so tests can point these at fixtures.
_SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"
[[ "${_SCRIPT_DIR}" == "." ]] && _SCRIPT_DIR="$(pwd)"
_INSTALLER_DIR="${_SCRIPT_DIR}/installer"

# Set by run_captured / report_names for the caller to read back.
_CAPTURED=""
_SCOPE_COUNT=0

# ----- SHARED UTILITIES LOADING -------------------------------------------------

source "${_SCRIPT_DIR}/setup/shared/loader.sh"

# ----- HELPER FUNCTIONS -----------------------------------------------------

# resolve_assets_ref: Print the git ref used to fetch first-party global assets.
# Precedence: AGENT_ASSETS_REF, then SCRIPTS_REF, then "main".
# Returns: 0, ref on stdout.
resolve_assets_ref() {
	echo "${AGENT_ASSETS_REF:-${SCRIPTS_REF:-main}}"
}

# strip_ansi: Copy stdin to stdout with ANSI escape sequences removed, so the
# `consola`-styled installer output can be parsed and re-rendered in this
# script's own log style.
strip_ansi() {
	sed -E $'s/\x1b\\[[0-9;]*[a-zA-Z]//g'
}

# run_captured: Run a command with its combined output collected in _CAPTURED.
# On failure, echoes that output to stderr so a fatal caller shows the real error.
# Args: $@ - command and arguments.
# Returns: the command's exit code.
run_captured() {
	local rc=0
	_CAPTURED="$("$@" 2>&1)" || rc=$?
	[[ "${rc}" -eq 0 ]] || printf '%s\n' "${_CAPTURED}" >&2
	return "${rc}"
}

# report_names: Render the assets an installer touched as an indented list and
# set _SCOPE_COUNT to how many there were. Names come from the `… synced: a, b`
# summary the first-party installers print, or from `<name> added` lines
# otherwise; an empty result reports "already up to date".
# Args: $1 - captured installer output.
report_names() {
	local captured="$1" clean summary name
	local -a names=()

	clean="$(printf '%s\n' "${captured}" | strip_ansi)"
	summary="$(printf '%s\n' "${clean}" | sed -nE 's/.*synced: (.+)$/\1/p' | tail -n1)"

	if [[ -n "${summary}" ]]; then
		IFS=', ' read -r -a names <<< "${summary}"
	else
		mapfile -t names < <(printf '%s\n' "${clean}" | sed -nE 's/^[^[:alnum:]]*([[:alnum:]_-]+) added$/\1/p')
	fi

	_SCOPE_COUNT="${#names[@]}"
	if [[ "${_SCOPE_COUNT}" -eq 0 ]]; then
		log_item_success "already up to date"
		return 0
	fi
	for name in "${names[@]}"; do
		log_item_success "${name}"
	done
}

# sync_installer: Re-fetch the installer for the given ref. Fatal on failure.
# Args: $1 - assets ref.
sync_installer() {
	local assets_ref="$1" files
	start_spinner "Refreshing installer from devcontainer-scripts@${assets_ref}"
	SCRIPTS_REF="${assets_ref}" INSTALLER_VERBOSE=1 run_captured bash "${_INSTALLER_DIR}/install.sh" || {
		spinner_cleanup
		log_fatal "Installer fetch failed (devcontainer-scripts@${assets_ref})"
	}
	spinner_cleanup
	files="$(printf '%s\n' "${_CAPTURED}" | sed -nE 's/.*verified ([0-9]+) files.*/\1/p' | tail -n1)"
	log_item_success "Installer refreshed${files:+ (${files} files verified)}"
}

# count_label: "<n> <word>", pluralised with a trailing "s" unless n is 1.
count_label() {
	local n="$1" word="$2" suffix="s"
	if [[ "${n}" -eq 1 ]]; then suffix=""; fi
	printf '%s %s%s' "${n}" "${word}" "${suffix}"
}

# sync_scope: Run one installer's --global entry and list what it touched under
# the heading. Fatal (with the captured log) on failure.
# Args: $1 heading, $2 index.js path, $3 fatal message,
#       $4 "slow" to wrap the run in a spinner and check the skills-CLI refresh.
sync_scope() {
	local heading="$1" entry="$2" fatal="$3" slow="${4:-}"
	log_detail "${heading}"
	if [[ "${slow}" == "slow" ]]; then start_spinner "Updating the shared skills store"; fi
	run_captured node "${_INSTALLER_DIR}/${entry}" --global || { spinner_cleanup; log_fatal "${fatal}"; }
	spinner_cleanup
	report_names "${_CAPTURED}"
	if [[ "${slow}" == "slow" ]] && printf '%s\n' "${_CAPTURED}" | grep -q 'skills update -g failed'; then
		log_item_warning "shared-store refresh reported nothing tracked (per-skill add already covered it)"
	fi
}

# ----- CORE -----------------------------------------------------------------

# sync_agent_assets: Fetch the installer, then run every --global scope in order,
# rendering the run as one tree with a closing summary. Fatal on a missing
# prerequisite or any failing step.
sync_agent_assets() {
	local assets_ref started n_cmd n_local n_ext
	setup_error_traps
	started="$(date +%s)"

	check_command node || log_fatal "node is required to sync global agent assets"
	check_command npx || log_warning "npx not found — third-party skill sync will report failures"
	[[ -f "${_INSTALLER_DIR}/install.sh" ]] || log_fatal "Installer not found at ${_INSTALLER_DIR}/install.sh"

	assets_ref="$(resolve_assets_ref)"
	mkdir -p "${HOME}/.agents/skills" "${HOME}/.claude/skills"

	log_info "Syncing global agent assets · devcontainer-scripts@${assets_ref}"

	sync_installer "${assets_ref}"
	sync_scope "First-party agent commands" "agents/index.js" "Global agent-command sync failed"
	n_cmd="${_SCOPE_COUNT}"
	sync_scope "First-party local skills" "skills/local/index.js" "Global local-skill sync failed"
	n_local="${_SCOPE_COUNT}"
	sync_scope "Third-party skills" "skills/index.js" "Global third-party skill sync failed" slow
	n_ext="${_SCOPE_COUNT}"

	log_success "Global agent assets synced in $(( $(date +%s) - started ))s · $(count_label "${n_cmd}" "agent command"), $(count_label "${n_local}" "local skill"), $(count_label "${n_ext}" "third-party skill")"
}

export -f resolve_assets_ref strip_ansi run_captured report_names count_label \
	sync_installer sync_scope sync_agent_assets

# ----- ENTRY POINT --------------------------------------------------------------

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
	sync_agent_assets "$@"
fi
