import chalk from "chalk";
import { checkbox, select, Separator } from "@inquirer/prompts";
import { copilotTarget } from "./constants.js";
import { formatSelectionSummary } from "./selection-summary.js";
import { promptTheme } from "./theme.js";

/**
 * @fileoverview Selection-prompt helpers shared by the installer sub-commands: the
 * edit-until-confirmed loop, target-tool selection, and the small formatters that annotate
 * picker rows. The summary text lives in `selection-summary.js`; the catalog pickers
 * themselves live in `pick-assets.js`.
 */

const clearOnDone = { clearPromptOnDone: true };

/**
 * Show a selection summary and ask whether to install, edit, or cancel it. The summary lives
 * in the prompt `message` (not a `consola.log`) so `clearPromptOnDone` clears it and the edit
 * loop never stacks boxes in the scrollback.
 * @param {{title: string, items: string[]}[]} sections
 * @param {string} installLabel
 * @returns {Promise<"install"|"edit"|"cancel">}
 * @throws {Error} If the interactive prompt cannot complete.
 * @effects Presents an interactive confirmation prompt on the current terminal.
 */
const confirmSelection = async (sections, installLabel = "Install selected assets") => {
    const summaryLines = formatSelectionSummary(sections).split("\n");
    const blank = () => new Separator(" ");
    return select({
        // why: a multiline message confuses Inquirer's cursor accounting when this prompt reopens after "Continue editing selection".
        message: "What would you like to do?",
        choices: [
            // why: separators show the summary on the prompt screen without selectable rows, so the edit loop redraws it without stale lines.
            blank(),
            ...summaryLines.map((line) => new Separator(line)),
            blank(),
            { name: installLabel, value: "install" },
            { name: "Continue editing selection", value: "edit" },
            { name: "Cancel", value: "cancel" },
        ],
        pageSize: summaryLines.length + 5,
        theme: promptTheme,
    }, clearOnDone);
};

/**
 * Repeat a selection and confirmation until the user installs or cancels. Returns undefined
 * for an empty selection and null for an explicit cancellation. On "Continue editing", the
 * previous selection is handed back to `selectSelection` so the picker can re-check it (see
 * `restoreChecked`) instead of reopening blank.
 * @param {(previous: unknown) => Promise<unknown>} selectSelection - Opens the asset picker;
 *   receives the prior round's selection, or undefined on the first pass.
 * @param {(selection: unknown) => {title: string, items: string[]}[]} buildSections
 * @param {string} installLabel
 * @param {(selection: unknown) => boolean} [isEmpty]
 * @param {unknown} [previous] - The prior round's selection, handed to `selectSelection`; undefined on the first pass.
 * @returns {Promise<unknown|null|undefined>}
 * @throws {Error} If a picker or confirmation prompt fails.
 * @effects Repeatedly presents the supplied picker and confirmation prompts on the current terminal.
 */
export const selectUntilConfirmed = async (selectSelection, buildSections, installLabel, isEmpty = (selection) => selection.length === 0, previous = undefined) => {
    const selection = await selectSelection(previous);
    if (isEmpty(selection)) return undefined;

    const action = await confirmSelection(buildSections(selection), installLabel);
    if (action === "install") return selection;
    if (action === "cancel") return null;
    return selectUntilConfirmed(selectSelection, buildSections, installLabel, isEmpty, selection);
};

/**
 * Return a copy of checkbox `choices` with `checked: true` on every entry whose `value` is in
 * `selectedValues` (by reference), leaving disabled rows untouched. `pickAssets` has
 * no top-level `default`, so per-choice `checked` is the only way to restore prior picks when
 * a picker is reopened.
 * @param {object[]} choices
 * @param {Iterable<unknown>} selectedValues
 * @returns {object[]}
 */
export const restoreChecked = (choices, selectedValues = []) => {
    const chosen = new Set(selectedValues);
    return choices.map((choice) =>
        choice.disabled ? choice : { ...choice, checked: chosen.has(choice.value) });
};

/**
 * Row annotation for a version-tracked asset: nothing when it isn't installed in the project
 * (you'd install the current version anyway), `(installed)` when it's current, and
 * `(old → new)` only when an update is available — the one case the number carries a decision.
 * @param {string|null} installedVersion - Version installed in the project, or null.
 * @param {string} version - The catalog entry's current version.
 * @returns {string}
 */
export const formatVersionHint = (installedVersion, version) => {
    if (!installedVersion) return "";
    if (installedVersion === version) return chalk.dim("(installed)");
    return chalk.dim(`(${installedVersion} → ${version})`);
};

/**
 * Prompt for one or more coding agents: GitHub Copilot, then every coding-agent pack. Callers
 * route on the returned ids and each pack's exposures rather than on agent names, so adding a
 * pack needs no code here.
 * @param {{ id: string, label: string }[]} packs - Loaded coding-agent packs.
 * @returns {Promise<string[]>} Selected target ids: `copilotTarget.id` or pack ids.
 * @throws {Error} If the interactive prompt cannot complete.
 * @effects Presents an interactive checkbox prompt on the current terminal.
 */
export const selectTargetTools = (packs) => checkbox({
    message: "Select target tool(s):",
    choices: [copilotTarget, ...packs].map(({ id, label }) => ({ name: label, value: id })),
    validate: (selected) => selected.length > 0 || "Select at least one coding agent.",
    theme: promptTheme,
}, clearOnDone);
