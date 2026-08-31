import { execFileSync } from "node:child_process";
import { checkbox, select } from "@inquirer/prompts";
import consola from "consola";
import { AGENTS, CLEAR_ON_DONE, confirmSelection, disableGlobalChoices, handleError, loadJsonCatalog, loadValidatedCatalog, readGlobalSkillSet, selectTargetTools, setupConsola, TOOLS } from "../shared/utils.js";
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
 * Two entry points:
 *   - default: interactive per-project install into the current working directory.
 *   - `--global`: non-interactive machine-wide install. Adds every entry of this installer's
 *     own `skills.global.json` to the shared skills store with `npx skills add -g`, then
 *     `npx skills update -g`. See `installGlobalSkills`. First-party instruction/prompt and
 *     local-skill assets have their own `*.global.json` under `agents/` and `skills/local/`.
 *
 * Installed at /opt/devcontainer/installer/skills/ inside the container.
 */

setupConsola();

// ─── Constants ───────────────────────────────────────────────────────────────

const SKILLS_FILE_URL = new URL("./skills.json", import.meta.url);
const GLOBAL_MANIFEST_URL = new URL("./skills.global.json", import.meta.url);

const FINISH_SELECTION = "finish-selection";

// ─── Functions ───────────────────────────────────────────────────────────────

/**
 * Load and validate the skills catalog from skills.json.
 * @returns {object[]} Validated skill entries.
 * @throws If the catalog file or any entry is invalid.
 */
const loadSkillsCatalog = () => loadValidatedCatalog(SKILLS_FILE_URL, "skills", {
    strings: ["name", "skill", "url"],
    nonEmptyStrings: ["category", "description"],
    stringArrays: ["tags"],
    optionalStringArrays: ["requires"],
});

/**
 * Format a category name as the compact separator label used in the prompts.
 * @param {string} category - Category name.
 * @returns {string} The category name wrapped in dashes.
 */
const formatCategory = (category) => `── ${category} ──`;

/**
 * Interactively select skills one compact category at a time. This keeps every checkbox
 * prompt visible without relying on an internal scrolling list as the catalog grows.
 * @param {Map<string, object[]>} groups - Validated catalog entries grouped by category.
 * @param {Map<string, string|null>} globalSet - Skills already installed machine-wide, shown
 *   as non-selectable `disabled` rows.
 * @returns {Promise<object[]|null>} Selected entries, or null when the user cancels.
 */
const selectSkillsByCategory = async (groups, globalSet = readGlobalSkillSet()) => {
    const selectedSkills = new Set();
    const categories = [...groups.entries()];
    const skippedGlobal = [...groups.values()].flat()
        .filter((entry) => globalSet.has(entry.skill))
        .map((entry) => entry.name);

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
                { title: "Skipped (already global)", items: skippedGlobal },
            ], "Install selected skills");

            if (action === "install") return [...selectedSkills];
            if (action === "cancel") return null;
            continue;
        }

        const entries = groups.get(category);
        const selectedInCategory = await checkbox({
            message: formatCategory(category),
            choices: disableGlobalChoices(
                entries.map((entry) => ({
                    name: entry.name,
                    value: entry,
                    description: entry.description,
                })),
                (choice) => choice.value.skill,
                globalSet,
            ),
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

// ─── Global (non-interactive) scope ──────────────────────────────────────────

/**
 * Shell out to the external skills CLI. Isolated so the `--global` path can be exercised
 * in tests without a network round-trip.
 * @param {string[]} args - Arguments passed after `npx`.
 */
const runSkillsCli = (args) => execFileSync("npx", args, { stdio: "pipe" });

/**
 * Load and validate this installer's machine-wide skills manifest (`skills.global.json`):
 * the flat list of third-party skills added to the shared store by the `--global` path.
 * @returns {{ name: string, url: string, skill?: string }[]}
 * @throws Will throw if the manifest is missing, empty, or has a malformed entry.
 */
export const loadGlobalSkillsManifest = () => {
    const entries = loadJsonCatalog(GLOBAL_MANIFEST_URL);
    if (entries.length === 0) throw new Error("skills.global.json manifest is empty.");
    for (const [index, entry] of entries.entries()) {
        const isValid =
            typeof entry?.name === "string" && entry.name.length > 0
            && typeof entry?.url === "string" && entry.url.length > 0
            && (entry?.skill === undefined || (typeof entry.skill === "string" && entry.skill.length > 0));
        if (!isValid) throw new Error(`Invalid skills.global.json entry at index ${index}.`);
    }
    return entries;
};

/**
 * Add one external skill to the machine-wide store. `skills add` is re-run on every sync as
 * the safety net for vercel-labs/skills#1143, where `skills update -g` can report
 * "No global skills tracked"; a re-add is idempotent.
 * @param {{ url: string, skill?: string }} entry
 * @param {(args: string[]) => void} run
 */
const addGlobalSkill = ({ url, skill }, run) => {
    const args = ["skills", "add", url, "-g", "--yes"];
    if (skill) args.push("--skill", skill);
    run(args);
};

/**
 * Non-interactive `--global` path: add every manifest `external` skill to the shared store,
 * then refresh them. A single skill's failure is logged and skipped; a failed
 * `skills update -g` is tolerated because the per-skill re-add above is the real freshness
 * guarantee.
 * @param {{ run?: (args: string[]) => void }} [options] - CLI runner override for tests.
 */
export const installGlobalSkills = ({ run = runSkillsCli } = {}) => {
    const external = loadGlobalSkillsManifest();
    for (const entry of external) {
        consola.start(`Adding ${entry.name} to the shared skills store`);
        try {
            addGlobalSkill(entry, run);
            consola.success(`${entry.name} added`);
        } catch (e) {
            consola.error(`Failed to add ${entry.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    try {
        run(["skills", "update", "-g", "--yes"]);
        consola.success("Shared skills store refreshed");
    } catch (e) {
        consola.warn(`skills update -g failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }
};

/**
 * Prompt the user to select skills and target tools, then install each selected skill into
 * the canonical Agent Skills location, adding Claude symlinks when Claude Code is selected.
 * @returns {Promise<void>}
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

if (import.meta.url === `file://${process.argv[1]}`) {
    if (process.argv[2] === "--global") {
        try {
            installGlobalSkills();
        } catch (e) {
            handleError(e);
        }
    } else {
        await askUser();
    }
}
