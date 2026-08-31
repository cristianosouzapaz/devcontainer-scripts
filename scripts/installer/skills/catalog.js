import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @fileoverview Presentation-independent helpers for the third-party skills catalog.
 */

/**
 * Display order for skill categories. Categories not listed here are appended after these,
 * in the order first encountered in the catalog.
 */
const CATEGORY_ORDER = [
    "Planning & Workflow",
    "Design & Frontend",
    "Framework (Next.js/Vercel)",
    "Code Quality",
    "Security",
    "Automation",
    "Discovery & Tooling",
    "Productivity & Communication",
    "Bundles",
];

/**
 * Group skill entries by category while retaining each category's catalog order.
 * @param {object[]} entries - Validated skill catalog entries.
 * @returns {Map<string, object[]>} Entries keyed by category.
 */
export const groupByCategory = (entries) => {
    const groups = new Map();
    for (const entry of entries) {
        if (!groups.has(entry.category)) groups.set(entry.category, []);
        groups.get(entry.category).push(entry);
    }

    return new Map(
        [...groups.entries()].sort(([a], [b]) => {
            const rankA = CATEGORY_ORDER.includes(a) ? CATEGORY_ORDER.indexOf(a) : CATEGORY_ORDER.length;
            const rankB = CATEGORY_ORDER.includes(b) ? CATEGORY_ORDER.indexOf(b) : CATEGORY_ORDER.length;
            return rankA - rankB;
        }),
    );
};

/**
 * Read the names installed by the external skills CLI in a project. Skills have no template
 * versions, so only their presence is relevant to the interactive picker.
 * @param {string} [projectRoot] - Project containing `skills-lock.json`.
 * @returns {Set<string>} Installed third-party skill names.
 */
export const readProjectSkillSet = (projectRoot = process.cwd()) => {
    try {
        const lock = JSON.parse(readFileSync(join(projectRoot, "skills-lock.json"), "utf8"));
        return new Set(Object.keys(lock?.skills ?? {}).filter((name) => typeof name === "string" && name.length > 0));
    } catch {
        return new Set();
    }
};

/**
 * Convert catalogue entries to picker choices, retaining category order and project state.
 * @param {object[]} skills - Validated skill catalog entries.
 * @param {Map<string, unknown>} globalSet - Skills already installed machine-wide.
 * @param {Set<string>} projectSet - Skills already installed in this project.
 * @returns {object[]} Picker choices.
 */
export const buildSkillChoices = (skills, globalSet, projectSet) =>
    [...groupByCategory(skills).entries()].flatMap(([group, entries]) =>
        entries.map((entry) => ({
            name: entry.name,
            value: entry,
            description: entry.description,
            group,
            annotation: !globalSet.has(entry.skill) && projectSet.has(entry.skill) ? "(installed)" : undefined,
            disabled: globalSet.has(entry.skill) && "installed globally",
        })));
