#!/bin/bash
set -euo pipefail

# Refreshes the machine-wide agent skills, commands and working agreement shared by every
# devcontainer on this host, the agents category of the devcontainer-shared-data volume
# linked at ~/.agents: re-fetches the installer, then runs each installer's --global
# entry, which installs the items marked global. Safe to re-run.

# ----- PATH AND STRUCTURE VARIABLES -------------------------------------------

_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# why: its own file, never the setup log, which holds exactly one setup run; an empty _LOG_FILE (as the test suite sets it) still means stderr only
_LOG_FILE="${_LOG_FILE-/tmp/agent-assets.log}"

_CAPTURED=""
_SCOPE_COUNT=0
_SCOPE_OUTCOME='ok'

# ----- SHARED UTILITIES LOADING -----------------------------------------------

source "${_SCRIPT_DIR}/setup/lib/loader.sh"

# ----- HELPER FUNCTIONS -------------------------------------------------------

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

# report_names <captured> [quiet]: logs the assets an installer touched as items and sets _SCOPE_COUNT to their number
# Returns: 0 when the installer reported an outcome, 1 when it reported none.
# Notes: names come from the "… synced: a, b" summary the first-party installers print,
#   else from "<name> added" lines; a parenthesized summary is an outcome naming nothing.
#   Only consola success lines count — "✔ text", or "[success] text" under CI or test
#   environments: a failed add's error text can itself end in " added". quiet only counts,
#   for a caller that already shows the captured lines.
report_names() {
	local captured="$1" quiet="${2:-}" clean summary name
	local -a names=()

	clean="$(printf '%s\n' "${captured}" | strip_ansi | sed -nE 's/^(✔ |\[success\] )//p')"
	summary="$(printf '%s\n' "${clean}" | sed -nE 's/.*synced: (.+)$/\1/p' | tail -n1)"

	if [[ "${summary}" == '('* ]]; then
		_SCOPE_COUNT=0
		if [[ "${quiet}" != quiet ]]; then log_item_success "${summary//[()]/}"; fi
		return 0
	elif [[ -n "${summary}" ]]; then
		IFS=', ' read -r -a names <<< "${summary}"
	else
		mapfile -t names < <(printf '%s\n' "${clean}" | sed -nE 's/^(.+) added$/\1/p')
	fi

	_SCOPE_COUNT="${#names[@]}"
	if [[ "${quiet}" != quiet ]]; then
		for name in "${names[@]}"; do
			log_item_success "${name}"
		done
	fi
	[[ "${_SCOPE_COUNT}" -gt 0 ]]
}

# sync_installer <assets_ref> <scripts_repo>: re-fetches the installer at the ref, exiting on failure
sync_installer() {
	local assets_ref="$1" scripts_repo="$2" files
	start_spinner "Refreshing installer from ${scripts_repo}@${assets_ref}"
	SCRIPTS_REF="${assets_ref}" SCRIPTS_REPO="${scripts_repo}" INSTALLER_VERBOSE=1 run_captured bash "${DEVCONTAINER_INSTALLER_ROOT}/install.sh" \
		|| fail_with_captured "Installer fetch failed (${scripts_repo}@${assets_ref})"
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

# sync_scope <heading> <entry> <fatal_message> [slow] [tolerate]: runs one installer scope and exposes its stable outcome
# Notes: third-party failures are nonfatal because existing installed assets remain usable;
#   their partial outcome is persisted for diagnostics instead of being mistaken for success.
#   A scope that exits 0 but reports no outcome failed too: a working installer always
#   reports what it synced, so silence means its entry never ran. consola's level is pinned
#   so a test or debug environment cannot silence that report.
sync_scope() {
	local heading="$1" entry="$2" fatal="$3" slow="${4:-}" tolerance="${5:-}" rc=0
	_SCOPE_OUTCOME='ok'
	log_detail "${heading}"
	if [[ "${slow}" == "slow" ]]; then start_spinner "Updating the shared skills store"; fi
	CONSOLA_LEVEL=3 run_captured node "${DEVCONTAINER_INSTALLER_DIR}/${entry}" --global || rc=$?
	spinner_cleanup
	_SCOPE_COUNT=0
	if [[ "$rc" -eq 0 ]]; then report_names "${_CAPTURED}" || rc=1; fi
	if [[ "$rc" -ne 0 ]]; then
		if [[ "$tolerance" != 'tolerate' ]]; then
			fail_with_captured "${fatal}"
		fi
		_SCOPE_OUTCOME='partial'
		# why: the assets that did sync still count toward the summary, and emit_captured already shows their lines
		report_names "${_CAPTURED}" quiet || true
		emit_captured "${_CAPTURED}"
		log_item_warning "${fatal}; retaining existing third-party assets"
		return 0
	fi
	if [[ "${slow}" == "slow" ]] && printf '%s\n' "${_CAPTURED}" | grep -q 'skills update -g failed'; then
		log_item_warning "shared-store refresh reported nothing tracked (per-skill add already covered it)"
		_SCOPE_OUTCOME='partial'
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

# file_with_import <import_line> <file>: prints the import line, a blank line, then the file's content
# Stdout: the import line, a blank line, then the file's content
file_with_import() {
	printf '%s\n\n' "$1"
	cat -- "$2"
}

# sync_import_adapter <file>: makes an agent's instructions file import the working agreement, keeping its content, and prints "created", "updated" or "unchanged"
# Stdout: created, updated or unchanged, one line
# Notes: for an agent that does not read AGENTS.md but expands @path imports in its own
#   instructions file at session start.
sync_import_adapter() {
	local file="$1" import_line="@~/.agents/AGENTS.md"

	if [[ ! -f "${file}" ]]; then
		atomic_write "${file}" printf '%s\n' "${import_line}"
		printf 'created\n'
		return 0
	fi

	if grep -qF -- "${import_line}" "${file}"; then
		printf 'unchanged\n'
		return 0
	fi

	atomic_write "${file}" file_with_import "${import_line}" "${file}"
	printf 'updated\n'
}

# sync_working_agreement: installs the working agreement to ~/.agents/AGENTS.md and each selected agent pack's instructions adapter, and sets _SCOPE_COUNT to the number of destinations changed
# Notes: the source is the installer tree sync_installer just refreshed, not the image
#   copy, so an edit takes effect on the next sync without an image rebuild. An adapter
#   under a managed persistent-data link is written only when its parent directory
#   exists: creating it here would replace the managed symlink with a plain directory.
sync_working_agreement() {
	local canonical="${DEVCONTAINER_INSTALLER_DIR}/agents/templates/global/AGENTS.md" result adapters label mode path
	_SCOPE_COUNT=0

	log_detail "Personal working agreement"

	result="$(sync_file_if_changed "${canonical}" "${HOME}/.agents/AGENTS.md")"
	if [[ "${result}" == "unchanged" ]]; then
		log_item_success "Working agreement (~/.agents/AGENTS.md) already up to date"
	else
		log_item_success "Working agreement (~/.agents/AGENTS.md) installed"
		_SCOPE_COUNT=$(( _SCOPE_COUNT + 1 ))
	fi

	adapters=$(inventory_read_selected -r '.agents[] | select((.instructions.mode // "none") != "none")
		| [.label, .instructions.mode, .instructions.path] | join("\u001f")') || log_fatal 'Could not read the agent packs'
	while IFS=$'\x1f' read -r label mode path; do
		[[ -n "${label}" ]] || continue
		if [[ ! -d "$(dirname "${HOME}/${path}")" ]]; then
			log_item_warning "${label} adapter skipped — ~/$(dirname "${path}") not present (${label} not configured in this container)"
			continue
		fi
		if [[ "${mode}" == import ]]; then
			result="$(sync_import_adapter "${HOME}/${path}")"
		else
			result="$(sync_file_if_changed "${canonical}" "${HOME}/${path}")"
		fi
		if [[ "${result}" == "unchanged" ]]; then
			log_item_success "${label} adapter (~/${path}) already up to date"
		else
			[[ "${mode}" == import ]] || result='installed'
			log_item_success "${label} adapter (~/${path}) ${result}"
			_SCOPE_COUNT=$(( _SCOPE_COUNT + 1 ))
		fi
	done <<<"${adapters}"
}

# mod_differs <src> <dest>: succeeds when the mod folders differ, ignoring the .claude-plugin/types path Claude Code writes on every load
# Notes: filtered on diff's report rather than with -x, which matches a basename anywhere
#   and would also hide the mod's tracked top-level types/.
mod_differs() {
	local report
	report="$(diff -rq -- "$1" "$2" 2>&1 | grep -vF -e '.claude-plugin: types' -e '.claude-plugin/types' || true)"
	[[ -n "${report}" ]]
}

# symlinked_skills_dirs: prints the label and home-relative skills directory of each selected agent pack that exposes skills through symlinks
# Stdout: one "<label>\x1f<skills path>" line per such pack
symlinked_skills_dirs() {
	inventory_read_selected -r '.agents[] | select(.skills.mode == "symlink") | [.label, .skills.path] | join("\u001f")'
}

# sync_working_agreement_mod <skills_dirs>: installs the working-agreement mod to ~/.agents/mods/working-agreement, links it from each symlink-exposed skills directory, and sets _SCOPE_COUNT to the number of changes
# Notes: a changed copy is staged beside the destination and swapped in by rename, so a
#   partial copy is never visible there. A missing source is fatal, like a missing
#   installer. An entry at the link path that is not the expected link is warned about and
#   left untouched. Claude Code's settings are never read or written: the mod's
#   enable state lives there.
sync_working_agreement_mod() {
	local src="${DEVCONTAINER_INSTALLER_DIR}/mods/templates/working-agreement" dest="${HOME}/.agents/mods/working-agreement"
	local links="$1" link label skills_path stage old version
	_SCOPE_COUNT=0

	log_detail "Working-agreement mod"
	[[ -d "${src}" ]] || log_fatal "Working-agreement mod not found at ${src}"
	version="$(jq -er '.version' "${src}/.claude-plugin/plugin.json" 2>/dev/null)" \
		|| log_fatal "Working-agreement mod manifest missing or invalid: ${src}/.claude-plugin/plugin.json"

	if [[ -d "${dest}" ]] && ! mod_differs "${src}" "${dest}"; then
		log_item_success "Working-agreement mod (~/.agents/mods/working-agreement) already up to date (v${version})"
	else
		mkdir -p "${dest%/*}"
		rm -rf -- "${dest}".new.* "${dest}".old.*
		stage="$(mktemp -d "${dest}.new.XXXXXX")"
		old="${dest}.old.${stage##*.}"
		cp -a -- "${src}/." "${stage}/" || { rm -rf -- "${stage}"; log_fatal "Could not copy the working-agreement mod to ${stage}"; }
		if [[ -d "${dest}" ]]; then mv -- "${dest}" "${old}"; fi
		mv -- "${stage}" "${dest}"
		rm -rf -- "${old}"
		log_item_success "Working-agreement mod (~/.agents/mods/working-agreement) installed (v${version})"
		_SCOPE_COUNT=$(( _SCOPE_COUNT + 1 ))
	fi

	while IFS=$'\x1f' read -r label skills_path; do
		[[ -n "${label}" ]] || continue
		link="${HOME}/${skills_path}/working-agreement"
		if [[ -L "${link}" && "$(readlink -- "${link}")" == "${dest}" ]]; then
			log_item_success "${label} mod link (~/${skills_path}/working-agreement) already up to date"
		elif [[ -e "${link}" || -L "${link}" ]]; then
			log_item_warning "${label} mod link skipped — ~/${skills_path}/working-agreement already exists and is not the expected link"
		else
			ln -s -- "${dest}" "${link}"
			log_item_success "${label} mod link (~/${skills_path}/working-agreement) created"
			_SCOPE_COUNT=$(( _SCOPE_COUNT + 1 ))
		fi
	done <<<"${links}"
}

# ----- CORE -------------------------------------------------------------------

# sync_agent_assets_locked: mutates global assets while the shared-data lock serializes all containers on the host
sync_agent_assets_locked() {
	local assets_ref scripts_repo source_sha started n_cmd n_local n_ext n_agreement state='complete' skills_dirs label skills_path
	setup_error_traps
	log_file_start
	started="$(date +%s)"

	# why: Prerequisites are local checks: fail before resolving a ref over the network.
	check_command node || log_fatal "node is required to sync global agent assets"
	check_command npx || log_warning "npx not found — third-party skill sync will report failures"
	[[ -f "${DEVCONTAINER_INSTALLER_ROOT}/install.sh" ]] || log_fatal "Installer bootstrap not found at ${DEVCONTAINER_INSTALLER_ROOT}/install.sh"

	scripts_repo="$(resolve_assets_repo)" || log_fatal "Invalid SCRIPTS_REPO: ${SCRIPTS_REPO:-}"
	resolve_assets_source || log_fatal "Could not resolve immutable source SHA for ${scripts_repo}@${ASSETS_REF}"
	assets_ref="${ASSETS_REF}"
	source_sha="${ASSETS_SHA}"
	log_info "Syncing global agent assets · ${scripts_repo}@${source_sha}"

	mkdir -p "${HOME}/.agents/skills"
	skills_dirs=$(symlinked_skills_dirs) || log_fatal 'Could not read the agent packs'
	while IFS=$'\x1f' read -r label skills_path; do
		if [[ -n "${label}" ]]; then mkdir -p "${HOME}/${skills_path}"; fi
	done <<<"${skills_dirs}"

	sync_installer "${source_sha}" "${scripts_repo}"
	[[ -d "${DEVCONTAINER_INSTALLER_DIR}" ]] || log_fatal "Active installer release not found at ${DEVCONTAINER_INSTALLER_DIR}"
	sync_scope "First-party agent commands" "agents/index.js" "Global agent-command sync failed"
	n_cmd="${_SCOPE_COUNT}"
	sync_scope "First-party local skills" "skills/local/index.js" "Global local-skill sync failed"
	n_local="${_SCOPE_COUNT}"
	sync_scope "Third-party skills" "skills/index.js" "Global third-party skill sync failed" slow tolerate
	n_ext="${_SCOPE_COUNT}"
	[[ "$_SCOPE_OUTCOME" == ok ]] || state='partial'
	sync_working_agreement
	n_agreement="${_SCOPE_COUNT}"
	# why: the mod loads only through a symlink-exposed skills directory, which no unlisted agent provides
	if [[ -n "${skills_dirs}" ]]; then
		sync_working_agreement_mod "${skills_dirs}"
		n_agreement=$(( n_agreement + _SCOPE_COUNT ))
	fi
	global_agent_assets_metadata_write "$assets_ref" "$source_sha" "$state" || log_fatal 'Could not record global agent asset sync state'

	log_success "Global agent assets synced in $(( $(date +%s) - started ))s · $(count_label "${n_cmd}" "agent command"), $(count_label "${n_local}" "local skill"), $(count_label "${n_ext}" "third-party skill"), $(count_label "${n_agreement}" "adapter update")"
}

# sync_agent_assets: public lock wrapper for all shared global asset mutation
sync_agent_assets() {
	with_shared_data_lock sync_agent_assets_locked "$@"
}

export -f strip_ansi emit_captured run_captured report_warnings \
	fail_with_captured report_names count_label sync_installer sync_scope \
	sync_file_if_changed sync_import_adapter sync_working_agreement symlinked_skills_dirs mod_differs \
	sync_working_agreement_mod sync_agent_assets_locked sync_agent_assets

# ----- ENTRY POINT ------------------------------------------------------------

sync_agent_assets "$@"
