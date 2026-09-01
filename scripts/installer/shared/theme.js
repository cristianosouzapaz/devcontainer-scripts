import chalk from "chalk";

/**
 * @fileoverview Shared theming for the installer's interactive prompts, so every screen —
 * the catalog pickers, the confirmation prompt, the target-tool prompt, and the file-conflict
 * prompt — opens with the same marker and shows the same footer instead of Inquirer's
 * per-prompt defaults.
 */

/**
 * Format a prompt's key-hint footer: `bold key` + `dim label`, joined by a dim bullet.
 * Inquirer's built-in `select` labels the confirm key `select` while `checkbox` labels it
 * `submit`; both are normalised to `submit` here so every installer footer reads the same.
 * @param {[string, string][]} keys - `[key, label]` pairs.
 * @returns {string}
 */
const keysHelpTip = (keys) => keys
    .map(([key, label]) => `${chalk.bold(key)} ${chalk.dim(key === "⏎" ? "submit" : label)}`)
    .join(chalk.dim(" • "));

/** Inquirer theme applied to every installer prompt. */
export const PROMPT_THEME = {
    prefix: chalk.cyan("◆"),
    style: { keysHelpTip },
};

/**
 * A dim rule with a bold label, e.g. `── Selection ──────`. Shared by the catalog pickers'
 * category dividers and the confirmation summary so section headers match on every screen.
 * The trailing rule is a fixed short length so it reads as a divider without sprawling or
 * wrapping.
 * @param {string} label
 * @returns {string}
 */
export const sectionHeader = (label) => {
    const dashes = "─".repeat(Math.max(6, 34 - `── ${label} `.length));
    return `${chalk.dim("── ")}${chalk.bold(chalk.cyan(label))}${chalk.dim(` ${dashes}`)}`;
};
