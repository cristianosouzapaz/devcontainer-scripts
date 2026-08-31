import { checkbox, Separator } from "@inquirer/prompts";
import chalk from "chalk";

/**
 * @fileoverview Stable multi-select prompt shared by installer sub-installers.
 * Search is intentionally omitted: the official Inquirer checkbox is used directly.
 */

const CLEAR_ON_DONE = { clearPromptOnDone: true };

const formatChoice = (choice) => ({
    ...choice,
    name: `${choice.name}${choice.annotation ? ` ${choice.annotation}` : ""}`,
    disabled: choice.disabled === "installed globally" ? "(installed globally)" : choice.disabled,
});

const groupHeader = (group) => {
    const prefix = `── ${group} `;
    // `Separator` itself adds a leading cell; cap the rule for a compact header and leave
    // enough terminal margin that it cannot wrap onto a stray trailing dash.
    const width = Math.min(64, Math.max(32, (process.stdout.columns ?? 80) - 4));
    return `${chalk.dim("── ")}${chalk.bold(chalk.cyan(group))}${chalk.dim(` ${"─".repeat(Math.max(1, width - prefix.length))}`)}`;
};

const groupChoices = (choices) => choices.flatMap((choice, index) => [
    ...(choice.group !== choices[index - 1]?.group ? [new Separator(groupHeader(choice.group))] : []),
    formatChoice(choice),
]);

/**
 * Select one or more installer assets with the official Inquirer checkbox prompt.
 * @param {object} config
 * @param {string} config.message - Prompt heading.
 * @param {{name: string, value: unknown, annotation?: string, group?: string, disabled?: string, checked?: boolean}[]} config.choices
 * @param {boolean} [config.grouped] - Add category separators for grouped choices.
 * @param {number} [config.pageSize]
 * @param {object} [context] - Optional Inquirer runtime context, used by tests.
 * @returns {Promise<unknown[]>} The selected values.
 */
export const pickAssets = ({ message, choices, grouped = false, pageSize = 14 }, context) => checkbox({
    message,
    pageSize,
    choices: grouped ? groupChoices(choices) : choices.map(formatChoice),
    default: choices.filter((choice) => choice.checked && !choice.disabled).map((choice) => choice.value),
    theme: { prefix: chalk.cyan("◆") },
}, { ...CLEAR_ON_DONE, ...context });
