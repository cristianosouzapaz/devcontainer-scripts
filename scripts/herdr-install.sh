#!/bin/bash
set -euo pipefail

# Installs the herdr release binary for this machine, verified against the sha256 digest GitHub
# publishes for the asset. The image build and the Bash test runner both run it, so they install
# herdr the same way. Safe to re-run: it replaces the binary with the verified release.
# Usage: herdr-install.sh [target]   (default /usr/local/lib/herdr/herdr)
# HERDR_VERSION pins a release tag; empty takes the latest release.
# GITHUB_TOKEN, when set, authenticates the release lookup, so a shared CI runner is not held
# to GitHub's per-address limit for anonymous API calls.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

BOOTSTRAP_LIB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/setup/lib" && pwd)"
source "$BOOTSTRAP_LIB_DIR/loader.sh"

# why: the EXIT trap runs after main returns, when its locals are gone
WORK_DIR=""
trap 'rm -rf -- "$WORK_DIR"' EXIT

# ----- FUNCTIONS --------------------------------------------------------------

# herdr_asset_name: prints the release asset name for this machine's architecture
herdr_asset_name() {
	case "$(uname -m)" in
	x86_64) printf '%s\n' herdr-linux-x86_64 ;;
	aarch64 | arm64) printf '%s\n' herdr-linux-aarch64 ;;
	*) return 1 ;;
	esac
}

# main [target]: downloads the release asset, checks its digest and replaces the target with it
main() {
	local target="${1:-/usr/local/lib/herdr/herdr}" release_url asset url digest
	local -a auth=()
	asset="$(herdr_asset_name)" || log_fatal "No herdr release asset for architecture $(uname -m)"
	release_url='https://api.github.com/repos/herdrdev/herdr/releases/latest'
	if [[ -n "${HERDR_VERSION:-}" ]]; then
		release_url="https://api.github.com/repos/herdrdev/herdr/releases/tags/${HERDR_VERSION}"
	fi
	if [[ -n "${GITHUB_TOKEN:-}" ]]; then
		auth=(--header "Authorization: Bearer ${GITHUB_TOKEN}")
	fi
	WORK_DIR="$(mktemp -d)"
	curl --fail --location --silent --show-error "${auth[@]}" "$release_url" --output "$WORK_DIR/release.json" \
		|| log_fatal "Could not read the herdr release: $release_url"
	url="$(jq -r --arg asset "$asset" '.assets[] | select(.name == $asset) | .browser_download_url' "$WORK_DIR/release.json")"
	digest="$(jq -r --arg asset "$asset" '.assets[] | select(.name == $asset) | .digest' "$WORK_DIR/release.json")"
	[[ -n "$url" && "$url" != null ]] || log_fatal "The herdr release has no $asset asset"
	[[ "$digest" == sha256:* ]] || log_fatal "The herdr release publishes no sha256 digest for $asset"
	curl --fail --location --silent --show-error "$url" --output "$WORK_DIR/herdr" || log_fatal "Could not download $url"
	printf '%s  %s\n' "${digest#sha256:}" "$WORK_DIR/herdr" | sha256sum --check --status \
		|| log_fatal "The downloaded $asset does not match its published digest"
	mkdir -p -- "$(dirname -- "$target")"
	atomic_write "$target" cat "$WORK_DIR/herdr" || log_fatal "Could not install herdr at $target"
	chmod 0755 "$target"
	log_success "Installed herdr at $target"
}

main "$@"
