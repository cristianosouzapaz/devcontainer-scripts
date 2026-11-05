# shellcheck shell=bash
# devcontainer-browser-env: points BROWSER at the stable devcontainer-browser wrapper. VS Code
# sets BROWSER to a helper of its current commit when it starts a terminal; this runs after
# that, so the shell and everything it starts survive a VS Code reconnect or update.
# The first word is the marker browser_setup greps for: keep it verbatim.
export BROWSER=/usr/local/bin/devcontainer-browser
