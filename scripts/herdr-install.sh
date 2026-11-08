#!/bin/bash
set -euo pipefail

# Installs the herdr release binary for this machine, verified against its sha256 digest. The
# image build and the Bash test runner both run it, so they install herdr the same way. Safe to
# re-run: it replaces the binary with the verified release.
# Usage: herdr-install.sh [target]   (default /usr/local/lib/herdr/herdr)
# HERDR_VERSION pins a release tag; empty takes the latest release.
# HERDR_SHA256_X86_64 and HERDR_SHA256_AARCH64 pin the asset digests of the release
# HERDR_SHA256_VERSION names: when it equals HERDR_VERSION and this machine's digest is set, the
# asset is downloaded directly, with no REST lookup. Otherwise, an overridden HERDR_VERSION
# included, the digest GitHub publishes for the asset is used.
# GITHUB_TOKEN, when set, authenticates the release lookup and the API download fallback, so a
# shared CI runner is not held to GitHub's per-address limit for anonymous API calls.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

BOOTSTRAP_LIB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/setup/lib" && pwd)"
source "$BOOTSTRAP_LIB_DIR/loader.sh"

# why: a fixed --retry-delay turns off curl's exponential backoff, so retries are bounded by total time instead
readonly -a HERDR_CURL_OPTS=(
	--fail --location --silent --show-error
	--retry 6 --retry-max-time 180 --retry-all-errors --retry-connrefused
	--connect-timeout 15 --max-time 120
)

# why: the EXIT trap runs after main returns, when its locals are gone
WORK_DIR=""
trap 'rm -rf -- "$WORK_DIR"' EXIT

# ----- FUNCTIONS --------------------------------------------------------------

# herdr_asset_name: prints the release asset name for this machine's architecture
# Stdout: the asset name
herdr_asset_name() {
	case "$(uname -m)" in
	x86_64) printf '%s\n' herdr-linux-x86_64 ;;
	aarch64 | arm64) printf '%s\n' herdr-linux-aarch64 ;;
	*) return 1 ;;
	esac
}

# herdr_pinned_digest <asset>: prints the pinned sha256 of the asset, or nothing when none is pinned
# Stdout: the pinned sha256, hex only
herdr_pinned_digest() {
	case "$1" in
	herdr-linux-x86_64) printf '%s\n' "${HERDR_SHA256_X86_64:-}" ;;
	herdr-linux-aarch64) printf '%s\n' "${HERDR_SHA256_AARCH64:-}" ;;
	esac
}

# herdr_read_release <output> [curl header option...]: downloads the release JSON HERDR_VERSION names, or the latest one
herdr_read_release() {
	local output="$1" release_url='https://api.github.com/repos/herdrdev/herdr/releases/latest'
	if [[ -n "${HERDR_VERSION:-}" ]]; then
		release_url="https://api.github.com/repos/herdrdev/herdr/releases/tags/${HERDR_VERSION}"
	fi
	curl "${HERDR_CURL_OPTS[@]}" "${@:2}" "$release_url" --output "$output" \
		|| log_fatal "Could not read the herdr release: $release_url"
}

# herdr_release_field <release_json> <asset> <field>: prints one field of the asset's entry in the release JSON
# Stdout: the field's value, or null
herdr_release_field() {
	jq -r --arg asset "$2" --arg field "$3" '.assets[] | select(.name == $asset) | .[$field]' "$1"
}

# main [target]: downloads the release asset, checks its digest and replaces the target with it
main() {
	local target="${1:-/usr/local/lib/herdr/herdr}" asset url="" api_url="" digest pinned=""
	local -a auth=()
	asset="$(herdr_asset_name)" || log_fatal "No herdr release asset for architecture $(uname -m)"
	if [[ -n "${GITHUB_TOKEN:-}" ]]; then
		auth=(--header "Authorization: Bearer ${GITHUB_TOKEN}")
	fi
	WORK_DIR="$(mktemp -d)"
	# why: a pinned digest belongs to the release it was taken from, never to an overridden or latest version
	if [[ -n "${HERDR_VERSION:-}" && "${HERDR_SHA256_VERSION:-}" == "$HERDR_VERSION" ]]; then
		pinned="$(herdr_pinned_digest "$asset")"
	fi
	if [[ -n "$pinned" ]]; then
		digest="sha256:${pinned}"
		url="https://github.com/herdrdev/herdr/releases/download/${HERDR_VERSION}/${asset}"
	else
		herdr_read_release "$WORK_DIR/release.json" "${auth[@]}"
		url="$(herdr_release_field "$WORK_DIR/release.json" "$asset" browser_download_url)"
		api_url="$(herdr_release_field "$WORK_DIR/release.json" "$asset" url)"
		digest="$(herdr_release_field "$WORK_DIR/release.json" "$asset" digest)"
		[[ -n "$url" && "$url" != null ]] || log_fatal "The herdr release has no $asset asset"
	fi
	[[ "$digest" == sha256:* ]] || log_fatal "The herdr release publishes no sha256 digest for $asset"
	if ! curl "${HERDR_CURL_OPTS[@]}" "$url" --output "$WORK_DIR/herdr"; then
		log_warning "Could not download $url, trying the release API"
		if [[ -z "$api_url" ]]; then
			herdr_read_release "$WORK_DIR/release.json" "${auth[@]}"
			api_url="$(herdr_release_field "$WORK_DIR/release.json" "$asset" url)"
		fi
		[[ -n "$api_url" && "$api_url" != null ]] || log_fatal "Could not download $url"
		curl "${HERDR_CURL_OPTS[@]}" --header 'Accept: application/octet-stream' "${auth[@]}" "$api_url" --output "$WORK_DIR/herdr" \
			|| log_fatal "Could not download $asset from $url or $api_url"
	fi
	printf '%s  %s\n' "${digest#sha256:}" "$WORK_DIR/herdr" | sha256sum --check --status \
		|| log_fatal "The downloaded $asset does not match its sha256 digest"
	mkdir -p -- "$(dirname -- "$target")"
	atomic_write "$target" cat "$WORK_DIR/herdr" || log_fatal "Could not install herdr at $target"
	chmod 0755 "$target"
	log_success "Installed herdr at $target"
}

main "$@"
