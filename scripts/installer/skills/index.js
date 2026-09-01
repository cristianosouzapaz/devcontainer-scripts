import { execFileSync } from "node:child_process";
import { loadJsonCatalog, loadValidatedCatalog } from "../shared/catalog.js";
import { AGENTS, TOOLS } from "../shared/constants.js";
import { pickAssets } from "../shared/pick-assets.js";
import { restoreChecked, selectTargetTools, selectUntilConfirmed } from "../shared/prompts.js";
import { handleError, readGlobalSkillSet, setupConsola } from "../shared/utils.js";
import { buildSkillChoices, readProjectSkillSet } from "./catalog.js";
import { ensureClaudeSkillSymlink } from "./local/index.js";

/**
 * @fileoverview Interactive installer for third-party Agent Skills. See
 * `docs/wiki/installer/skills.md`. The external skills CLI owns source and integrity tracking.
 *
 * Installed at /opt/devcontainer/installer/skills/ inside the container.
 */

const consola = setupConsola();

const SKILLS_FILE_URL = new URL("./skills.json", import.meta.url);
const GLOBAL_MANIFEST_URL = new URL("./skills.global.json", import.meta.url);

/**
 * Assert that a catalog entry owns the fields used by the interactive installer.
 * @param {unknown} entry - Candidate catalog entry.
 * @returns {asserts entry is { name: string, skill: string, url: string, category: string, description: string, tags: string[], requires?: string[] }} Nothing.
 * @throws {TypeError} If the entry is malformed.
 */
const assertSkillCatalogEntry = (entry) => {
    const hasString = (key) => Object.hasOwn(entry, key) && typeof entry[key] === "string";
    const hasStringArray = (key) => Object.hasOwn(entry, key) && Array.isArray(entry[key]) && entry[key].every((value) => typeof value === "string");
    if (entry === null || typeof entry !== "object"
        || !hasString("name") || !hasString("skill") || !hasString("url")
        || !hasString("category") || entry.category.length === 0
        || !hasString("description") || entry.description.length === 0
        || !hasStringArray("tags")
        || (Object.hasOwn(entry, "requires") && (!Array.isArray(entry.requires) || entry.requires.some((value) => typeof value !== "string")))) {
        throw new TypeError("Invalid skills catalog entry.");
    }
};

/**
 * Assert that a manifest entry owns the fields required by the global installer.
 * @param {unknown} entry - Candidate global skills manifest entry.
 * @returns {asserts entry is { name: string, url: string, skill?: string }} Nothing.
 * @throws {TypeError} If the entry is malformed.
 */
const assertGlobalManifestEntry = (entry) => {
    if (entry === null || typeof entry !== "object"
        || !Object.hasOwn(entry, "name") || typeof entry.name !== "string" || entry.name.length === 0
        || !Object.hasOwn(entry, "url") || typeof entry.url !== "string" || entry.url.length === 0
        || (Object.hasOwn(entry, "skill") && (typeof entry.skill !== "string" || entry.skill.length === 0))) {
        throw new TypeError("Invalid skills.global.json entry.");
    }
};

/**
 * Assert that a CLI runner is callable.
 * @param {unknown} run - Candidate CLI runner.
 * @returns {asserts run is (args: string[]) => void} Nothing.
 * @throws {TypeError} If the value is not a function.
 */
const assertRunner = (run) => {
    if (typeof run !== "function") throw new TypeError("Skills CLI runner must be a function.");
};

/**
 * Return whether a caught value is an expected command execution failure.
 * @param {unknown} error - Failure reported by the skills CLI.
 * @returns {boolean} True when the CLI supplied an Error.
 */
const isCliFailure = (error) => error instanceof Error;

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
}).map((entry) => {
    assertSkillCatalogEntry(entry);
    return entry;
});

/**
 * Present the whole catalogue as one filterable multi-select, then confirm. The returned
 * list is exactly what the user picked; each entry's `requires` dependencies are installed
 * as a side effect by the caller, so they only appear in the confirmation summary.
 * @param {object[]} skills - Validated skill catalog entries.
 * @param {Map<string, unknown>} globalSet - Skills already installed machine-wide.
 * @returns {Promise<object[]|null|undefined>} Picked entries, null on cancel, undefined on
 *   an empty selection.
 */
const selectSkills = (skills, globalSet = readGlobalSkillSet(), projectSet = readProjectSkillSet()) => {
    const choices = buildSkillChoices(skills, globalSet, projectSet);
    const alreadyGlobal = choices.filter((choice) => choice.disabled).map((choice) => choice.name);

    return selectUntilConfirmed(
        (previous) => pickAssets({ message: "Select skills", choices: restoreChecked(choices, previous), grouped: true }),
        (selected) => {
            const requiredBy = new Map();
            for (const entry of selected) {
                for (const dependency of entry.requires ?? []) {
                    if (selected.some((pick) => pick.skill === dependency)) continue;
                    requiredBy.set(dependency, [...(requiredBy.get(dependency) ?? []), entry.name]);
                }
            }
            return [
                { title: "Skills", items: selected.map(({ name }) => name) },
                { title: "Automatically included", items: [...requiredBy].map(([dep, names]) => `${dep} (required by ${names.join(", ")})`) },
                { title: "Already installed globally", items: alreadyGlobal, note: true },
            ];
        },
        "Install selected skills",
    );
};

/**
 * Install a skill into the canonical Agent Skills location.
 * @param {string} url - The URL of the skill repository.
 * @param {string} skill - The skill identifier.
 * @returns {void} Nothing.
 * @throws {Error} If the external CLI cannot install the requested skill.
 * @effects Starts `npx skills add` for the supplied repository and skill.
 */
const installCanonicalSkill = (url, skill) => execFileSync("npx", ["skills", "add", url, "--skill", skill, "--agent", AGENTS.codex, "--yes"], {
    stdio: "pipe",
});

/**
 * Shell out to the external skills CLI. Isolated so the `--global` path can be exercised
 * in tests without a network round-trip.
 * @param {string[]} args - Arguments passed after `npx`.
 * @returns {void} Nothing.
 * @throws {Error} If the external CLI process fails.
 * @effects Starts `npx` with the supplied arguments.
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
        try {
            assertGlobalManifestEntry(entry);
        } catch (error) {
            if (error instanceof TypeError) throw new Error(`Invalid skills.global.json entry at index ${index}.`, { cause: error });
            throw error;
        }
    }
    return entries;
};

/**
 * Add one external skill to the machine-wide store. `skills add` is re-run on every sync as
 * the safety net for vercel-labs/skills#1143, where `skills update -g` can report
 * "No global skills tracked"; a re-add is idempotent.
 * @param {{ url: string, skill?: string }} entry - Validated manifest entry to install.
 * @param {(args: string[]) => void} run - CLI effect function.
 * @returns {void} Nothing.
 * @throws {TypeError} If the entry or runner is malformed.
 * @throws {Error} If the CLI cannot add the skill to the shared store.
 */
const addGlobalSkill = (entry, run) => {
    assertGlobalManifestEntry(entry);
    assertRunner(run);
    const { url } = entry;
    const skill = Object.hasOwn(entry, "skill") ? entry.skill : undefined;
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
 * @returns {void} Nothing.
 * @throws {TypeError} If options or its runner are malformed.
 * @throws {Error} If the manifest is invalid or a runner throws a non-Error value.
 * @effects Starts the supplied CLI runner for each manifest entry and the final update command.
 */
export const installGlobalSkills = (options = {}) => {
    if (options === null || typeof options !== "object" || Array.isArray(options)
        || (Object.hasOwn(options, "run") && typeof options.run !== "function")) {
        throw new TypeError("Global skills options must be an object with an optional runner function.");
    }
    const run = Object.hasOwn(options, "run") ? options.run : runSkillsCli;
    assertRunner(run);
    const external = loadGlobalSkillsManifest();
    for (const entry of external) {
        consola.start(`Adding ${entry.name} to the shared skills store`);
        try {
            addGlobalSkill(entry, run);
            consola.success(`${entry.name} added`);
        } catch (error) {
            if (!isCliFailure(error)) throw error;
            consola.error(`Failed to add ${entry.name}: ${error.message}`);
        }
    }
    try {
        run(["skills", "update", "-g", "--yes"]);
        consola.success("Shared skills store refreshed");
    } catch (error) {
        if (!isCliFailure(error)) throw error;
        consola.warn(`skills update -g failed (non-fatal): ${error.message}`);
    }
};

/**
 * Prompt the user to select skills and target tools, then install each selected skill into
 * the canonical Agent Skills location, adding Claude symlinks when Claude Code is selected.
 * @returns {Promise<void>}
 * @throws {Error} If a prompt, skill installation, or Claude adapter update fails unexpectedly.
 * @effects Prompts the user, starts the skills CLI, and may create Claude adapter symlinks beneath the current project.
 */
const askUser = async () => {
    try {
        const selectedSkills = await selectSkills(loadSkillsCatalog());

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
            } catch (error) {
                if (!isCliFailure(error)) throw error;
                consola.error(`Failed to install ${skill}: ${error.message}`);
            }
        }
    } catch (error) {
        handleError(error);
    }
};

if (import.meta.url === `file://${process.argv[1]}`) {
    if (process.argv[2] === "--global") {
        try {
            installGlobalSkills();
        } catch (error) {
            handleError(error);
        }
    } else {
        await askUser();
    }
}
