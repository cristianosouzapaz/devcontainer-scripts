import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { select } from "@inquirer/prompts";
import { PROMPT_THEME } from "./lib/theme.js";

/**
 * @fileoverview The small interactive boundary for devcontainer-data. Bash owns the
 * persistent-data operations; this module only asks a human to choose an action, category,
 * or confirmation and returns that choice through file descriptor 3.
 */

const PROMPT_OPTIONS = { clearPromptOnDone: true };

export const DATA_ACTION_CHOICES = [
    { name: "List categories", value: "list" },
    { name: "Status", value: "status" },
    { name: "Show path", value: "path" },
    { name: "Reset data", value: "reset" },
    { name: "Repair managed links", value: "repair" },
    { name: "Quit", value: "quit" },
];

/**
 * @param {unknown} _config
 * @param {Record<string, unknown>} [context]
 * @returns {Promise<string>}
 */
export const selectDataAction = (_config, context) => select({
    message: "Select an action",
    choices: DATA_ACTION_CHOICES,
    theme: PROMPT_THEME,
}, { ...context, ...PROMPT_OPTIONS });

/**
 * @param {string[]} categoryIds
 * @param {Record<string, unknown>} [context]
 * @returns {Promise<string>}
 */
export const selectDataCategory = (categoryIds, context) => select({
    message: "Select a category",
    choices: [
        ...categoryIds.map((id) => ({ name: id, value: id })),
        { name: "Go back", value: "" },
    ],
    theme: PROMPT_THEME,
}, { ...context, ...PROMPT_OPTIONS });

/**
 * @param {string} categoryId
 * @param {Record<string, unknown>} [context]
 * @returns {Promise<string>}
 */
export const confirmDataReset = (categoryId, context) => select({
    message: `Reset all data in '${categoryId}'?`,
    choices: [
        { name: "Yes, reset it", value: "yes" },
        { name: "No, cancel", value: "no" },
    ],
    theme: PROMPT_THEME,
}, { ...context, ...PROMPT_OPTIONS });

const writeResult = (value) => writeFileSync(3, `${value}\n`);

const isCancelled = (error) => error?.name === "CancelPromptError" ||
    error?.message?.includes("User force closed the prompt");

const main = async () => {
    const [operation, ...args] = process.argv.slice(2);
    let result;
    switch (operation) {
        case "menu":
            result = await selectDataAction();
            break;
        case "category":
            result = await selectDataCategory(args);
            break;
        case "confirm-reset":
            if (args.length !== 1) throw new Error("confirm-reset requires a category id");
            result = await confirmDataReset(args[0]);
            break;
        default:
            throw new Error(`Unknown data UI operation: ${operation || "(missing)"}`);
    }
    writeResult(result);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        await main();
    } catch (error) {
        if (!isCancelled(error)) {
            console.error(error instanceof Error ? error.message : error);
            process.exitCode = 1;
        }
    }
}
