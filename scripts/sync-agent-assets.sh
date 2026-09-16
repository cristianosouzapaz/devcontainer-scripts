#!/bin/bash
set -euo pipefail

# Refreshes the machine-wide agent skills, commands and working agreement shared by every
# devcontainer on this host, the agents category of the devcontainer-shared-data volume
# linked at ~/.agents: re-fetches the installer, then runs each installer's --global
# entry, which reads its own *.global.json manifest. Safe to re-run.

# ----- PATH AND STRUCTURE VARIABLES -------------------------------------------

_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

_CAPTURED=""
_SCOPE_COUNT=0

# ----- SHARED UTILITIES LOADING -----------------------------------------------

# why: the loader publishes the script tree anchors this script reads
source "${_SCRIPT_DIR}/setup/lib/loader.sh"

# ----- HELPER FUNCTIONS -------------------------------------------------------

# resolve_assets_ref: prints the git ref for first-party global assets: AGENT_ASSETS_REF, then SCRIPTS_REF, then main
# Notes: AGENT_ASSETS_REF comes first so a project pinned to a feature branch through
#   SCRIPTS_REF pushes that branch's assets into the shared volume only when it opts in.
resolve_assets_ref() {
	echo "${AGENT_ASSETS_REF:-${SCRIPTS_REF:-main}}"
}

# strip_ansi: copies stdin to stdout without ANSI escape sequences
# Notes: lets the consola-styled installer output be parsed and re-rendered in this
#   script's own log style.
strip_ansi() {
	sed -E $'s/\x1b\\[[0-9;]*[a-zA-Z]//g'
}

# emit_captured <captured>: logs each non-empty line of captured output as a detail line
# Notes: the text is third-party, so it is passed through verbatim apart from its ANSI
#   styling, which would fight this script's.
emit_captured() {
	local captured="$1" line

	while IFS= read -r line; do
		[[ -n "${line}" ]] || continue
		log_detail "${line}"
	done < <(printf '%s\n' "${captured}" | strip_ansi)
}

# run_captured <command...>: runs the command and sets _CAPTURED to its combined output
# Returns: the command's exit status.
# Notes: nothing is logged here: a failing step is still inside a spinner, so the caller
#   decides when the output can be shown without cutting across it.
run_captured() {
	local rc=0
	_CAPTURED="$("$@" 2>&1)" || rc=$?
	return "${rc}"
}

# report_warnings <captured>: logs each WARNING: line of captured output as a warning item
# Notes: captured output is otherwise shown only when a step fails, so a step that
#   succeeded while degrading (the bootstrap falling back to its bundled copy) would
#   read as clean.
report_warnings() {
	local captured="$1" line

	while IFS= read -r line; do
		[[ -n "${line}" ]] || continue
		log_item_warning "${line#*WARNING: }"
	done < <(printf '%s\n' "${captured}" | strip_ansi | grep 'WARNING: ' || true)
}

# fail_with_captured <message>: stops the spinner, logs the step's captured output, then exits through log_fatal
# Notes: in that order because the output is legible only once the spinner has released
#   the line.
fail_with_captured() {
	local message="$1"

	spinner_cleanup
	emit_captured "${_CAPTURED}"
	log_fatal "${message}"
}

# report_names <captured>: logs the assets an installer touched as items and sets _SCOPE_COUNT to their number
# Notes: names come from the "… synced: a, b" summary the first-party installers print,
#   else from "<name> added" lines; none at all logs "already up to date".
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

# sync_installer <assets_ref>: re-fetches the installer at the ref, exiting on failure
sync_installer() {
	local assets_ref="$1" files
	start_spinner "Refreshing installer from devcontainer-scripts@${assets_ref}"
	SCRIPTS_REF="${assets_ref}" INSTALLER_VERBOSE=1 run_captured bash "${DEVCONTAINER_INSTALLER_DIR}/install.sh" \
		|| fail_with_captured "Installer fetch failed (devcontainer-scripts@${assets_ref})"
	spinner_cleanup
	files="$(printf '%s\n' "${_CAPTURED}" | sed -nE 's/.*verified ([0-9]+) files.*/\1/p' | tail -n1)"
	log_item_success "Installer refreshed${files:+ (${files} files verified)}"
	report_warnings "${_CAPTURED}"
}

# count_label <n> <word>: prints "<n> <word>", with a trailing s unless n is 1
count_label() {
	local n="$1" word="$2" suffix="s"
	if [[ "${n}" -eq 1 ]]; then suffix=""; fi
	printf '%s %s%s' "${n}" "${word}" "${suffix}"
}

# sync_scope <heading> <entry> <fatal_message> [slow]: runs one installer's --global entry and logs what it touched under the heading, exiting on failure
# Notes: "slow" wraps the run in a spinner and checks the skills CLI refresh.
sync_scope() {
	local heading="$1" entry="$2" fatal="$3" slow="${4:-}"
	log_detail "${heading}"
	if [[ "${slow}" == "slow" ]]; then start_spinner "Updating the shared skills store"; fi
	run_captured node "${DEVCONTAINER_INSTALLER_DIR}/${entry}" --global || fail_with_captured "${fatal}"
	spinner_cleanup
	report_names "${_CAPTURED}"
	if [[ "${slow}" == "slow" ]] && printf '%s\n' "${_CAPTURED}" | grep -q 'skills update -g failed'; then
		log_item_warning "shared-store refresh reported nothing tracked (per-skill add already covered it)"
	fi
}

# sync_file_if_changed <src> <dest>: copies src to dest only when their contents differ, printing "unchanged" or "updated"
# Notes: an already-current destination is left untouched, so it keeps its mtime.
sync_file_if_changed() {
	local src="$1" dest="$2"
	if [[ -f "${dest}" ]] && cmp -s "${src}" "${dest}"; then
		printf 'unchanged\n'
		return 0
	fi
	atomic_write "${dest}" cat -- "${src}"
	printf 'updated\n'
}

# claude_md_with_import <import_line> <claude_md>: prints the import line, a blank line, then the CLAUDE.md content
claude_md_with_import() {
	printf '%s\n\n' "$1"
	cat -- "$2"
}

# sync_claude_adapter <claude_md>: makes CLAUDE.md import the working agreement, keeping its content, and prints "created", "updated" or "unchanged"
# Notes: Claude Code does not read AGENTS.md; it reads CLAUDE.md and expands @path
#   imports at session start.
sync_claude_adapter() {
	local claude_md="$1" import_line="@~/.agents/AGENTS.md"

	if [[ ! -f "${claude_md}" ]]; then
		atomic_write "${claude_md}" printf '%s\n' "${import_line}"
		printf 'created\n'
		return 0
	fi

	if grep -qF -- "${import_line}" "${claude_md}"; then
		printf 'unchanged\n'
		return 0
	fi

	atomic_write "${claude_md}" claude_md_with_import "${import_line}" "${claude_md}"
	printf 'updated\n'
}

# sync_working_agreement: installs the working agreement to ~/.agents/AGENTS.md and each supported agent adapter, and sets _SCOPE_COUNT to the number of destinations changed
# Notes: the source is the installer tree sync_installer just refreshed, not the image
#   copy, so an edit takes effect on the next sync without an image rebuild. An adapter
#   under a managed persistent-data link is written only when its parent directory
#   exists: creating it here would replace the managed symlink with a plain directory.
sync_working_agreement() {
	local canonical="${DEVCONTAINER_INSTALLER_DIR}/agents/templates/global/AGENTS.md" codex_dir="${HOME}/.codex" pi_agent_dir="${HOME}/.pi/agent" result
	_SCOPE_COUNT=0

	log_detail "Personal working agreement"

	result="$(sync_file_if_changed "${canonical}" "${HOME}/.agents/AGENTS.md")"
	# shellcheck disable=SC2088  # literal "~/" is intentional in this user-facing message, not a path to expand
	if [[ "${result}" == "unchanged" ]]; then
		log_item_success "~/.agents/AGENTS.md already up to date"
	else
		log_item_success "~/.agents/AGENTS.md installed"
		_SCOPE_COUNT=$(( _SCOPE_COUNT + 1 ))
	fi

	result="$(sync_claude_adapter "${HOME}/.claude/CLAUDE.md")"
	if [[ "${result}" == "unchanged" ]]; then
		log_item_success "Claude adapter (~/.claude/CLAUDE.md) already up to date"
	else
		log_item_success "Claude adapter (~/.claude/CLAUDE.md) ${result}"
		_SCOPE_COUNT=$(( _SCOPE_COUNT + 1 ))
	fi

	if [[ -e "${codex_dir}" ]]; then
		result="$(sync_file_if_changed "${canonical}" "${codex_dir}/AGENTS.md")"
		if [[ "${result}" == "unchanged" ]]; then
			log_item_success "Codex adapter (~/.codex/AGENTS.md) already up to date"
		else
			log_item_success "Codex adapter (~/.codex/AGENTS.md) installed"
			_SCOPE_COUNT=$(( _SCOPE_COUNT + 1 ))
		fi
	else
		log_item_warning "Codex adapter skipped — ~/.codex not present (Codex not configured in this container)"
	fi

	if [[ -d "${pi_agent_dir}" ]]; then
		result="$(sync_file_if_changed "${canonical}" "${pi_agent_dir}/AGENTS.md")"
		if [[ "${result}" == "unchanged" ]]; then
			log_item_success "Pi adapter (~/.pi/agent/AGENTS.md) already up to date"
		else
			log_item_success "Pi adapter (~/.pi/agent/AGENTS.md) installed"
			_SCOPE_COUNT=$(( _SCOPE_COUNT + 1 ))
		fi
	else
		log_item_warning "Pi adapter skipped — ~/.pi/agent not present (Pi not configured in this container)"
	fi
}

# ----- CORE -------------------------------------------------------------------

# sync_agent_assets: fetches the installer, then runs every --global scope in order and logs a closing summary, exiting on a missing prerequisite or a failing step
sync_agent_assets() {
	local assets_ref started n_cmd n_local n_ext n_agreement
	setup_error_traps
	started="$(date +%s)"

	assets_ref="$(resolve_assets_ref)"

	# why: logged before the prerequisite checks, so their detail lines nest under it
	log_info "Syncing global agent assets · devcontainer-scripts@${assets_ref}"

	check_command node || log_fatal "node is required to sync global agent assets"
	check_command npx || log_warning "npx not found — third-party skill sync will report failures"
	[[ -f "${DEVCONTAINER_INSTALLER_DIR}/install.sh" ]] || log_fatal "Installer not found at ${DEVCONTAINER_INSTALLER_DIR}/install.sh"

	mkdir -p "${HOME}/.agents/skills" "${HOME}/.claude/skills"

	sync_installer "${assets_ref}"
	sync_scope "First-party agent commands" "agents/index.js" "Global agent-command sync failed"
	n_cmd="${_SCOPE_COUNT}"
	sync_scope "First-party local skills" "skills/local/index.js" "Global local-skill sync failed"
	n_local="${_SCOPE_COUNT}"
	sync_scope "Third-party skills" "skills/index.js" "Global third-party skill sync failed" slow
	n_ext="${_SCOPE_COUNT}"
	sync_working_agreement
	n_agreement="${_SCOPE_COUNT}"

	log_success "Global agent assets synced in $(( $(date +%s) - started ))s · $(count_label "${n_cmd}" "agent command"), $(count_label "${n_local}" "local skill"), $(count_label "${n_ext}" "third-party skill"), $(count_label "${n_agreement}" "adapter update")"
}

export -f resolve_assets_ref strip_ansi emit_captured run_captured report_warnings \
	fail_with_captured report_names count_label sync_installer sync_scope \
	sync_file_if_changed sync_claude_adapter sync_working_agreement sync_agent_assets

# ----- ENTRY POINT ------------------------------------------------------------

sync_agent_assets "$@"
