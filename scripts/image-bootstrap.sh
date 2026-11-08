#!/bin/bash
set -euo pipefail

# Seeds the image from the scripts repository checkout the Dockerfile fetched with ADD from git:
# installs the scripts tree, seeds its first installer release at the checkout's commit, puts
# the bin/ commands on PATH and seeds the project schema marker from the tree's own layout
# version, so a freshly created project volume already carries it. It lives in the scripts
# tree, not the Dockerfile, so a fix reaches every project through the published scripts
# instead of each project's frozen Dockerfile copy.
# Usage: image-bootstrap.sh <checkout>   (the checkout keeps its .git, from --keep-git-dir)
# IMAGE_BOOTSTRAP_SCRIPTS_ROOT, IMAGE_BOOTSTRAP_BIN_DIR and IMAGE_BOOTSTRAP_METADATA_DIR override
# /opt/devcontainer, /usr/local/bin and /workspace/.metadata, only so the tests can run it under
# a temp dir.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

BOOTSTRAP_LIB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/setup/lib" && pwd)"
source "$BOOTSTRAP_LIB_DIR/loader.sh"

# ----- FUNCTIONS --------------------------------------------------------------

# main <checkout>: moves the checkout's scripts tree into place, seeds its installer release at the checkout's commit, links the bin/ commands and seeds the project schema marker
main() {
	local checkout="${1:?Usage: image-bootstrap.sh <checkout>}" sha=""
	local scripts_root="${IMAGE_BOOTSTRAP_SCRIPTS_ROOT:-/opt/devcontainer}"
	local bin_dir="${IMAGE_BOOTSTRAP_BIN_DIR:-/usr/local/bin}"
	local metadata_dir="${IMAGE_BOOTSTRAP_METADATA_DIR:-/workspace/.metadata}"
	# why: BuildKit leaves a detached HEAD holding the resolved commit, and the image has no git
	[[ -f "$checkout/.git/HEAD" ]] && sha="$(<"$checkout/.git/HEAD")"
	[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || log_fatal "The scripts checkout at $checkout has no commit SHA in .git/HEAD"
	rm -rf -- "$checkout/.git"
	mv -- "$checkout/scripts" "$scripts_root"
	# why: the installer stages from the tree BuildKit already fetched and verified by its SHA, instead of downloading the same commit again
	SCRIPTS_REF="$sha" _INSTALLER_SOURCE_DIR="$scripts_root" bash "$scripts_root/installer/install.sh" \
		|| log_fatal "Could not seed the installer release for $sha"
	find "$scripts_root" -name "*.sh" -exec chmod +x {} +
	chmod +x "$scripts_root"/bin/*
	# why: links, not copies: a bin/ script finds its library through readlink -f of its own path
	ln -sf "$scripts_root"/bin/* "$bin_dir/"
	mkdir -p -- "$metadata_dir"
	atomic_write "$metadata_dir/.schema-version" cat -- "$scripts_root/setup/lib/persistent-data/layout-version" \
		|| log_fatal "Could not seed the project schema marker in $metadata_dir"
	rm -rf -- "$checkout"
	log_success "Installed the scripts tree at $scripts_root from commit $sha"
}

main "$@"
