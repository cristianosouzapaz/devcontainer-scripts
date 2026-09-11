# devcontainer-herdr-xdg-reset: marker line, matched verbatim by
# herdr_reset_xdg_config_home for idempotency — do not reword it.
# The herdr wrapper (public/scripts/bin/herdr) narrows XDG_CONFIG_HOME to the
# per-project Herdr directory before exec'ing the herdr server. Every pane the
# server spawns afterwards inherits that value via ordinary process env
# inheritance, which makes XDG-aware tools (gh, etc.) run inside a pane
# misresolve their config. Reset it back to unset here so interactive shells
# started inside a Herdr pane see the real, shared config again.
if [[ "${XDG_CONFIG_HOME:-}" == "/workspace/.config" ]]; then
	unset XDG_CONFIG_HOME
fi
