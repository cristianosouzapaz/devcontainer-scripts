#!/bin/bash
set -euo pipefail

# Bootstraps the installer package from the public scripts repository: downloads every
# file the entry scripts' import graph reaches into a staging tree, verifies the tree,
# then copies it live and installs the npm runtime dependencies. A fetch or verification
# failure leaves the live installer directory untouched. It runs before the shared
# logging library exists, so it logs straight to stderr.

# ----- CONFIGURATION ----------------------------------------------------------

# why: every other file is discovered from their import graph, so this is the only hand-kept list
readonly _SEED_ENTRYPOINTS=(
	"agents/index.js"
	"configs/index.js"
	"skills/index.js"
	"skills/local/index.js"
	"agent-md/index.js"
)

# why: required but unreachable from the import graph; sync-agent-assets.sh copies AGENTS.md out of this tree
readonly _EXTRA_FILES=("package.json" "agents/templates/global/AGENTS.md")

readonly _RUNTIME_DEPS=("@inquirer/core" "@inquirer/prompts" "chalk" "consola")

readonly _CURL_OPTS=(
	--fail --location --show-error --silent
	--retry 5 --retry-delay 2 --retry-connrefused --retry-all-errors
	--connect-timeout 15 --max-time 120
)

# why: real graphs settle in two or three passes, so reaching this cap is a bug
readonly _MAX_GRAPH_ITERATIONS=10

# ----- LOGGING ----------------------------------------------------------------

# log <message...>: writes a progress line to stderr when INSTALLER_VERBOSE is non-empty
# Notes: the bootstrap is a quiet prerequisite of the node …/index.js tasks; only the
#   global-asset sync opts in, to parse "verified N files" out of the captured output.
log() {
	[[ -n "${INSTALLER_VERBOSE:-}" ]] || return 0
	printf '[install.sh] %s\n' "$*" >&2
}

# warn <message...>: writes a warning to stderr
# Notes: not gated on INSTALLER_VERBOSE: a degraded run must say so, or a silent
#   fallback reads as a clean one.
warn() {
	printf '[install.sh] WARNING: %s\n' "$*" >&2
}

# fail <message...>: writes an error to stderr and exits 1
fail() {
	printf '[install.sh] ERROR: %s\n' "$*" >&2
	exit 1
}

# ----- CLEANUP ----------------------------------------------------------------

_STAGE_DIR=""
_BOOTSTRAP_DIR=""

# cleanup: removes the staging and the self-update scratch directories
cleanup() {
	[[ -n "${_STAGE_DIR}" && -d "${_STAGE_DIR}" ]] && rm -rf "${_STAGE_DIR}"
	[[ -n "${_BOOTSTRAP_DIR}" && -d "${_BOOTSTRAP_DIR}" ]] && rm -rf "${_BOOTSTRAP_DIR}"
	return 0
}

# ----- DOWNLOAD ---------------------------------------------------------------

# download_file <base_url> <stage_dir> <rel_path>: downloads one repo-relative path into the staging tree, exiting on failure
# Notes: writes through a temp file, so a failed or empty transfer never leaves a partial
#   file. curl's output is captured, not printed: every retry repeats the same line, so
#   only the last one is kept, as the reason on the fatal message.
download_file() {
	local base_url="$1" stage_dir="$2" rel="$3"
	local url="${base_url}/${rel}" dest="${stage_dir}/${rel}" tmp err rc=0

	mkdir -p "$(dirname "${dest}")"
	tmp="$(mktemp "${dest}.XXXXXX")"

	err="$(curl "${_CURL_OPTS[@]}" "${url}" -o "${tmp}" 2>&1)" || rc=$?
	if [[ "${rc}" -eq 0 && -s "${tmp}" ]]; then
		mv -f "${tmp}" "${dest}"
		return 0
	fi
	rm -f "${tmp}"
	fail "download failed: ${url}${err:+ — ${err##*$'\n'}}"
}

# ----- DEPENDENCY GRAPH -------------------------------------------------------

# required_paths <stage_dir>: prints every repo-relative path the staged .js and .json files reference, sorted and de-duplicated
# Notes: covers relative imports, file new URL("./...") references and manifest
#   templateFile and resources entries. A directory new URL() is a base for later reads,
#   not a file to download, so it is skipped. An invalid staged JSON file exits 1.
required_paths() {
	local stage_dir="$1"
	# shellcheck disable=SC2016  # the single-quoted body is a JS program, not a shell string
	node -e '
		const { readdirSync, readFileSync, existsSync } = require("node:fs");
		const { join, dirname, relative, resolve } = require("node:path");

		const [root] = process.argv.slice(1);

		const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
			e.isDirectory() ? walk(join(dir, e.name)) : join(dir, e.name));

		// The installer sources use single-line import statements exclusively.
		const REFERENCE_PATTERNS = [
			/(?:^|\n)\s*(?:import|export)\b[^\n]*?\bfrom\s*["\x27]([^"\x27]+)["\x27]/g,
			/(?:^|\n)\s*import\s*["\x27]([^"\x27]+)["\x27]/g,
			/new\s+URL\s*\(\s*["\x27](\.[^"\x27]+)["\x27]/g,
		];

		const parseJson = (file) => {
			try {
				return JSON.parse(readFileSync(file, "utf8"));
			} catch (e) {
				console.error(`invalid JSON in ${relative(root, file)}: ${e.message}`);
				process.exit(1);
			}
		};

		const resolveImport = (file, spec) => {
			const base = resolve(dirname(file), spec);
			if (/\.[a-z0-9]+$/i.test(spec)) return base;
			return existsSync(`${base}.js`) ? `${base}.js` : join(base, "index.js");
		};

		const referencesOf = (file) => {
			if (file.endsWith(".js")) {
				const src = readFileSync(file, "utf8");
				return REFERENCE_PATTERNS
					.flatMap((re) => [...src.matchAll(re)].map((m) => m[1]))
					.filter((spec) => spec.startsWith(".") && !spec.endsWith("/"))
					.map((spec) => resolveImport(file, spec));
			}
			if (file.endsWith(".json")) {
				const data = parseJson(file);
				return (Array.isArray(data) ? data : [data])
					.flatMap((entry) => entry && typeof entry.templateFile === "string"
						? [entry.templateFile, ...(Array.isArray(entry.resources) ? entry.resources : [])]
						: [])
					.map((templateFile) => join(dirname(file), "templates", templateFile));
			}
			return [];
		};

		const files = existsSync(root) ? walk(root) : [];
		const rels = new Set(files.flatMap(referencesOf).map((abs) => relative(root, abs).split("\\").join("/")));
		for (const rel of [...rels].sort()) console.log(rel);
	' "${stage_dir}"
}

# fetch_graph <base_url> <stage_dir>: downloads the seed files, then everything they reference until nothing new is referenced, exiting on failure or when the graph does not converge
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

# assert_parses <stage_dir> <pattern> <checker...>: exits unless the checker, given the file path as its last argument, accepts every file matching the find name pattern
assert_parses() {
	local stage_dir="$1" pattern="$2" file
	shift 2

	while IFS= read -r -d '' file; do
		"$@" "${file}" >/dev/null 2>&1 \
			|| fail "unparseable (truncated download or error page?): ${file#"${stage_dir}"/}"
	done < <(find "${stage_dir}" -type f -name "${pattern}" -print0)
}

# verify_stage <stage_dir>: exits unless every staged JavaScript file parses as an ES module
# Notes: package.json must be "type": "module" for node --check to check module syntax;
#   without it a truncated ES module can pass.
verify_stage() {
	local stage_dir="$1"

	node -e 'process.exit(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).type === "module" ? 0 : 1)' \
		"${stage_dir}/package.json" >/dev/null 2>&1 \
		|| fail 'package.json missing, invalid, or not "type": "module"'

	assert_parses "${stage_dir}" '*.js' node --check
}

# ----- DEPENDENCIES -----------------------------------------------------------

# install_dependencies <installer_dir>: runs npm install for production dependencies, showing its output only on failure, then exits unless every runtime dependency resolved
install_dependencies() {
	local installer_dir="$1" log_file dep
	log_file="$(mktemp)"

	if ! npm install --omit=dev --no-audit --no-fund --no-package-lock --loglevel=error >"${log_file}" 2>&1; then
		cat "${log_file}" >&2
		rm -f "${log_file}"
		fail "npm install failed"
	fi
	rm -f "${log_file}"

	for dep in "${_RUNTIME_DEPS[@]}"; do
		[[ -d "${installer_dir}/node_modules/${dep}" ]] || fail "runtime dependency not installed: ${dep}"
	done
}

# ----- SELF-UPDATE ------------------------------------------------------------

# self_update <base_url> <installer_dir>: hands the run to the published copy of this script when it differs from this one
# Returns: 0 when this process should carry on; exits 0 once a candidate has done the run.
# Notes: the import graph cannot reach this script, which walks it, so a fix here would
#   otherwise wait for an image rebuild. The image copy is never overwritten and stays the
#   known-good fallback: a candidate that cannot be fetched, is empty, does not parse or
#   fails is discarded. _INSTALLER_SELF_UPDATED stops the candidate updating itself;
#   _INSTALLER_DIR carries the target directory it cannot derive from its temp path.
self_update() {
	local base_url="$1" installer_dir="$2" candidate output err status=0

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
	_INSTALLER_SELF_UPDATED=1 _INSTALLER_DIR="${installer_dir}" bash "${candidate}" >"${output}" 2>&1 || status=$?
	if [[ "${status}" -ne 0 ]]; then
		# why: a discarded candidate's errors describe a run that did not happen
		[[ -z "${INSTALLER_VERBOSE:-}" ]] || cat "${output}" >&2
		warn "the published install.sh failed (exit ${status}) — continued with the bundled one"
		return 0
	fi

	cat "${output}" >&2
	exit 0
}

# ----- CORE SETUP -------------------------------------------------------------

# installer_base_url <ref>: prints the raw-content base URL of the installer at a git ref
# Notes: the public repository is this repository's public/ subtree published at its
#   root, so the path carries no public/ prefix.
installer_base_url() {
	local scripts_ref="$1"
	printf 'https://raw.githubusercontent.com/cristianosouzapaz/devcontainer-scripts/%s/scripts/installer\n' "${scripts_ref}"
}

# main: fetches, verifies and installs the whole installer package, exiting on any failure
main() {
	local installer_dir base_url scripts_ref

	installer_dir="${_INSTALLER_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)}"
	scripts_ref="${SCRIPTS_REF:-main}"
	base_url="$(installer_base_url "${scripts_ref}")"

	command -v curl >/dev/null 2>&1 || fail "curl is required but was not found on PATH"
	command -v node >/dev/null 2>&1 || fail "node is required but was not found on PATH"
	command -v npm  >/dev/null 2>&1 || fail "npm is required but was not found on PATH"

	self_update "${base_url}" "${installer_dir}"

	_STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/devcontainer-installer.XXXXXX")"

	log "fetching installer from devcontainer-scripts@${scripts_ref}"
	fetch_graph "${base_url}" "${_STAGE_DIR}"
	verify_stage "${_STAGE_DIR}"

	log "verified $(find "${_STAGE_DIR}" -type f | wc -l) files — installing into ${installer_dir}"
	mkdir -p "${installer_dir}"
	cp -R "${_STAGE_DIR}/." "${installer_dir}/"

	cd "${installer_dir}"
	install_dependencies "${installer_dir}"
	log "installer ready"
}

export -f log warn fail cleanup download_file required_paths fetch_graph assert_parses \
	verify_stage install_dependencies self_update installer_base_url main

# ----- ENTRY POINT ------------------------------------------------------------

trap cleanup EXIT INT TERM
main "$@"
