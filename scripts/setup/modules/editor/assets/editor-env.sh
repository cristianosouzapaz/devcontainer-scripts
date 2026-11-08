# shellcheck shell=bash
# devcontainer-editor-env: points BROWSER at devcontainer-browser and the code command at
# devcontainer-editor. VS Code sets BROWSER and puts its commit-bound remote CLI first on PATH when
# it starts a terminal; this runs after that, and a function wins over PATH and is exported to
# every Bash process the shell starts, so they survive a VS Code reconnect or update. EDITOR,
# VISUAL and GIT_EDITOR stay unset on purpose: a git commit or rebase run by an agent would
# otherwise wait on the editor forever.
# The first word is the marker editor_setup greps for: keep it verbatim.
export BROWSER=/usr/local/bin/devcontainer-browser

# code <arg...>: opens files in the live editor connection, with the arguments code takes
code() {
	/usr/local/bin/devcontainer-editor "$@"
}
export -f code
