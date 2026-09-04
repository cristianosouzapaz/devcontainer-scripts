#!/bin/bash
set -euo pipefail

# Bootstraps the installer package from the public scripts repository. Discovers every
# source file, manifest and template by walking the entry scripts' import graph, downloads
# them into a staging tree, verifies the tree is complete and parseable, and only then
# copies it live and installs the npm runtime dependencies. Any failure leaves the live
# installer directory untouched. It hands the run to its own published copy first — see
# SELF-UPDATE below.

# ----- CONFIGURATION -------------------------------------------------------------

# The entry scripts the VS Code tasks run. Everything else is discovered from their
# import graph, so this is the only list kept in step with the package layout by hand.
readonly _SEED_ENTRYPOINTS=(
	"agents/index.js"
	"configs/index.js"
	"skills/index.js"
	"skills/local/index.js"
	"agent-md/index.js"
)

# Required, but not reachable from the import graph.
readonly _EXTRA_FILES=("package.json")

readonly _RUNTIME_DEPS=("@inquirer/core" "@inquirer/prompts" "chalk" "consola")

readonly _CURL_OPTS=(
	--fail --location --show-error --silent
	--retry 5 --retry-delay 2 --retry-connrefused --retry-all-errors
	--connect-timeout 15 --max-time 120
)

readonly _MAX_GRAPH_ITERATIONS=10

# ----- LOGGING -----------------------------------------------------------------
# Runs before the shared logging library exists, so it writes straight to stderr.

# log: Progress line to stderr, silenced unless INSTALLER_VERBOSE is non-empty — the
# bootstrap is a quiet prerequisite of the `node …/index.js` tasks, and only the
# global-asset sync opts in, to parse "verified N files" out of the captured output.
log() {
	[[ -n "${INSTALLER_VERBOSE:-}" ]] || return 0
	printf '[install.sh] %s\n' "$*" >&2
}

# warn: Print a problem the run carried on past. Not gated on INSTALLER_VERBOSE — a
# degraded run must say so, or a silent fallback reads as a clean one.
warn() {
	printf '[install.sh] WARNING: %s\n' "$*" >&2
}

# fail: Print a fatal message to stderr and exit non-zero.
fail() {
	printf '[install.sh] ERROR: %s\n' "$*" >&2
	exit 1
}

# ----- CLEANUP ---------------------------------------------------------------

_STAGE_DIR=""
_BOOTSTRAP_DIR=""

# cleanup: Remove the staging directory and the self-update scratch directory. Always
# returns 0 so it never blocks exit.
cleanup() {
	[[ -n "${_STAGE_DIR}" && -d "${_STAGE_DIR}" ]] && rm -rf "${_STAGE_DIR}"
	[[ -n "${_BOOTSTRAP_DIR}" && -d "${_BOOTSTRAP_DIR}" ]] && rm -rf "${_BOOTSTRAP_DIR}"
	return 0
}

# ----- DOWNLOAD ------------------------------------------------------------

# download_file: Fetch one repo-relative path into the staging tree, writing through a
# temp file so a failed or empty transfer never leaves a partial file behind. curl's output
# is captured, not printed: every retry repeats the same line, so only the last one survives,
# as the reason on the fatal message.
# Args: $1 base_url, $2 stage_dir, $3 repo-relative path
# Returns: 0 on success; fatal otherwise.
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

# ----- DEPENDENCY GRAPH --------------------------------------------------------

# required_paths: Print every repo-relative path referenced by the staged .js and .json
# files — resolved relative imports, file `new URL("./...")` references, and manifest
# `templateFile`s — sorted and de-duplicated. Directory `new URL()` references are
# intentionally ignored: they are bases for later reads, not files to download. Analysis runs in node, so JS/JSON
# formatting is irrelevant; an invalid staged JSON file aborts the run.
# Args: $1 stage_dir
required_paths() {
	local stage_dir="$1"
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

# fetch_graph: Download the seed files, then resolve and download everything they
# reference until the set is closed.
# Args: $1 base_url, $2 stage_dir
# Returns: 0 on success; fatal if analysis fails or the graph does not converge.
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

# ----- VERIFICATION ------------------------------------------------------------

# assert_parses: Fail unless every file matching <pattern> under <stage_dir> is accepted
# by the checker command, which is invoked with the file path as its final argument.
# Args: $1 stage_dir, $2 find name pattern, $3.. checker command
assert_parses() {
	local stage_dir="$1" pattern="$2" file
	shift 2

	while IFS= read -r -d '' file; do
		"$@" "${file}" >/dev/null 2>&1 \
			|| fail "unparseable (truncated download or error page?): ${file#"${stage_dir}"/}"
	done < <(find "${stage_dir}" -type f -name "${pattern}" -print0)
}

# verify_stage: Fail unless the seed files are present, every staged file parses, and
# every referenced path was fetched. Runs before anything goes live.
# Args: $1 stage_dir
verify_stage() {
	local stage_dir="$1" rel raw
	local -a missing=()

	for rel in "${_SEED_ENTRYPOINTS[@]}" "${_EXTRA_FILES[@]}"; do
		[[ -f "${stage_dir}/${rel}" ]] || fail "expected file was not fetched: ${rel}"
	done

	# package.json must be "type": "module" so `node --check` validates the ES modules in
	# module mode; without it a truncated ESM file can pass the check.
	node -e 'process.exit(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).type === "module" ? 0 : 1)' \
		"${stage_dir}/package.json" >/dev/null 2>&1 \
		|| fail 'package.json missing, invalid, or not "type": "module"'

	assert_parses "${stage_dir}" '*.js' node --check
	assert_parses "${stage_dir}" '*.json' node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))'

	raw="$(required_paths "${stage_dir}")" || fail "installer dependency analysis failed"
	while IFS= read -r rel; do
		[[ -z "${rel}" || -e "${stage_dir}/${rel}" ]] && continue
		missing+=("${rel}")
	done <<< "${raw}"
	[[ "${#missing[@]}" -eq 0 ]] || fail "referenced files missing after fetch: ${missing[*]}"
}

# ----- DEPENDENCIES ----------------------------------------------------------

# install_dependencies: Run `npm install` (prod deps only), surfacing its output only on
# failure, then confirm each runtime dependency resolved.
# Args: $1 installer_dir
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

# ----- SELF-UPDATE -----------------------------------------------------------

# This script is the one file the import graph cannot reach — it is what walks the graph — so
# a fix here would otherwise wait for an image rebuild, and a bootstrap too broken to download
# anything would stay broken until then. The published copy is fetched first and handed the
# run when it differs.
#
# It never overwrites the copy in the image, which stays the known-good fallback: a bad
# publish is undone by publishing a fix, not by rebuilding every image.

# self_update: Hand the run to the published copy of this script when it differs from this
# one. A candidate that cannot be fetched, is empty, does not parse, or fails is discarded.
# _INSTALLER_SELF_UPDATED stops the candidate fetching one of its own; _INSTALLER_DIR carries
# the target directory it cannot derive from its temporary path.
# Args: $1 base_url, $2 installer_dir
# Returns: 0 when this process should carry on; exits 0 once a candidate has done the run.
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
		# A discarded candidate's errors describe a run that did not happen, so they stay
		# behind the verbose gate; the fallback itself is always reported.
		[[ -z "${INSTALLER_VERBOSE:-}" ]] || cat "${output}" >&2
		warn "the published install.sh failed (exit ${status}) — continued with the bundled one"
		return 0
	fi

	# The candidate did the real work, so its output is this run's output.
	cat "${output}" >&2
	exit 0
}

# ----- CORE SETUP ----------------------------------------------------------

# installer_base_url: Print the raw-content base URL for an installer ref. The public
# repository is this repository's `public/` subtree published at its root, so the
# installer sits at `scripts/installer` there and not under a `public/` prefix.
# Args: $1 - git ref.
# Returns: 0, URL on stdout.
installer_base_url() {
	local scripts_ref="$1"
	printf 'https://raw.githubusercontent.com/cristianosouzapaz/devcontainer-scripts/%s/scripts/installer\n' "${scripts_ref}"
}

# main: Fetches, verifies and installs the whole installer package.
# Returns: 0 on success; fatal on any missing prerequisite, download or verification failure.
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

# ----- ENTRY POINT ---------------------------------------------------------

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
	trap cleanup EXIT INT TERM
	main "$@"
fi
