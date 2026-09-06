#!/bin/bash
set -euo pipefail

# Sync Global Agent Assets
#
# Refreshes the machine-wide agent skills/commands store that every devcontainer on
# this host shares — the `agents` category of the shared `devcontainer-shared-data`
# volume, surfaced at ~/.agents via a managed symlink:
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

_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Set by run_captured / report_names for the caller to read back.
_CAPTURED=""
_SCOPE_COUNT=0

# ----- SHARED UTILITIES LOADING -------------------------------------------------

# The loader publishes the absolute script tree anchors this script reads below.
source "${_SCRIPT_DIR}/setup/lib/loader.sh"

# Test seam — not readonly so tests can point it at a fixture installer tree.
_INSTALLER_DIR="${DEVCONTAINER_INSTALLER_DIR}"

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

# emit_captured: Render captured output as detail lines. The text is third-party, so it is
# passed through verbatim apart from its own ANSI styling, which would fight this script's.
# Args: $1 - captured output.
emit_captured() {
	local captured="$1" line

	while IFS= read -r line; do
		[[ -n "${line}" ]] || continue
		log_detail "${line}"
	done < <(printf '%s\n' "${captured}" | strip_ansi)
}

# run_captured: Run a command with its combined output collected in _CAPTURED. Nothing is
# rendered here: a failing step is still inside a spinner, so the caller decides when the
# output can be shown without cutting across it.
# Args: $@ - command and arguments.
# Returns: the command's exit code.
run_captured() {
	local rc=0
	_CAPTURED="$("$@" 2>&1)" || rc=$?
	return "${rc}"
}

# report_warnings: Surface a step's warning lines as warning items. Captured output is
# otherwise shown only when a step fails, so a step that succeeded while degrading — the
# bootstrap falling back to its bundled copy — would read as clean indefinitely.
# Args: $1 - captured output.
report_warnings() {
	local captured="$1" line

	while IFS= read -r line; do
		[[ -n "${line}" ]] || continue
		log_item_warning "${line#*WARNING: }"
	done < <(printf '%s\n' "${captured}" | strip_ansi | grep 'WARNING: ' || true)
}

# fail_with_captured: End the run on a failed step — stop the spinner, show the step's own
# output, then fail. In that order: the output is only legible once the spinner has
# released the line.
# Args: $1 - fatal message.
# Returns: does not return; exits the process with status 1.
fail_with_captured() {
	local message="$1"

	spinner_cleanup
	emit_captured "${_CAPTURED}"
	log_fatal "${message}"
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
	SCRIPTS_REF="${assets_ref}" INSTALLER_VERBOSE=1 run_captured bash "${_INSTALLER_DIR}/install.sh" \
		|| fail_with_captured "Installer fetch failed (devcontainer-scripts@${assets_ref})"
	spinner_cleanup
	files="$(printf '%s\n' "${_CAPTURED}" | sed -nE 's/.*verified ([0-9]+) files.*/\1/p' | tail -n1)"
	log_item_success "Installer refreshed${files:+ (${files} files verified)}"
	report_warnings "${_CAPTURED}"
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
	run_captured node "${_INSTALLER_DIR}/${entry}" --global || fail_with_captured "${fatal}"
	spinner_cleanup
	report_names "${_CAPTURED}"
	if [[ "${slow}" == "slow" ]] && printf '%s\n' "${_CAPTURED}" | grep -q 'skills update -g failed'; then
		log_item_warning "shared-store refresh reported nothing tracked (per-skill add already covered it)"
	fi
}

# sync_file_if_changed: Copy src to dest only when their contents differ, so an
# already-current destination is left untouched and keeps its mtime.
# Args: $1 - source path, $2 - destination path.
# Returns: 0; prints "unchanged" or "updated" to stdout.
sync_file_if_changed() {
	local src="$1" dest="$2"
	if [[ -f "${dest}" ]] && cmp -s "${src}" "${dest}"; then
		printf 'unchanged\n'
		return 0
	fi
	cp "${src}" "${dest}"
	printf 'updated\n'
}

# sync_claude_adapter: Ensure a CLAUDE.md file's first line imports the
# canonical working agreement, without disturbing any content the user already
# keeps there. Claude Code does not read AGENTS.md itself — it reads CLAUDE.md
# and expands `@path` imports at session start.
# Args: $1 - path to CLAUDE.md.
# Returns: 0; prints "created", "updated", or "unchanged" to stdout.
sync_claude_adapter() {
	local claude_md="$1" import_line="@~/.agents/AGENTS.md" tmp

	if [[ ! -f "${claude_md}" ]]; then
		printf '%s\n' "${import_line}" > "${claude_md}"
		printf 'created\n'
		return 0
	fi

	if grep -qF -- "${import_line}" "${claude_md}"; then
		printf 'unchanged\n'
		return 0
	fi

	tmp="$(mktemp -p "$(dirname -- "${claude_md}")")"
	{
		printf '%s\n\n' "${import_line}"
		cat -- "${claude_md}"
	} > "${tmp}"
	mv "${tmp}" "${claude_md}"
	printf 'updated\n'
}

# sync_working_agreement: Install the canonical machine-wide working agreement
# to ~/.agents/AGENTS.md, then update the Claude Code and Codex CLI adapters so
# both tools load it at session start. The source is the installer tree that
# sync_installer just refreshed, not the copy baked into the image, so editing
# the agreement takes effect on the next sync without an image rebuild.
# Idempotent: an already-current
# destination is left untouched and reported as up to date. ~/.codex is only
# ever written to if it already exists — creating it here as a plain directory
# would break persistent-data's managed symlink into the shared volume.
# Returns: 0; sets _SCOPE_COUNT to how many of the three destinations changed.
sync_working_agreement() {
	local canonical="${_INSTALLER_DIR}/agents/templates/global/AGENTS.md" codex_dir="${HOME}/.codex" result
	_SCOPE_COUNT=0

	log_detail "Personal working agreement"

	result="$(sync_file_if_changed "${canonical}" "${HOME}/.agents/AGENTS.md")"
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
}

# ----- CORE -----------------------------------------------------------------

# sync_agent_assets: Fetch the installer, then run every --global scope in order,
# rendering the run as one tree with a closing summary. Fatal on a missing
# prerequisite or any failing step.
sync_agent_assets() {
	local assets_ref started n_cmd n_local n_ext n_agreement
	setup_error_traps
	started="$(date +%s)"

	assets_ref="$(resolve_assets_ref)"

	# Before the prerequisite checks, so their detail lines have a primary line to nest under.
	log_info "Syncing global agent assets · devcontainer-scripts@${assets_ref}"

	check_command node || log_fatal "node is required to sync global agent assets"
	check_command npx || log_warning "npx not found — third-party skill sync will report failures"
	[[ -f "${_INSTALLER_DIR}/install.sh" ]] || log_fatal "Installer not found at ${_INSTALLER_DIR}/install.sh"

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

# ----- ENTRY POINT --------------------------------------------------------------

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
	sync_agent_assets "$@"
fi
