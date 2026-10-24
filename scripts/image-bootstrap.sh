#!/bin/bash
set -euo pipefail

# Seeds the image from the scripts repository checkout the Dockerfile fetched with ADD from git:
# installs the scripts tree, seeds its first installer release at the checkout's commit and puts
# the bin/ commands on PATH. It lives in the scripts tree, not the Dockerfile, so a fix reaches
# every project through the published scripts instead of each project's frozen Dockerfile copy.
# Usage: image-bootstrap.sh <checkout>   (the checkout keeps its .git, from --keep-git-dir)
# IMAGE_BOOTSTRAP_SCRIPTS_ROOT and IMAGE_BOOTSTRAP_BIN_DIR override /opt/devcontainer and
# /usr/local/bin, only so the tests can run it under a temp dir.

# ----- SHARED UTILITIES LOADING -----------------------------------------------

BOOTSTRAP_LIB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/setup/lib" && pwd)"
source "$BOOTSTRAP_LIB_DIR/loader.sh"

# ----- FUNCTIONS --------------------------------------------------------------

# main <checkout>: moves the checkout's scripts tree into place, seeds its installer release at the checkout's commit and installs the bin/ commands
main() {
	local checkout="${1:?Usage: image-bootstrap.sh <checkout>}" sha=""
	local scripts_root="${IMAGE_BOOTSTRAP_SCRIPTS_ROOT:-/opt/devcontainer}"
	local bin_dir="${IMAGE_BOOTSTRAP_BIN_DIR:-/usr/local/bin}"
	# why: BuildKit leaves a detached HEAD holding the resolved commit, and the image has no git
	[[ -f "$checkout/.git/HEAD" ]] && sha="$(<"$checkout/.git/HEAD")"
	[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || log_fatal "The scripts checkout at $checkout has no commit SHA in .git/HEAD"
	rm -rf -- "$checkout/.git"
	mv -- "$checkout/scripts" "$scripts_root"
	SCRIPTS_REF="$sha" bash "$scripts_root/installer/install.sh" \
		|| log_fatal "Could not seed the installer release for $sha"
	find "$scripts_root" -name "*.sh" -exec chmod +x {} +
	chmod +x "$scripts_root"/bin/*
	install -m 0755 "$scripts_root"/bin/* "$bin_dir/"
	ln -sf "$scripts_root/bin/devcontainer-data" "$bin_dir/devcontainer-data"
	ln -sf "$scripts_root/bin/devcontainer-install" "$bin_dir/devcontainer-install"
	rm -rf -- "$checkout"
	log_success "Installed the scripts tree at $scripts_root from commit $sha"
}

main "$@"
