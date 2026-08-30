import { execFileSync } from "node:child_process";
import { checkbox, select } from "@inquirer/prompts";
import consola from "consola";
import { AGENTS, CLEAR_ON_DONE, confirmSelection, handleError, loadJsonCatalog, selectTargetTools, setupConsola, TOOLS } from "../shared/utils.js";
import { groupByCategory } from "./catalog.js";
import { ensureClaudeSkillSymlink } from "./local/index.js";

/**
 * @fileoverview Interactive installer for third-party Agent Skills.
 *
 * Third-party skills are always installed once into the canonical `.agents/skills`
 * directory through the Codex target. GitHub Copilot discovers that directory directly.
 * Claude Code receives selective symlinks under `.claude/skills` when selected. The external
 * skills CLI owns source and integrity tracking in skills-lock.json.
 *
 * Installed at /opt/devcontainer/installer/skills/ inside the container.
 */

setupConsola();

// ─── Constants ───────────────────────────────────────────────────────────────

const SKILLS_FILE_URL = new URL("./skills.json", import.meta.url);

const FINISH_SELECTION = "finish-selection";

// ─── Functions ───────────────────────────────────────────────────────────────

/**
 * Load and validate the skills catalog from skills.json.
 * @returns {object[]} An array of skill entries.
 * @throws Will throw an error if the catalog is invalid or cannot be read.
 */
const loadSkillsCatalog = () => {
    const entries = loadJsonCatalog(SKILLS_FILE_URL);

    for (const [index, entry] of entries.entries()) {
        const isValidEntry =
            typeof entry?.name === "string"
            && typeof entry?.skill === "string"
            && typeof entry?.category === "string"
            && entry.category.length > 0
            && typeof entry?.description === "string"
            && entry.description.length > 0
            && typeof entry?.url === "string"
            && Array.isArray(entry?.tags)
            && entry.tags.every((tag) => typeof tag === "string")
            && (entry?.requires === undefined
                || (Array.isArray(entry.requires) && entry.requires.every((dep) => typeof dep === "string")));

        if (!isValidEntry) throw new Error(`Invalid skills catalog entry at index ${index}.`);
    }

    return entries;
};

const formatCategory = (category) => `── ${category} ──`;

/**
 * Interactively select skills one compact category at a time. This keeps every checkbox
 * prompt visible without relying on an internal scrolling list as the catalog grows.
 * @param {Map<string, object[]>} groups - Validated catalog entries grouped by category.
 * @returns {Promise<object[]|null>} Selected entries, or null when the user cancels.
 */
const selectSkillsByCategory = async (groups) => {
    const selectedSkills = new Set();
    const categories = [...groups.entries()];

    while (true) {
        const category = await select({
            message: "Choose a skill category:",
            choices: [
                ...categories.map(([name, entries]) => {
                    const selectedCount = entries.filter((entry) => selectedSkills.has(entry)).length;
                    return {
                        name: `${formatCategory(name)} (${selectedCount}/${entries.length} selected)`,
                        value: name,
                    };
                }),
                {
                    name: selectedSkills.size === 0
                        ? "Finish without selecting skills"
                        : `Review ${selectedSkills.size} selected skill${selectedSkills.size === 1 ? "" : "s"}`,
                    value: FINISH_SELECTION,
                },
            ],
            pageSize: categories.length + 1,
        }, CLEAR_ON_DONE);

        if (category === FINISH_SELECTION) {
            if (selectedSkills.size === 0) return [];

            const automaticDependencies = new Map();
            for (const entry of selectedSkills) {
                for (const dependency of entry.requires ?? []) {
                    if ([...selectedSkills].some(({ skill }) => skill === dependency)) continue;
                    const requiredBy = automaticDependencies.get(dependency) ?? [];
                    requiredBy.push(entry.name);
                    automaticDependencies.set(dependency, requiredBy);
                }
            }
            const action = await confirmSelection([
                { title: "Skills", items: [...selectedSkills].map(({ name }) => name) },
                {
                    title: "Automatically included",
                    items: [...automaticDependencies].map(([dependency, requiredBy]) =>
                        `${dependency} (required by ${requiredBy.join(", ")})`),
                },
            ], "Install selected skills");

            if (action === "install") return [...selectedSkills];
            if (action === "cancel") return null;
            continue;
        }

        const entries = groups.get(category);
        const selectedInCategory = await checkbox({
            message: formatCategory(category),
            choices: entries.map((entry) => ({
                name: entry.name,
                value: entry,
                description: entry.description,
            })),
            default: entries.filter((entry) => selectedSkills.has(entry)),
            pageSize: entries.length,
        }, CLEAR_ON_DONE);

        for (const entry of entries) selectedSkills.delete(entry);
        for (const entry of selectedInCategory) selectedSkills.add(entry);
    }
};

/**
 * Install a skill into the canonical Agent Skills location.
 * @param {string} url - The URL of the skill repository.
 * @param {string} skill - The skill identifier.
 * @throws Will throw an error if the installation fails.
 */
const installCanonicalSkill = (url, skill) => execFileSync("npx", ["skills", "add", url, "--skill", skill, "--agent", AGENTS.codex, "--yes"], {
    stdio: "pipe",
});

/**
 * Prompt the user to select skills to install.
 * @async
 */
const askUser = async () => {
    try {
        const skills = loadSkillsCatalog();

        const selectedSkills = await selectSkillsByCategory(groupByCategory(skills));

        if (!selectedSkills || selectedSkills.length === 0) {
            consola.info("No skills selected.");
            return;
        }

        const selectedTools = await selectTargetTools();
        for (const { url, skill, requires = [] } of selectedSkills) {
            consola.start(`Installing ${skill}`);
            try {
                installCanonicalSkill(url, skill);
                for (const dependency of requires) installCanonicalSkill(url, dependency);
                if (selectedTools.includes(TOOLS.claude)) {
                    ensureClaudeSkillSymlink(process.cwd(), skill);
                    for (const dependency of requires) ensureClaudeSkillSymlink(process.cwd(), dependency);
                }
                consola.success(`${skill} installed`);
            } catch (e) {
                consola.error(`Failed to install ${skill}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    } catch (e) {
        handleError(e);
    }
};

await askUser();
