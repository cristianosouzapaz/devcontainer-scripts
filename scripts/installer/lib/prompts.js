import chalk from "chalk";
import { checkbox, select, Separator } from "@inquirer/prompts";
import { TOOLS } from "./constants.js";
import { PROMPT_THEME, sectionHeader } from "./theme.js";

/**
 * @fileoverview Selection-prompt helpers shared by the installer sub-commands: the plain-text
 * confirmation summary, the edit-until-confirmed loop, target-tool selection, and the small
 * formatters that annotate picker rows. The catalog pickers themselves live in `pick-assets.js`.
 */

const CLEAR_ON_DONE = { clearPromptOnDone: true };

/**
 * Format the review shown before an installer proceeds: a section rule, then one block per
 * non-empty section — a bold title with a dim count, and its items indented one per line.
 * A `note` section (nothing is written for it, e.g. assets already installed globally) is
 * rendered dim throughout so it reads as context rather than an action.
 * @param {{title: string, items: string[], note?: boolean}[]} sections
 * @returns {string}
 */
export const formatSelectionSummary = (sections) => {
    const block = ({ title, items, note }) => {
        const heading = note
            ? chalk.dim(`${title} · ${items.length}`)
            : `${chalk.bold(title)}${chalk.dim(` · ${items.length}`)}`;
        return [heading, ...items.map((item) => (note ? chalk.dim(`  ${item}`) : `  ${item}`))];
    };
    return [
        sectionHeader("Selection"),
        " ",
        ...sections
            .filter(({ items }) => items.length > 0)
            .flatMap((section, index) => [...(index > 0 ? [" "] : []), ...block(section)]),
    ].join("\n");
};

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
        // Keep the readline message single-line. Multiline messages confuse Inquirer's
        // cursor accounting when this prompt is reopened after "Continue editing selection".
        message: "What would you like to do?",
        choices: [
            // Separators render the summary as part of the prompt screen without becoming
            // selectable rows, so the edit loop can redraw it without leaving stale lines.
            blank(),
            ...summaryLines.map((line) => new Separator(line)),
            blank(),
            { name: installLabel, value: "install" },
            { name: "Continue editing selection", value: "edit" },
            { name: "Cancel", value: "cancel" },
        ],
        pageSize: summaryLines.length + 5,
        theme: PROMPT_THEME,
    }, CLEAR_ON_DONE);
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
 * Prompt for one or more coding agents. Callers route on the returned set rather than
 * branching on every combination, so adding an agent needs no new branches here.
 * @returns {Promise<string[]>} Selected values from `TOOLS`.
 * @throws {Error} If the interactive prompt cannot complete.
 * @effects Presents an interactive checkbox prompt on the current terminal.
 */
export const selectTargetTools = () => checkbox({
    message: "Select target tool(s):",
    choices: [
        { name: "GitHub Copilot", value: TOOLS.copilot },
        { name: "Claude Code", value: TOOLS.claude },
        { name: "Codex", value: TOOLS.codex },
    ],
    validate: (selected) => selected.length > 0 || "Select at least one coding agent.",
    theme: PROMPT_THEME,
}, CLEAR_ON_DONE);
