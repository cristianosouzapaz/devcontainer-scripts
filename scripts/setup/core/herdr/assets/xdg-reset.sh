# shellcheck shell=bash
# devcontainer-herdr-xdg-reset: unsets the XDG_CONFIG_HOME a Herdr pane inherits from
# the herdr wrapper, so XDG-aware tools in the pane resolve the shared config again.
# The first word is the marker herdr_reset_xdg_config_home greps for: keep it verbatim.
if [[ "${XDG_CONFIG_HOME:-}" == "/workspace/.config" ]]; then
	unset XDG_CONFIG_HOME
fi
