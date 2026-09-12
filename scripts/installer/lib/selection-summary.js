import chalk from "chalk";
import { sectionHeader } from "./theme.js";

/**
 * @fileoverview Plain-text rendering of the selection summary an installer shows before it
 * proceeds.
 */

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
