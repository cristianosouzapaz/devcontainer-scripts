import { execFileSync } from "node:child_process";
import { existsSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadAgentPacks, selectAgentPacks } from "../lib/agent-packs.js";
import { loadJsonCatalog } from "../lib/catalog.js";
import { readGlobalSkillSet } from "../lib/global-skill-set.js";
import { pickAssets } from "../lib/pick-assets.js";
import { restoreChecked, selectTargetTools, selectUntilConfirmed } from "../lib/prompts.js";
import { handleError, setupConsola } from "../lib/utils.js";
import { buildSkillChoices, readProjectSkillSet } from "./picker.js";
import { ensureSkillSymlink, relativeCanonicalSkill } from "./local/index.js";

/**
 * @fileoverview Interactive installer for third-party Agent Skills. See
 * `docs/wiki/installer/skills.md`. The external skills CLI owns source and integrity tracking.
 * A remote skill has no local file to carry metadata, so `skills.json` stays its catalog: an
 * entry with a `category` is offered in the picker, and `"global": true` adds it to the
 * machine-wide set.
 *
 * Installed at /opt/devcontainer/installer/skills/ inside the container.
 */

const consola = setupConsola();

const skillsFileUrl = new URL("./skills.json", import.meta.url);

/**
 * Assert that a catalog entry owns the fields its role needs: `name`, `skill` and `url`
 * always; `category`, `description` and `tags` for a picker entry (one with a `category`);
 * optional `requires` and a boolean `global`.
 * @param {unknown} entry - Candidate catalog entry.
 * @returns {asserts entry is { name: string, skill: string, url: string, category?: string, description?: string, tags?: string[], requires?: string[], global?: boolean }} Nothing.
 * @throws {TypeError} If the entry is malformed, or names no picker fields and is not global.
 */
const assertSkillCatalogEntry = (entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("Invalid skills catalog entry.");
    const hasString = (key) => Object.hasOwn(entry, key) && typeof entry[key] === "string" && entry[key].length > 0;
    const hasStringArray = (key) => Object.hasOwn(entry, key) && Array.isArray(entry[key]) && entry[key].every((value) => typeof value === "string");
    const inPicker = Object.hasOwn(entry, "category");
    const global = Object.hasOwn(entry, "global") ? entry.global : false;
    if (!hasString("name") || !hasString("skill") || !hasString("url")
        || typeof global !== "boolean" || (!inPicker && !global)
        || (inPicker && (!hasString("category") || !hasString("description") || !hasStringArray("tags")))
        || (Object.hasOwn(entry, "requires") && !hasStringArray("requires"))) {
        throw new TypeError("Invalid skills catalog entry.");
    }
};

/**
 * Whether a validated catalog entry is offered in the interactive picker.
 * @param {object} entry - Validated catalog entry.
 * @returns {boolean} True when the entry has a category.
 */
const isPickerEntry = (entry) => Object.hasOwn(entry, "category");

/**
 * Return whether a caught value is an expected command execution failure.
 * @param {unknown} error - Failure reported by the skills CLI.
 * @returns {boolean} True when the CLI supplied an Error.
 */
const isCliFailure = (error) => error instanceof Error;

/**
 * Load and validate the skills catalog from skills.json.
 * @returns {object[]} Validated skill entries, picker and global-only alike.
 * @throws {Error} If the catalog file cannot be read or an entry is invalid.
 * @effects Reads skills.json next to this module.
 */
const loadSkillsCatalog = () => loadJsonCatalog(skillsFileUrl).map((entry, index) => {
    try {
        assertSkillCatalogEntry(entry);
    } catch (error) {
        if (error instanceof TypeError) throw new Error(`Invalid skills catalog entry at index ${index}.`, { cause: error });
        throw error;
    }
    return entry;
});

/**
 * Present the whole catalogue as one filterable multi-select, then confirm. The returned
 * list is exactly what the user picked; each entry's `requires` dependencies are installed
 * as a side effect by the caller, so they only appear in the confirmation summary.
 * @param {object[]} skills - Validated skill catalog entries.
 * @param {Map<string, unknown>} globalSet - Skills already installed machine-wide.
 * @param {Set<string>} [projectSet] - Skills already present in the project.
 * @returns {Promise<object[]|null|undefined>} Picked entries, null on cancel, undefined on
 *   an empty selection.
 */
const selectSkills = (skills, globalSet, projectSet = readProjectSkillSet()) => {
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
 * The external skills CLI agent whose install target is the canonical `.agents/skills`
 * directory alone: the first pack that reads that directory natively (`skills.mode` none) and
 * names its `skillsCliAgent`.
 * @param {{ skillsCliAgent: string|null, skills: { mode: string } }[]} packs - Coding-agent packs.
 * @returns {string} The skills CLI `--agent` value.
 * @throws {Error} If no pack qualifies.
 */
const canonicalCliAgent = (packs) => {
    const pack = packs.find((candidate) => candidate.skills.mode === "none" && candidate.skillsCliAgent !== null);
    if (!pack) throw new Error("No coding-agent pack reads .agents/skills natively and names a skillsCliAgent.");
    return pack.skillsCliAgent;
};

/**
 * Install a skill into the canonical Agent Skills location.
 * @param {string} url - The URL of the skill repository.
 * @param {string} skill - The skill identifier.
 * @param {string} cliAgent - Skills CLI agent that installs into `.agents/skills` only.
 * @returns {void} Nothing.
 * @throws {Error} If the external CLI cannot install the requested skill.
 * @effects Starts `npx skills add` for the supplied repository and skill.
 */
const installCanonicalSkill = (url, skill, cliAgent) => execFileSync("npx", ["skills", "add", url, "--skill", skill, "--agent", cliAgent, "--yes"], {
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
 * The machine-wide third-party skills: the skills.json entries marked `"global": true`,
 * added to the shared store by the `--global` path.
 * @returns {{ name: string, url: string, skill: string }[]} Global entries, in catalog order.
 * @throws {Error} If the catalog is invalid or marks no entry global.
 * @effects Reads skills.json next to this module.
 */
export const loadGlobalSkillsManifest = () => {
    const entries = loadSkillsCatalog().filter((entry) => entry.global === true);
    if (entries.length === 0) throw new Error("skills.json marks no skill global.");
    return entries;
};

/**
 * Add one external skill to the machine-wide store. `skills add` is re-run on every sync
 * because `skills update -g` can report "No global skills tracked" and leave the skill
 * stale; a re-add is idempotent.
 * @param {{ url: string, skill: string }} entry - Validated catalog entry to install.
 * @param {(args: string[]) => void} run - CLI effect function.
 * @returns {void} Nothing.
 * @throws {Error} If the CLI cannot add the skill to the shared store.
 */
const addGlobalSkill = (entry, run) => {
    run(["skills", "add", entry.url, "-g", "--yes", "--skill", entry.skill]);
};

/**
 * Tell whether an adapter path holds the relative link the external CLI writes, the only
 * link safe to repair for a pack this container does not select.
 * @param {string} home - Home directory.
 * @param {string} skillsPath - Home-relative skills directory of the agent.
 * @param {string} skillName - Skill directory name.
 * @returns {boolean} Whether the adapter is a symlink to the CLI's relative target.
 * @throws {Error} If the path cannot be inspected for a reason other than its absence or not being a link.
 * @effects Reads the adapter's link target.
 */
const holdsCliLink = (home, skillsPath, skillName) => {
    try {
        return readlinkSync(join(home, skillsPath, skillName)) === relativeCanonicalSkill(home, skillsPath, skillName);
    } catch (error) {
        if (["ENOENT", "ENOTDIR", "EINVAL"].includes(error?.code)) return false;
        throw error;
    }
};

/**
 * Point the symlink adapters of one machine-wide third-party skill at an absolute canonical
 * path, one per pack that exposes skills by symlink. The external CLI writes a
 * `../../.agents/…` target, which resolves only while the agent's home directory and
 * `~/.agents` are physical siblings; in the devcontainer both are symlinks into separate
 * volume categories, so it dangles and the agent silently finds no global skill. A skill the
 * CLI did not materialize is left alone rather than linked to nothing. A pack outside the
 * selection gets no new adapter, but the relative link the CLI wrote is still repaired: its home
 * may be shared with containers that do select it, where it would dangle. Any other entry of
 * an unselected pack is left alone, so a foreign link cannot stop the sync.
 * @param {{ skill: string }} entry - Validated catalog entry just added.
 * @param {{ id: string, skills: { mode: string, path?: string } }[]} packs - Every coding-agent pack.
 * @param {Set<string>} selected - Ids of the packs this container's `CODING_AGENTS` selects.
 * @returns {void} Nothing.
 * @throws {Error} If an adapter path holds an unmanaged entry that must be migrated by hand, or cannot be inspected.
 * @effects Reads `~/.agents/skills` and each adapter path, and may replace each `~/<skills.path>/<name>` symlink below the current user home directory.
 */
const normalizeGlobalAdapters = (entry, packs, selected) => {
    const skillName = entry.skill;
    const home = homedir();
    if (!existsSync(join(home, ".agents", "skills", skillName))) return;
    for (const pack of packs) {
        if (pack.skills.mode !== "symlink") continue;
        if (selected.has(pack.id) || holdsCliLink(home, pack.skills.path, skillName)) ensureSkillSymlink(home, pack.skills.path, skillName);
    }
};

/**
 * Non-interactive `--global` path: add every skills.json entry marked `global` to the shared store,
 * then refresh them, normalizing each skill's symlink adapters to an absolute canonical target.
 * A single skill's failure is logged and skipped, so the others still sync, then sets a non-zero
 * exit status so the caller sees the sync as partial; a failed `skills update -g` is tolerated
 * because the per-skill re-add above is the real freshness guarantee.
 * @param {{ run?: (args: string[]) => void }} [options] - CLI runner override for tests.
 * @returns {void} Nothing; a failed skill add or adapter link sets `process.exitCode` to 1.
 * @throws {TypeError} If options or its runner are malformed.
 * @throws {Error} If the manifest is invalid or a runner throws a non-Error value.
 * @effects Reads the coding-agent packs and `CODING_AGENTS`, starts the supplied CLI runner for each manifest entry and the final update command, may create the selected agents' adapter symlinks and repair any existing one below the current user home directory, and sets the process exit status.
 */
export const installGlobalSkills = (options = {}) => {
    if (options === null || typeof options !== "object" || Array.isArray(options)
        || (Object.hasOwn(options, "run") && typeof options.run !== "function")) {
        throw new TypeError("Global skills options must be an object with an optional runner function.");
    }
    const run = Object.hasOwn(options, "run") ? options.run : runSkillsCli;
    const external = loadGlobalSkillsManifest();
    const packs = loadAgentPacks();
    const selected = new Set(selectAgentPacks(packs, process.env.CODING_AGENTS).map((pack) => pack.id));
    let anyFailed = false;
    for (const entry of external) {
        consola.start(`Adding ${entry.name} to the shared skills store`);
        try {
            addGlobalSkill(entry, run);
        } catch (error) {
            if (!isCliFailure(error)) throw error;
            consola.error(`Failed to add ${entry.name}: ${error.message}`);
            anyFailed = true;
            continue;
        }
        try {
            normalizeGlobalAdapters(entry, packs, selected);
            consola.success(`${entry.name} added`);
        } catch (error) {
            if (!isCliFailure(error)) throw error;
            consola.error(`${entry.name} added, but its agent adapters could not be linked: ${error.message}`);
            anyFailed = true;
        }
    }
    try {
        run(["skills", "update", "-g", "--yes"]);
        consola.success("Shared skills store refreshed");
    } catch (error) {
        if (!isCliFailure(error)) throw error;
        consola.warn(`skills update -g failed (non-fatal): ${error.message}`);
    }
    if (anyFailed) process.exitCode = 1;
};

/**
 * Prompt the user to select skills and target tools, then install each selected skill into
 * the canonical Agent Skills location, adding a symlink for every selected pack that exposes
 * skills by symlink.
 * @returns {Promise<void>}
 * @throws {Error} If a prompt, skill installation, or adapter update fails unexpectedly.
 * @effects Prompts the user, reads the coding-agent packs, starts the skills CLI, and may create agent adapter symlinks beneath the current project.
 */
const askUser = async () => {
    try {
        const packs = loadAgentPacks();
        const selectedSkills = await selectSkills(loadSkillsCatalog().filter(isPickerEntry), readGlobalSkillSet(packs));

        if (!selectedSkills || selectedSkills.length === 0) {
            consola.info("No skills selected.");
            return;
        }

        const selectedTools = await selectTargetTools(packs);
        const cliAgent = canonicalCliAgent(packs);
        const symlinkPacks = packs.filter((pack) => selectedTools.includes(pack.id) && pack.skills.mode === "symlink");
        for (const { url, skill, requires = [] } of selectedSkills) {
            consola.start(`Installing ${skill}`);
            try {
                installCanonicalSkill(url, skill, cliAgent);
                for (const dependency of requires) installCanonicalSkill(url, dependency, cliAgent);
                for (const pack of symlinkPacks) {
                    ensureSkillSymlink(process.cwd(), pack.skills.path, skill);
                    for (const dependency of requires) ensureSkillSymlink(process.cwd(), pack.skills.path, dependency);
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

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
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
