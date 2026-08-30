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
