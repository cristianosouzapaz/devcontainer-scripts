#!/bin/bash
set -euo pipefail

# Bootstraps immutable installer releases. The root copy is deliberately never replaced:
# it is the recoverable image bootstrap while current selects a complete release.

# ----- CONFIGURATION ----------------------------------------------------------

# why: every other file is discovered from their import graph, so this is the only hand-kept list
readonly _SEED_ENTRYPOINTS=(
	"agents/index.js"
	"configs/index.js"
	"skills/index.js"
	"skills/local/index.js"
	"agent-md/index.js"
	"data-ui.js"
)

# why: required but unreachable from the import graph; sync-agent-assets.sh copies AGENTS.md out of this tree
readonly _EXTRA_FILES=("package.json" "pnpm-lock.yaml" "agents/templates/global/AGENTS.md")
readonly _RUNTIME_DEPS=("@inquirer/core" "@inquirer/prompts" "chalk" "consola")
readonly _CURL_OPTS=(
	--fail --location --show-error --silent
	--retry 5 --retry-delay 2 --retry-connrefused --retry-all-errors
	--connect-timeout 15 --max-time 120
)
readonly _MAX_GRAPH_ITERATIONS=10
readonly _STALE_CANDIDATE_MINUTES=60
readonly _DEFAULT_SCRIPTS_REPO="cristianosouzapaz/devcontainer-scripts"

# ----- LOGGING ----------------------------------------------------------------

# log message: writes a verbose installer message
log() {
	[[ -n "${INSTALLER_VERBOSE:-}" ]] || return 0
	printf '[install.sh] %s\n' "$*" >&2
}

# warn message: writes an installer warning
warn() {
	printf '[install.sh] WARNING: %s\n' "$*" >&2
}

# fail message: writes an installer error and exits
fail() {
	printf '[install.sh] ERROR: %s\n' "$*" >&2
	exit 1
}

# ----- CLEANUP ----------------------------------------------------------------

_STAGE_DIR=""
_BOOTSTRAP_DIR=""
_CURRENT_PROMOTION_PATH=""
_CURRENT_PROMOTION_ID=""
_CURRENT_PROMOTION_OWNED=""
_PREPARING_MARKER=""

# cleanup none: removes only process-owned temporary artifacts
cleanup() {
	if [[ -n "${_STAGE_DIR}" && -d "${_STAGE_DIR}" ]]; then rm -rf -- "${_STAGE_DIR}" || :; fi
	if [[ -n "${_BOOTSTRAP_DIR}" && -d "${_BOOTSTRAP_DIR}" ]]; then rm -rf -- "${_BOOTSTRAP_DIR}" || :; fi
	if [[ -n "${_CURRENT_PROMOTION_OWNED}" && -L "${_CURRENT_PROMOTION_PATH}" \
		&& "$(stat -c '%d:%i' -- "${_CURRENT_PROMOTION_PATH}")" == "${_CURRENT_PROMOTION_ID}" ]]; then
		rm -f -- "${_CURRENT_PROMOTION_PATH}" || :
	fi
	return 0
}

# stop_on_sigint none: cleans up and exits for SIGINT
stop_on_sigint() { cleanup; exit 130; }
# stop_on_sigterm none: cleans up and exits for SIGTERM
stop_on_sigterm() { cleanup; exit 143; }

# ----- DOWNLOAD ---------------------------------------------------------------

# download_file base_url stage_dir rel: fetches one nonempty staged file
download_file() {
	local base_url="$1" stage_dir="$2" rel="$3"
	local url="${base_url}/${rel}" dest="${stage_dir}/${rel}" tmp err rc=0

	mkdir -p "$(dirname "${dest}")"
	tmp="$(mktemp "${dest}.XXXXXX")"
	err="$(curl "${_CURL_OPTS[@]}" "${url}" -o "${tmp}" 2>&1)" || rc=$?
	if [[ "${rc}" -eq 0 && -s "${tmp}" ]]; then
		mv -f -- "${tmp}" "${dest}"
		return 0
	fi
	rm -f -- "${tmp}"
	fail "download failed: ${url}${err:+ — ${err##*$'\n'}}"
}

# ----- DEPENDENCY GRAPH -------------------------------------------------------

# required_paths stage_dir: prints referenced staged paths
required_paths() {
	local stage_dir="$1"
	# shellcheck disable=SC2016  # the single-quoted body is a JS program, not a shell string
	node -e '
		const { readdirSync, readFileSync, existsSync } = require("node:fs");
		const { join, dirname, relative, resolve } = require("node:path");
		const [root] = process.argv.slice(1);
		const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
			e.isDirectory() ? walk(join(dir, e.name)) : join(dir, e.name));
		const REFERENCE_PATTERNS = [
			/(?:^|\n)\s*(?:import|export)\b[^\n]*?\bfrom\s*["\x27]([^"\x27]+)["\x27]/g,
			/(?:^|\n)\s*import\s*["\x27]([^"\x27]+)["\x27]/g,
			/new\s+URL\s*\(\s*["\x27](\.[^"\x27]+)["\x27]/g,
		];
		const parseJson = (file) => {
			try { return JSON.parse(readFileSync(file, "utf8")); }
			catch (e) { console.error(`invalid JSON in ${relative(root, file)}: ${e.message}`); process.exit(1); }
		};
		const resolveImport = (file, spec) => {
			const base = resolve(dirname(file), spec);
			if (/\.[a-z0-9]+$/i.test(spec)) return base;
			return existsSync(`${base}.js`) ? `${base}.js` : join(base, "index.js");
		};
		const referencesOf = (file) => {
			if (file.endsWith(".js")) {
				const src = readFileSync(file, "utf8");
				return REFERENCE_PATTERNS.flatMap((re) => [...src.matchAll(re)].map((m) => m[1]))
					.filter((spec) => spec.startsWith(".") && !spec.endsWith("/"))
					.map((spec) => resolveImport(file, spec));
			}
			if (file.endsWith(".json")) {
				const data = parseJson(file);
				return (Array.isArray(data) ? data : [data]).flatMap((entry) => entry && typeof entry.templateFile === "string"
					? [entry.templateFile, ...(Array.isArray(entry.resources) ? entry.resources : [])] : [])
					.map((templateFile) => join(dirname(file), "templates", templateFile));
			}
			return [];
		};
		const files = existsSync(root) ? walk(root) : [];
		const rels = new Set(files.flatMap(referencesOf).map((abs) => relative(root, abs).split("\\").join("/")));
		for (const rel of [...rels].sort()) console.log(rel);
	' "${stage_dir}"
}

# fetch_graph base_url stage_dir: downloads the complete installer dependency graph
fetch_graph() {
	local base_url="$1" stage_dir="$2" rel raw pending

	for rel in "${_SEED_ENTRYPOINTS[@]}" "${_EXTRA_FILES[@]}"; do
		download_file "${base_url}" "${stage_dir}" "${rel}"
	done
	for _ in $(seq "${_MAX_GRAPH_ITERATIONS}"); do
		raw="$(required_paths "${stage_dir}")" || fail "installer dependency analysis failed"
		[[ -n "${raw}" ]] || fail "installer dependency analysis produced no results"
		pending=""
		while IFS= read -r rel; do
			[[ -n "${rel}" && ! -e "${stage_dir}/${rel}" ]] || continue
			download_file "${base_url}" "${stage_dir}" "${rel}"
			pending=1
		done <<< "${raw}"
		[[ -z "${pending}" ]] && return 0
	done
	fail "installer dependency graph did not converge after ${_MAX_GRAPH_ITERATIONS} passes"
}

# ----- VERIFICATION -----------------------------------------------------------

# stage_valid stage_dir: checks staged source syntax and metadata
stage_valid() {
	local stage_dir="$1" file

	node -e 'process.exit(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).type === "module" ? 0 : 1)' \
		"${stage_dir}/package.json" >/dev/null 2>&1 || return 1
	while IFS= read -r -d '' file; do
		node --check "${file}" >/dev/null 2>&1 || return 1
	done < <(find "${stage_dir}" -type f -name '*.js' -print0)
	while IFS= read -r -d '' file; do
		node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "${file}" >/dev/null 2>&1 || return 1
	done < <(find "${stage_dir}" -path "${stage_dir}/node_modules" -prune -o -type f -name '*.json' -print0)
}

# verify_stage stage_dir: fails when staged source is invalid
verify_stage() {
	stage_valid "$1" || fail "installer verification failed"
}

# release_entries release_dir: lists proof-covered files and symlinks
release_entries() {
	local release_dir="$1"
	find "${release_dir}" \( -type f ! -path "${release_dir}/.release-proof" ! -path "${release_dir}/.preparing.*" -printf 'f\t%P\n' \) -o \( -type l -printf 'l\t%P\n' \) | LC_ALL=C sort
}

# release_entry_hash release_dir kind rel: prints an entry content hash
release_entry_hash() {
	local release_dir="$1" kind="$2" rel="$3" value
	if [[ "${kind}" == 'f' ]]; then
		value="$(sha256sum "${release_dir}/${rel}")"
	else
		value="$(readlink -- "${release_dir}/${rel}" | sha256sum)"
	fi
	printf '%s\n' "${value%% *}"
}

# safe_release_link release_dir rel: verifies a symlink remains inside its release
safe_release_link() {
	local release_dir="$1" rel="$2" target resolved root_real
	[[ -L "${release_dir}/${rel}" ]] || return 1
	target="$(readlink -- "${release_dir}/${rel}")"
	[[ "${target}" != /* ]] || return 1
	resolved="$(realpath -e "${release_dir}/${rel}")" || return 1
	root_real="$(realpath -e "${release_dir}")" || return 1
	[[ "${resolved}" == "${root_real}/"* ]]
}

# write_release_proof release_dir sha: writes the immutable completion proof
write_release_proof() {
	local release_dir="$1" sha="$2" proof tmp entry kind rel hash
	local -a entries=()
	mapfile -t entries < <(release_entries "${release_dir}")
	proof="${release_dir}/.release-proof"
	tmp="$(mktemp "${release_dir}/.release-proof.XXXXXX")"
	{
		printf 'release-sha %s\n' "${sha}"
		for entry in "${entries[@]}"; do
			IFS=$'\t' read -r kind rel <<<"${entry}"
			hash="$(release_entry_hash "${release_dir}" "${kind}" "${rel}")"
			printf '%s %s %s\n' "${kind}" "${hash}" "${rel}"
		done
	} >"${tmp}"
	mv -f -- "${tmp}" "${proof}"
}

# release_invalid message: writes an invalid-release error
release_invalid() {
	printf '[install.sh] ERROR: invalid installer release: %s\n' "$*" >&2
	return 1
}

# validate_release release_dir sha final_name: verifies a completed release and runtime dependencies
validate_release() {
	local release_dir="$1" sha="$2" final_name="${3:-}" proof header line kind hash rel actual_hash expected
	local expected_kind expected_hash
	local -A proof_entries=()

	[[ -d "${release_dir}" && ! -L "${release_dir}" && -f "${release_dir}/.release-proof" ]] || { release_invalid "completion proof missing"; return 1; }
	[[ -z "${final_name}" || "$(basename "${release_dir}")" == "${sha}" ]] || { release_invalid "directory identity mismatch"; return 1; }
	proof="${release_dir}/.release-proof"
	IFS= read -r header <"${proof}" || { release_invalid "completion proof is empty"; return 1; }
	[[ "${header}" == "release-sha ${sha}" ]] || { release_invalid "completion proof identity mismatch"; return 1; }
	while IFS= read -r line || [[ -n "${line}" ]]; do
		[[ "${line}" =~ ^([fl])\ ([a-f0-9]{64})\ ([-./@A-Za-z0-9_+]+)$ ]] || { release_invalid "completion proof syntax"; return 1; }
		kind="${BASH_REMATCH[1]}"
		hash="${BASH_REMATCH[2]}"
		rel="${BASH_REMATCH[3]}"
		[[ "${rel}" != .* ]] || { release_invalid "unsafe completion proof path"; return 1; }
		case "/${rel}/" in *"/..""/"*) release_invalid "unsafe completion proof path"; return 1 ;; esac
		[[ -z "${proof_entries[${rel}]+x}" ]] || { release_invalid "duplicate completion proof path"; return 1; }
		proof_entries[${rel}]="${kind}:${hash}"
	done < <(tail -n +2 "${proof}")
	[[ "${#proof_entries[@]}" -gt 0 ]] || { release_invalid "completion proof has no files"; return 1; }

	for rel in "${_SEED_ENTRYPOINTS[@]}" "${_EXTRA_FILES[@]}"; do
		[[ -f "${release_dir}/${rel}" ]] || { release_invalid "required file missing: ${rel}"; return 1; }
	done
	while IFS=$'\t' read -r kind rel; do
		[[ -n "${proof_entries[${rel}]+x}" ]] || { release_invalid "unlisted release entry: ${rel}"; return 1; }
		expected="${proof_entries[${rel}]}"
		expected_kind="${expected%%:*}"
		expected_hash="${expected#*:}"
		[[ "${kind}" == "${expected_kind}" ]] || { release_invalid "entry type mismatch: ${rel}"; return 1; }
		if [[ "${kind}" == 'l' ]]; then
			safe_release_link "${release_dir}" "${rel}" || { release_invalid "unsafe runtime symlink: ${rel}"; return 1; }
		fi
		actual_hash="$(release_entry_hash "${release_dir}" "${kind}" "${rel}")"
		[[ "${actual_hash}" == "${expected_hash}" ]] || { release_invalid "hash mismatch: ${rel}"; return 1; }
		unset 'proof_entries[$rel]'
	done < <(release_entries "${release_dir}")
	[[ "${#proof_entries[@]}" -eq 0 ]] || { release_invalid "completion proof lists missing entries"; return 1; }
	stage_valid "${release_dir}" || { release_invalid "source verification failed"; return 1; }
	for rel in "${_RUNTIME_DEPS[@]}"; do
		[[ -d "${release_dir}/node_modules/${rel}" ]] || { release_invalid "runtime dependency missing: ${rel}"; return 1; }
	done
}

# ----- DEPENDENCIES -----------------------------------------------------------

# install_dependencies installer_dir: installs production dependencies without populating pnpm's managed home
install_dependencies() {
	local installer_dir="$1" log_file pnpm_home pnpm_store dep
	log_file="$(mktemp "${installer_dir}/.pnpm.XXXXXX")"
	pnpm_home="${installer_dir}/.pnpm-home"
	pnpm_store="${installer_dir}/.pnpm-store"
	if ! (cd "${installer_dir}" && PNPM_HOME="${pnpm_home}" corepack pnpm install --store-dir="${pnpm_store}" --prod --frozen-lockfile --ignore-scripts) >"${log_file}" 2>&1; then
		cat "${log_file}" >&2
		rm -f -- "${log_file}"
		fail "pnpm install failed"
	fi
	rm -f -- "${log_file}"
	rm -rf -- "${pnpm_home}" "${pnpm_store}"
	for dep in "${_RUNTIME_DEPS[@]}"; do
		[[ -d "${installer_dir}/node_modules/${dep}" ]] || fail "runtime dependency not installed: ${dep}"
	done
}

# ----- SELF-UPDATE ------------------------------------------------------------

# self_update base_url installer_root: hands off to a newer published bootstrap when safe
self_update() {
	local base_url="$1" installer_root="$2" candidate output err status=0

	[[ -z "${_INSTALLER_SELF_UPDATED:-}" ]] || return 0
	_BOOTSTRAP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/devcontainer-bootstrap.XXXXXX")"
	candidate="${_BOOTSTRAP_DIR}/install.sh"
	output="${_BOOTSTRAP_DIR}/output"
	if ! err="$(curl "${_CURL_OPTS[@]}" "${base_url}/install.sh" -o "${candidate}" 2>&1)" || [[ ! -s "${candidate}" ]]; then
		log "self-update skipped, install.sh could not be fetched${err:+ — ${err##*$'\n'}}"
		return 0
	fi
	if ! bash -n "${candidate}" 2>/dev/null; then
		log "self-update skipped, the published install.sh does not parse"
		return 0
	fi
	if cmp -s "${candidate}" "${BASH_SOURCE[0]}"; then
		log "self-update: already current"
		return 0
	fi
	log "self-update: running the published install.sh"
	_INSTALLER_SELF_UPDATED=1 _INSTALLER_ROOT="${installer_root}" _INSTALLER_RESOLVED_SHA="${_INSTALLER_RESOLVED_SHA}" \
		_INSTALLER_SCRIPTS_REPO="${_INSTALLER_SCRIPTS_REPO}" bash "${candidate}" >"${output}" 2>&1 || status=$?
	if [[ "${status}" -ne 0 ]]; then
		[[ -z "${INSTALLER_VERBOSE:-}" ]] || cat "${output}" >&2
		warn "the published install.sh failed (exit ${status}) — continued with the bundled one"
		return 0
	fi
	cat "${output}" >&2
	exit 0
}

# ----- PROMOTION --------------------------------------------------------------

# valid_scripts_repo repo: validates an owner and repository coordinate
valid_scripts_repo() {
	[[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$ ]]
}

# resolve_scripts_sha scripts_repo requested_ref: resolves a ref to an immutable commit SHA
resolve_scripts_sha() {
	local scripts_repo="$1" requested_ref="$2" response sha
	response="$(curl "${_CURL_OPTS[@]}" "https://api.github.com/repos/${scripts_repo}/commits/${requested_ref}")" \
		|| fail "could not resolve ${scripts_repo}@${requested_ref}"
	sha="$(node -e 'try { const sha = JSON.parse(require("node:fs").readFileSync(0, "utf8")).sha; process.stdout.write(typeof sha === "string" ? sha : ""); } catch { process.exit(1); }' <<<"${response}")" \
		|| fail "could not parse immutable SHA for ${scripts_repo}@${requested_ref}"
	[[ "${sha}" =~ ^[a-f0-9]{40}$ ]] || fail "invalid immutable SHA for ${scripts_repo}@${requested_ref}"
	printf '%s\n' "${sha}"
}

# installer_base_url scripts_repo sha: prints the immutable raw installer URL
installer_base_url() {
	local scripts_repo="$1" sha="$2"
	printf 'https://raw.githubusercontent.com/%s/%s/scripts/installer\n' "${scripts_repo}" "${sha}"
}

# owner_markers_are_gone release_dir: succeeds only when every owner marker names a dead process
owner_markers_are_gone() {
	local release_dir="$1" marker pid
	local -a markers=()
	mapfile -t markers < <(find "${release_dir}" -maxdepth 1 -type f -name '.preparing.*' -printf '%f\n')
	[[ "${#markers[@]}" -gt 0 ]] || return 1
	for marker in "${markers[@]}"; do
		pid="${marker#.preparing.}"
		[[ "${pid}" =~ ^[0-9]+$ && ! -d "/proc/${pid}" ]] || return 1
	done
}

# clear_stale_owner_markers release_dir: removes owner markers only after their owners exit
clear_stale_owner_markers() {
	local release_dir="$1" marker
	local -a markers=()
	mapfile -t markers < <(find "${release_dir}" -maxdepth 1 -type f -name '.preparing.*' -printf '%f\n')
	[[ "${#markers[@]}" -eq 0 ]] && return 0
	owner_markers_are_gone "${release_dir}" || return 1
	for marker in "${markers[@]}"; do rm -f -- "${release_dir}/${marker}"; done
}

# cleanup_stale_candidates releases_dir: removes old candidates whose owners are dead
cleanup_stale_candidates() {
	local releases_dir="$1" candidate
	# why: candidates without a dead attributable owner are conservatively left for a later promoter.
	while IFS= read -r -d '' candidate; do
		owner_markers_are_gone "${candidate}" || continue
		rm -rf -- "${candidate}"
	done < <(find "${releases_dir}" -mindepth 1 -maxdepth 1 -type d -name '.candidate-*' -mmin "+${_STALE_CANDIDATE_MINUTES}" -print0)
}

# promotion_artifact_owner_is_gone artifact: succeeds only for a dead owner's well-formed promotion symlink
promotion_artifact_owner_is_gone() {
	local artifact="$1" name pid target
	[[ -L "${artifact}" ]] || return 1
	name="$(basename -- "${artifact}")"
	[[ "${name}" =~ ^\.current\.promote\.([0-9]+)\.([0-9]+)$ ]] || return 1
	pid="${BASH_REMATCH[1]}"
	target="$(readlink -- "${artifact}")" || return 1
	[[ "${target}" =~ ^releases/[a-f0-9]{40}$ && ! -d "/proc/${pid}" ]]
}

# cleanup_stale_promotion_artifacts installer_root: removes only dead-owner promotion symlinks while locked
cleanup_stale_promotion_artifacts() {
	local installer_root="$1" artifact
	# why: naming and target checks prevent this recovery path from deleting unrelated root entries.
	while IFS= read -r -d '' artifact; do
		promotion_artifact_owner_is_gone "${artifact}" || continue
		rm -f -- "${artifact}"
	done < <(find "${installer_root}" -mindepth 1 -maxdepth 1 -type l -name '.current.promote.*' -print0)
}

# retain_releases releases_dir active_sha previous_sha: keeps only active and previous releases
retain_releases() {
	local releases_dir="$1" active_sha="$2" previous_sha="$3" release name
	for release in "${releases_dir}"/*; do
		[[ -d "${release}" ]] || continue
		name="$(basename "${release}")"
		[[ "${name}" =~ ^[a-f0-9]{40}$ ]] || continue
		[[ "${name}" == "${active_sha}" || "${name}" == "${previous_sha}" ]] || rm -rf -- "${release}"
	done
}

# activate_release installer_root sha: atomically selects a validated release while the promotion lock is held
activate_release() {
	local installer_root="$1" sha="$2" releases_dir current_path current_new current_target previous_sha="" attempt=0
	releases_dir="${installer_root}/releases"
	current_path="${installer_root}/current"
	if [[ -L "${current_path}" ]]; then
		current_target="$(readlink -- "${current_path}")"
		if [[ "${current_target}" =~ ^releases/([a-f0-9]{40})$ ]]; then previous_sha="${BASH_REMATCH[1]}"; fi
	fi
	# why: successful exclusive creation makes this PID-labelled root symlink unique and recoverable after owner death.
	while [[ "${attempt}" -lt 32 ]]; do
		current_new="${installer_root}/.current.promote.$$.${RANDOM}"
		if ln -sT -- "releases/${sha}" "${current_new}" 2>/dev/null && [[ -L "${current_new}" ]]; then
			_CURRENT_PROMOTION_PATH="${current_new}"
			_CURRENT_PROMOTION_ID="$(stat -c '%d:%i' -- "${current_new}")"
			_CURRENT_PROMOTION_OWNED=1
			break
		fi
		((attempt += 1))
	done
	[[ -n "${_CURRENT_PROMOTION_OWNED}" ]] || fail "could not create unique installer promotion artifact"
	# why: both names are in the installer root, so this final rename is atomic and preserves current until it succeeds.
	mv -Tf -- "${current_new}" "${current_path}"
	_CURRENT_PROMOTION_OWNED=""
	_CURRENT_PROMOTION_PATH=""
	_CURRENT_PROMOTION_ID=""
	retain_releases "${releases_dir}" "${sha}" "${previous_sha}"
}

# reuse_existing_release installer_root sha: validates and activates an existing release under lock
reuse_existing_release() {
	local installer_root="$1" sha="$2" releases_dir release_dir lock_file lock_fd
	releases_dir="${installer_root}/releases"
	release_dir="${releases_dir}/${sha}"
	lock_file="${installer_root}/.install.lock"
	mkdir -p "${releases_dir}"
	exec {lock_fd}>"${lock_file}"
	flock "${lock_fd}" || fail "could not acquire installer promotion lock"
	cleanup_stale_candidates "${releases_dir}"
	cleanup_stale_promotion_artifacts "${installer_root}"
	if [[ ! -e "${release_dir}" && ! -L "${release_dir}" ]]; then
		exec {lock_fd}>&-
		return 2
	fi
	clear_stale_owner_markers "${release_dir}" || fail "existing release owner marker is still active"
	validate_release "${release_dir}" "${sha}" final || fail "refusing to overwrite invalid existing release ${sha}"
	activate_release "${installer_root}" "${sha}"
	exec {lock_fd}>&-
}

# promote_release installer_root sha candidate: serializes candidate promotion and activation
promote_release() {
	local installer_root="$1" sha="$2" candidate="$3" releases_dir release_dir lock_file lock_fd marker_name
	releases_dir="${installer_root}/releases"
	release_dir="${releases_dir}/${sha}"
	lock_file="${installer_root}/.install.lock"
	exec {lock_fd}>"${lock_file}"
	flock "${lock_fd}" || fail "could not acquire installer promotion lock"
	cleanup_stale_candidates "${releases_dir}"
	cleanup_stale_promotion_artifacts "${installer_root}"
	if [[ -e "${release_dir}" || -L "${release_dir}" ]]; then
		clear_stale_owner_markers "${release_dir}" || fail "existing release owner marker is still active"
		validate_release "${release_dir}" "${sha}" final || fail "refusing to overwrite invalid existing release ${sha}"
		rm -rf -- "${candidate}"
		_STAGE_DIR=""
		_PREPARING_MARKER=""
	else
		[[ -n "${_PREPARING_MARKER}" && -f "${_PREPARING_MARKER}" ]] || fail "candidate owner marker missing"
		validate_release "${candidate}" "${sha}" || fail "candidate validation failed"
		mv -- "${candidate}" "${release_dir}"
		_STAGE_DIR=""
		marker_name="$(basename -- "${_PREPARING_MARKER}")"
		rm -f -- "${release_dir}/${marker_name}"
		_PREPARING_MARKER=""
		validate_release "${release_dir}" "${sha}" final || fail "release validation failed after rename"
	fi
	activate_release "${installer_root}" "${sha}"
	exec {lock_fd}>&-
}

# ----- CORE SETUP -------------------------------------------------------------

# main args: resolves, verifies, and activates an immutable installer release
main() {
	local installer_root scripts_ref scripts_repo sha base_url verified_files proof_hash reuse_status=0

	installer_root="${_INSTALLER_ROOT:-${_INSTALLER_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)}}"
	scripts_ref="${SCRIPTS_REF:-main}"
	scripts_repo="${_INSTALLER_SCRIPTS_REPO:-${SCRIPTS_REPO:-${_DEFAULT_SCRIPTS_REPO}}}"
	valid_scripts_repo "${scripts_repo}" || fail "invalid SCRIPTS_REPO: ${scripts_repo}"
	command -v curl >/dev/null 2>&1 || fail "curl is required but was not found on PATH"
	command -v node >/dev/null 2>&1 || fail "node is required but was not found on PATH"
	command -v corepack >/dev/null 2>&1 || fail "corepack is required but was not found on PATH"
	command -v flock >/dev/null 2>&1 || fail "flock is required but was not found on PATH"
	command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required but was not found on PATH"
	command -v realpath >/dev/null 2>&1 || fail "realpath is required but was not found on PATH"

	if [[ -n "${_INSTALLER_RESOLVED_SHA:-}" ]]; then
		sha="${_INSTALLER_RESOLVED_SHA}"
		[[ "${sha}" =~ ^[a-f0-9]{40}$ ]] || fail "invalid inherited immutable SHA"
	else
		sha="$(resolve_scripts_sha "${scripts_repo}" "${scripts_ref}")"
	fi
	_INSTALLER_RESOLVED_SHA="${sha}"
	_INSTALLER_SCRIPTS_REPO="${scripts_repo}"
	base_url="$(installer_base_url "${scripts_repo}" "${sha}")"
	self_update "${base_url}" "${installer_root}"

	mkdir -p "${installer_root}/releases"
	reuse_existing_release "${installer_root}" "${sha}" || reuse_status=$?
	if [[ "${reuse_status}" -eq 0 ]]; then
		verified_files="$(release_entries "${installer_root}/releases/${sha}" | wc -l)"
		proof_hash="$(sha256sum "${installer_root}/releases/${sha}/.release-proof")"
		log "verified ${verified_files} files for release ${sha} (proof ${proof_hash%% *})"
		log "installer ready: ${installer_root}/current -> releases/${sha}"
		return 0
	fi
	[[ "${reuse_status}" -eq 2 ]] || fail "could not reuse installer release ${sha}"
	_STAGE_DIR="$(mktemp -d "${installer_root}/releases/.candidate-${sha}.XXXXXX")"
	_PREPARING_MARKER="${_STAGE_DIR}/.preparing.$$"
	touch "${_PREPARING_MARKER}"
	log "fetching installer from ${scripts_repo}@${sha}"
	fetch_graph "${base_url}" "${_STAGE_DIR}"
	verify_stage "${_STAGE_DIR}"
	install_dependencies "${_STAGE_DIR}"
	write_release_proof "${_STAGE_DIR}" "${sha}"
	validate_release "${_STAGE_DIR}" "${sha}" || fail "candidate validation failed"
	verified_files="$(release_entries "${_STAGE_DIR}" | wc -l)"
	proof_hash="$(sha256sum "${_STAGE_DIR}/.release-proof")"
	promote_release "${installer_root}" "${sha}" "${_STAGE_DIR}"
	log "verified ${verified_files} files for release ${sha} (proof ${proof_hash%% *})"
	log "installer ready: ${installer_root}/current -> releases/${sha}"
}

export -f log warn fail cleanup download_file required_paths fetch_graph stage_valid verify_stage \
	release_entries release_entry_hash safe_release_link write_release_proof validate_release install_dependencies self_update valid_scripts_repo resolve_scripts_sha \
	installer_base_url owner_markers_are_gone clear_stale_owner_markers cleanup_stale_candidates promotion_artifact_owner_is_gone cleanup_stale_promotion_artifacts retain_releases activate_release reuse_existing_release promote_release main

# ----- ENTRY POINT ------------------------------------------------------------

trap cleanup EXIT
trap stop_on_sigint INT
trap stop_on_sigterm TERM
main "$@"
