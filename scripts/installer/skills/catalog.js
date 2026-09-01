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
 * Assert that a caller supplied an array of catalog entries with own category strings.
 * @param {unknown} entries - Candidate third-party skill catalog entries.
 * @returns {asserts entries is { category: string }[]}
 * @throws {TypeError} If an entry is not a usable catalog object.
 */
const assertSkillEntries = (entries) => {
    if (!Array.isArray(entries)) throw new TypeError("Skill entries must be an array.");
    for (const entry of entries) {
        if (entry === null || typeof entry !== "object"
            || !Object.hasOwn(entry, "category") || typeof entry.category !== "string") {
            throw new TypeError("Each skill entry must contain an own string category field.");
        }
    }
};

/**
 * Assert that a caller supplied a set of installed skill names.
 * @param {unknown} skills - Candidate installed skill set.
 * @param {string} label - Name used in the validation error.
 * @returns {asserts skills is Set<string>} Nothing.
 * @throws {TypeError} If the value is not a set of strings.
 */
const assertSkillSet = (skills, label) => {
    if (!(skills instanceof Set) || [...skills].some((skill) => typeof skill !== "string")) {
        throw new TypeError(`${label} must be a set of strings.`);
    }
};

/**
 * Assert that a caller supplied a map of installed machine-wide skill names.
 * @param {unknown} skills - Candidate installed machine-wide skill map.
 * @returns {asserts skills is Map<string, unknown>} Nothing.
 * @throws {TypeError} If the value is not a map with string keys.
 */
const assertGlobalSkillMap = (skills) => {
    if (!(skills instanceof Map) || [...skills.keys()].some((skill) => typeof skill !== "string")) {
        throw new TypeError("Global skills must be a map with string keys.");
    }
};

/**
 * Return whether an error is the expected absent-file failure.
 * @param {unknown} error - Error thrown while reading a local lock file.
 * @returns {boolean} True only for an ENOENT filesystem error.
 */
const isMissingFileError = (error) => error instanceof Error
    && Object.hasOwn(error, "code") && error.code === "ENOENT";

/**
 * Group skill entries by category while retaining each category's catalog order.
 * @param {object[]} entries - Validated skill catalog entries.
 * @returns {Map<string, object[]>} Entries keyed by category.
 */
export const groupByCategory = (entries) => {
    assertSkillEntries(entries);
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
 * @returns {Set<string>} Installed third-party skill names, or an empty set when the lock is
 *   absent or invalid.
 * @throws {TypeError} If projectRoot is not a non-empty string.
 * @throws {Error} If reading the lock fails for a reason other than a missing file.
 */
export const readProjectSkillSet = (projectRoot = process.cwd()) => {
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
        throw new TypeError("Project root must be a non-empty string.");
    }
    try {
        const lock = JSON.parse(readFileSync(join(projectRoot, "skills-lock.json"), "utf8"));
        if (lock === null || typeof lock !== "object" || !Object.hasOwn(lock, "skills")) return new Set();
        const { skills } = lock;
        if (skills === null || typeof skills !== "object" || Array.isArray(skills)) return new Set();
        return new Set(Object.keys(skills).filter((name) => name.length > 0));
    } catch (error) {
        if (isMissingFileError(error) || error instanceof SyntaxError) return new Set();
        throw error;
    }
};

/**
 * Convert catalogue entries to picker choices, retaining category order and project state.
 * @param {object[]} skills - Validated skill catalog entries.
 * @param {Map<string, unknown>} globalSet - Skills already installed machine-wide.
 * @param {Set<string>} projectSet - Skills already installed in this project.
 * @returns {object[]} Picker choices.
 * @throws {TypeError} If a supplied collection or skill entry is malformed.
 */
export const buildSkillChoices = (skills, globalSet, projectSet) =>
    {
        assertSkillEntries(skills);
        for (const entry of skills) {
            if (!Object.hasOwn(entry, "name") || typeof entry.name !== "string"
                || !Object.hasOwn(entry, "skill") || typeof entry.skill !== "string"
                || !Object.hasOwn(entry, "description") || typeof entry.description !== "string") {
                throw new TypeError("Each picker skill must contain own string name, skill, and description fields.");
            }
        }
        assertGlobalSkillMap(globalSet);
        assertSkillSet(projectSet, "Project skills");
        return [...groupByCategory(skills).entries()].flatMap(([group, entries]) =>
        entries.map((entry) => ({
            name: entry.name,
            value: entry,
            description: entry.description,
            group,
            tags: entry.tags,
            annotation: !globalSet.has(entry.skill) && projectSet.has(entry.skill) ? "(installed)" : undefined,
            disabled: globalSet.has(entry.skill) && "installed globally",
        })));
    };
