import { execFileSync } from "node:child_process";
import consola from "consola";
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

setupConsola();

// ─── Constants ───────────────────────────────────────────────────────────────

const SKILLS_FILE_URL = new URL("./skills.json", import.meta.url);
const GLOBAL_MANIFEST_URL = new URL("./skills.global.json", import.meta.url);

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
                { title: "Already installed globally", items: alreadyGlobal },
            ];
        },
        "Install selected skills",
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
