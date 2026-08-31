/**
 * @fileoverview Identifiers shared across every installer sub-command.
 */

/** Agent identifiers understood by the external `skills` CLI. */
export const AGENTS = {
    copilot: "github-copilot",
    claude: "claude-code",
    codex: "codex",
};

/** Logical coding-agent targets installers route generated output to. */
export const TOOLS = {
    copilot: "copilot",
    claude: "claude",
    codex: "codex",
};
