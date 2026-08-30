import { execFileSync } from "node:child_process";
import { checkbox, Separator } from "@inquirer/prompts";
import consola from "consola";
import { AGENTS, handleError, loadJsonCatalog, resolvePageSize, selectTargetTools, setupConsola, TOOLS } from "../shared/utils.js";
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
const PROMPT_MESSAGE = "Select skills to INSTALL:";

/**
 * Display order for skill categories. Categories not listed here are
 * appended after these, in the order first encountered in the catalog.
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

/**
 * Group skill entries by category, in CATEGORY_ORDER (unlisted categories
 * are appended in first-seen order), preserving each entry's relative
 * position within its category.
 * @param {object[]} entries - Skill catalog entries.
 * @returns {Map<string, object[]>} Entries keyed by category.
 */
const groupByCategory = (entries) => {
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

        const choices = [...groupByCategory(skills).entries()].flatMap(([category, entries]) => [
            new Separator(`── ${category} ──`),
            ...entries.map((entry) => ({
                name: entry.name,
                value: entry,
                description: entry.description,
            })),
        ]);

        const selectedSkills = await checkbox({
            choices,
            message: PROMPT_MESSAGE,
            pageSize: resolvePageSize(choices.length),
        });

        if (selectedSkills.length === 0) {
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
