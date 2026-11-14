import { readFileSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadAgentPacks, selectAgentPacks } from "../lib/agent-packs.js";
import { copilotTarget } from "../lib/constants.js";
import { readGlobalSkillSet } from "../lib/global-skill-set.js";
import { getArtifactVersion, readLockFile, reconcileArtifactAdapters, recordArtifact, ruleSymlinkAdapter, skillSymlinkAdapter, writeLockFile } from "../lib/lock-file.js";
import { pickAssets } from "../lib/pick-assets.js";
import { formatVersionHint, restoreChecked, selectTargetTools, selectUntilConfirmed } from "../lib/prompts.js";
import { parseFrontmatter, scanTemplates, stripKitMetadata, unquote } from "../lib/template-metadata.js";
import { handleError, isPromptCancellation, setupConsola } from "../lib/utils.js";
import { writeOverwrite, writeWithConflict } from "../lib/write-file.js";
import { ensureRuleSymlink, ensureSkillSymlink } from "../skills/local/index.js";

/**
 * @fileoverview Interactive installer for agent instruction and prompt templates. See
 * `docs/wiki/installer/agents.md`. Each template under `templates/instructions/` and
 * `templates/prompts/` is discovered by scanning and described by its own frontmatter; no
 * catalog lists them. A coding-agent pack's adapters are symlinks to the canonical skill,
 * placed where its `skills` and `rules` exposures say; Copilot needs materialized adapters for
 * its path-specific formats.
 *
 * Installed at /opt/devcontainer/installer/agents/ inside the container.
 */

const consola = setupConsola();

const templatesUrl = new URL("./templates/", import.meta.url);
const templatesDir = fileURLToPath(templatesUrl);

/**
 * Reconstruct a markdown file from frontmatter fields and body.
 * String values are written as-is, preserving the original quoting from the source template.
 * Array values are written as a YAML list, one item per line.
 *
 * @param {Record<string, string | string[]>} fields
 * @param {string} body
 * @returns {string}
 */
const buildFrontmatter = (fields, body) => {
    const lines = [];
    for (const [k, v] of Object.entries(fields)) {
        if (Array.isArray(v)) {
            lines.push(`${k}:`);
            for (const item of v) lines.push(`  - ${item}`);
        } else {
            lines.push(`${k}: ${v}`);
        }
    }
    return `---\n${lines.join("\n")}\n---\n${body}`;
};

/**
 * Derive a pack's rule filename from a Copilot instruction filename.
 * Example: agent-orchestration.instructions.md → agent-orchestration.md
 *
 * @param {string} instructionFilename
 * @returns {string}
 */
const toRuleFilename = (instructionFilename) => instructionFilename.replace(".instructions.md", ".md");

/**
 * Derive a portable Agent Skill directory name from a template filename.
 * @param {string} filename - A template filename such as "bash.instructions.md".
 * @returns {string}
 */
const toSkillName = (filename) => filename
    .replace(/\.instructions\.md$/, "")
    .replace(/\.prompt\.md$/, "")
    .replace(/\.md$/, "");

/**
 * Whether a Copilot `applyTo` glob targets every file, e.g. `"**"` or `**`.
 *
 * @param {string} applyTo - Raw (possibly quoted) applyTo value.
 * @returns {boolean}
 */
const appliesToAllFiles = (applyTo) => unquote(applyTo) === "**";

/**
 * Build the portable SKILL.md representation of an instruction or command template.
 * Instruction skills retain the optional `paths` metadata so the same physical file can be
 * loaded through a pack's rules symlink. Agents that read `.agents/skills` natively require
 * `name` and `description` and ignore additional frontmatter fields.
 *
 * @param {string} templateContent
 * @param {string} skillName
 * @param {boolean} isInstruction
 * @returns {string}
 */
const buildCanonicalSkillContent = (templateContent, skillName, isInstruction = false) => {
    const { raw, body } = parseFrontmatter(templateContent);
    const fields = { name: skillName, description: raw.description ?? `Use the ${skillName} workflow.` };
    if (isInstruction && raw.applyTo && !appliesToAllFiles(raw.applyTo)) fields.paths = [raw.applyTo];
    return buildFrontmatter(fields, body);
};

/**
 * Install an Agent Skill source in the canonical `.agents/skills` layout every agent shares.
 * @param {string} destRoot - Project root directory.
 * @param {string} skillName - Portable Agent Skill name.
 * @param {string} content - Canonical SKILL.md content.
 * @param {string} version - Template version (`kit-version`).
 * @param {string|null} installedVersion - Version recorded for this skill in the lock file.
 * @param {typeof writeWithConflict} [writer] - File writer; defaults to the interactive conflict prompt.
 * @returns {Promise<{ path: string, written: boolean }>}
 */
const installCanonicalSkill = async (destRoot, skillName, content, version, installedVersion, writer = writeWithConflict) => {
    const skillDir = join(destRoot, ".agents", "skills", skillName);
    const relPath = join(".agents", "skills", skillName, "SKILL.md");
    mkdirSync(skillDir, { recursive: true });
    const written = await writer(join(skillDir, "SKILL.md"), content, `${skillName}/SKILL.md`, version, installedVersion);
    return { path: relPath, written };
};

/**
 * Discover the instruction templates by scanning `templates/instructions/`.
 * @returns {{ name: string, description: string, filename: string, version: string, tags: string[], global: boolean, templateFile: string }[]}
 *   One entry per `*.instructions.md`, in file-name order.
 * @throws {Error} If a template cannot be read or its metadata is invalid.
 * @effects Reads the instruction templates directory and every template in it.
 */
export const loadInstructions = () => scanTemplates(join(templatesDir, "instructions"), ".instructions.md")
    .map(({ file, name, description, version, tags, global }) => ({
        name, description, filename: file, version, tags, global, templateFile: `instructions/${file}`,
    }));

/**
 * Discover the prompt templates by scanning `templates/prompts/`. A prompt's command name
 * is its file name without `.prompt`.
 * @returns {{ name: string, description: string, filename: string, commandFilename: string, version: string, tags: string[], global: boolean, templateFile: string }[]}
 *   One entry per `*.prompt.md`, in file-name order.
 * @throws {Error} If a template cannot be read or its metadata is invalid.
 * @effects Reads the prompt templates directory and every template in it.
 */
export const loadPrompts = () => scanTemplates(join(templatesDir, "prompts"), ".prompt.md")
    .map(({ file, name, description, version, tags, global }) => ({
        name, description, filename: file, commandFilename: file.replace(/\.prompt\.md$/, ".md"), version, tags, global, templateFile: `prompts/${file}`,
    }));

/**
 * Install canonical Agent Skills and the native adapters for one template kind.
 * The kind-specific descriptor contains only the naming and adapter differences.
 * @param {object[]} entries - Selected template entries.
 * @param {string} destRoot - Project root directory.
 * @param {Set<string>} tools - Selected target ids: `copilotTarget.id` or pack ids.
 * @param {object} lock - Parsed template-lock.json.
 * @param {{ writer?: typeof writeWithConflict }} options - File writer override for tests.
 * @param {object} spec - Type-specific skill and adapter operations.
 * @returns {Promise<{ changed: boolean, lock: object }>} Whether the lock changed and updated lock data.
 */
const installAgentAssets = async (entries, destRoot, tools, lock, options, spec) => {
    const changedPaths = new Set();
    const state = { lock };
    const writer = options.writer ?? writeWithConflict;
    const templates = new Map(entries.map((entry) => [
        entry.templateFile,
        readFileSync(new URL(entry.templateFile, templatesUrl), "utf8"),
    ]));
    const managedPaths = new Set(entries
        .map((entry) => join(".agents", "skills", spec.skillName(entry), "SKILL.md"))
        .filter((path) => Object.hasOwn(state.lock.artifacts, path)));

    for (const entry of entries) {
        const skillName = spec.skillName(entry);
        const canonicalPath = join(".agents", "skills", skillName, "SKILL.md");
        const { written } = await installCanonicalSkill(
            destRoot,
            skillName,
            spec.buildCanonicalContent(templates.get(entry.templateFile), skillName),
            entry.version,
            getArtifactVersion(state.lock, canonicalPath),
            writer,
        );
        if (written) {
            state.lock = recordArtifact(state.lock, canonicalPath, { kind: spec.kind, version: entry.version });
            managedPaths.add(canonicalPath);
            changedPaths.add(canonicalPath);
        }
    }

    for (const adapter of spec.adapters) {
        if (!tools.has(adapter.tool)) continue;
        adapter.prepare?.(destRoot);
        for (const entry of entries) {
            const skillName = spec.skillName(entry);
            const canonicalPath = join(".agents", "skills", skillName, "SKILL.md");
            if (!managedPaths.has(canonicalPath)) continue;
            const materialized = await adapter.install({
                destRoot,
                entry,
                skillName,
                canonicalPath,
                template: templates.get(entry.templateFile),
                writer,
                version: entry.version,
                installedVersion: getArtifactVersion(state.lock, canonicalPath),
            });
            if (materialized) {
                state.lock = recordArtifact(state.lock, canonicalPath, { kind: spec.kind, adapters: { [adapter.name]: [materialized] } });
                changedPaths.add(canonicalPath);
            }
        }
    }

    for (const path of managedPaths) {
        const reconciled = reconcileArtifactAdapters(state.lock, destRoot, path);
        state.lock = reconciled.lock;
        if (reconciled.changed) changedPaths.add(path);
    }
    return { changed: changedPaths.size > 0, lock: state.lock };
};

/**
 * Create a Copilot native adapter that materializes a template as a path-specific
 * file under the given project directory (e.g. .github/instructions or .github/prompts).
 * @param {string} directory - Project-relative directory for the materialized files.
 * @returns {{ name: string, tool: string, prepare: (destRoot: string) => void, install: (ctx: object) => Promise<{ path: string, type: "file" }|null> }}
 */
const createCopilotAdapter = (directory) => ({
    name: copilotTarget.id,
    tool: copilotTarget.id,
    prepare: (destRoot) => mkdirSync(join(destRoot, directory), { recursive: true }),
    install: async ({ destRoot, entry, template, writer, version, installedVersion }) => {
        const relPath = join(directory, entry.filename);
        const written = await writer(join(destRoot, relPath), stripKitMetadata(template), entry.filename, version, installedVersion);
        return written ? { path: relPath, type: "file" } : null;
    },
});

/**
 * Build a pack's adapter that exposes a canonical skill as a symlink in its skills directory.
 * @param {{ id: string, skills: { path: string } }} pack - A pack whose skills mode is symlink.
 * @returns {{ name: string, tool: string, install: (ctx: object) => object }}
 */
const skillSymlinkPackAdapter = (pack) => ({
    name: pack.id,
    tool: pack.id,
    install: ({ destRoot, skillName }) => {
        ensureSkillSymlink(destRoot, pack.skills.path, skillName);
        return skillSymlinkAdapter(pack.skills.path, skillName);
    },
});

/**
 * Build a pack's adapter that exposes an instruction skill as a symlinked rule file, so it is
 * loaded for its `paths` only and never also as a skill.
 * @param {{ id: string, rules: { path: string } }} pack - A pack whose rules mode is symlink.
 * @returns {{ name: string, tool: string, install: (ctx: object) => object }}
 */
const ruleSymlinkPackAdapter = (pack) => ({
    name: pack.id,
    tool: pack.id,
    install: ({ destRoot, entry, skillName }) => {
        const filename = toRuleFilename(entry.filename);
        ensureRuleSymlink(destRoot, pack.rules.path, skillName, filename);
        return ruleSymlinkAdapter(pack.rules.path, skillName, filename);
    },
});

/**
 * Build the instruction-type skill and adapter spec consumed by `installAgentAssets`. A pack
 * with a rules directory gets a rule symlink; one without but with a skills directory gets a
 * skill symlink; one that reads `.agents/skills` natively gets nothing.
 * A factory because its adapters depend on the given packs.
 * @param {object[]} packs - Coding-agent packs.
 * @returns {object}
 */
const instructionSpec = (packs) => ({
    kind: "instruction",
    skillName: (entry) => toSkillName(entry.filename),
    buildCanonicalContent: (template, skillName) => buildCanonicalSkillContent(template, skillName, true),
    adapters: [
        ...packs.flatMap((pack) => {
            if (pack.rules.mode === "symlink") return [ruleSymlinkPackAdapter(pack)];
            if (pack.skills.mode === "symlink") return [skillSymlinkPackAdapter(pack)];
            return [];
        }),
        createCopilotAdapter(join(".github", "instructions")),
    ],
});

/**
 * Build the prompt-type skill and adapter spec consumed by `installAgentAssets`.
 * @param {object[]} packs - Coding-agent packs.
 * @returns {object}
 */
const promptSpec = (packs) => ({
    kind: "prompt",
    skillName: (entry) => toSkillName(entry.commandFilename),
    buildCanonicalContent: (template, skillName) => buildCanonicalSkillContent(template, skillName),
    adapters: [
        createCopilotAdapter(join(".github", "prompts")),
        ...packs.filter((pack) => pack.skills.mode === "symlink").map(skillSymlinkPackAdapter),
    ],
});

/**
 * Install selected instruction skills and their native adapters, updating the lock manifest.
 * @param {object[]} instructions - Selected instruction template entries.
 * @param {string} destRoot - Project root directory.
 * @param {Set<string>} tools - Selected target ids: `copilotTarget.id` or pack ids.
 * @param {object} lock - Parsed template-lock.json.
 * @param {{ writer?: typeof writeWithConflict, packs?: object[] }} [options] - File writer and pack overrides for tests.
 * @returns {Promise<{ changed: boolean, lock: object }>} Whether the lock changed and updated lock data.
 * @throws {Error} If the packs cannot be loaded, or a template, adapter or skill write fails.
 * @effects Reads the coding-agent packs when none are given, and writes skills and adapters below destRoot.
 */
export const installInstructions = (instructions, destRoot, tools, lock, options = {}) =>
    installAgentAssets(instructions, destRoot, tools, lock, options, instructionSpec(options.packs ?? loadAgentPacks()));

/**
 * Install selected prompt (command) skills and their native adapters, updating the lock manifest.
 * @param {object[]} prompts - Selected prompt template entries.
 * @param {string} destRoot - Project root directory.
 * @param {Set<string>} tools - Selected target ids: `copilotTarget.id` or pack ids.
 * @param {object} lock - Parsed template-lock.json.
 * @param {{ writer?: typeof writeWithConflict, packs?: object[] }} [options] - File writer and pack overrides for tests.
 * @returns {Promise<{ changed: boolean, lock: object }>} Whether the lock changed and updated lock data.
 * @throws {Error} If the packs cannot be loaded, or a template, adapter or skill write fails.
 * @effects Reads the coding-agent packs when none are given, and writes skills and adapters below destRoot.
 */
export const installPrompts = (prompts, destRoot, tools, lock, options = {}) =>
    installAgentAssets(prompts, destRoot, tools, lock, options, promptSpec(options.packs ?? loadAgentPacks()));

/**
 * Materialize the instruction and prompt skills whose metadata sets `kit-global: "true"` into
 * the shared machine-wide `~/.agents` tree (canonical `~/.agents/skills/<name>/SKILL.md`) plus
 * the symlink adapters of every pack `CODING_AGENTS` selects below the home directory, tracked in
 * `~/.agents/template-lock.json`. Non-interactive: conflicts are resolved by overwrite (the
 * template is the source of truth for a global asset); Copilot gets no global adapter, and a
 * pack whose agent reads `~/.agents/skills` natively gets none either. Assumes each agent's
 * config directory is the one under the home its pack names, as the devcontainer image sets it.
 *
 * @param {{ writer?: typeof writeOverwrite }} [options] - Writer override for tests.
 * @returns {Promise<void>}
 * @throws {Error} If a template cannot be read or its metadata is invalid, the packs cannot be
 *   loaded, or the shared target cannot be updated.
 * @effects Reads the coding-agent packs and `CODING_AGENTS`, writes skill files and the adapters of the selected agents below the user home directory, then its lock file.
 */
export const installGlobal = async (options = {}) => {
    const instructions = loadInstructions().filter((entry) => entry.global);
    const prompts = loadPrompts().filter((entry) => entry.global);
    const resolvedInstructions = instructions.map((entry) => toSkillName(entry.filename));
    const resolvedPrompts = prompts.map((entry) => toSkillName(entry.commandFilename));

    const destRoot = homedir();
    const lockRoot = join(destRoot, ".agents");
    const lock = readLockFile(lockRoot);
    const packs = selectAgentPacks(loadAgentPacks(), process.env.CODING_AGENTS);
    const tools = new Set(packs.map((pack) => pack.id));
    const opts = { writer: options.writer ?? writeOverwrite };

    const instructionResult = instructions.length > 0 ? await installAgentAssets(instructions, destRoot, tools, lock, opts, instructionSpec(packs)) : { changed: false, lock };
    const promptResult = prompts.length > 0 ? await installAgentAssets(prompts, destRoot, tools, instructionResult.lock, opts, promptSpec(packs)) : instructionResult;

    if (instructionResult.changed || promptResult.changed) writeLockFile(lockRoot, promptResult.lock);
    const synced = [...resolvedInstructions, ...resolvedPrompts].sort().join(", ");
    consola.success(`Global agent assets synced: ${synced || "(no instruction or prompt sets kit-global)"}`);
};

/**
 * Prompt the user to select instruction and prompt templates, then install them.
 * On completion, updates template-lock.json in the project root with the installed versions.
 */
const askUser = async () => {
    try {
        const instructions = loadInstructions();
        const prompts = loadPrompts();
        const destRoot = process.cwd();
        const lock = readLockFile(destRoot);
        const packs = loadAgentPacks();
        const globalSet = readGlobalSkillSet(packs);

        const toChoice = (entry, skillName) => ({
            name: entry.name,
            value: entry,
            description: entry.description,
            tags: entry.tags,
            annotation: formatVersionHint(getArtifactVersion(lock, join(".agents", "skills", skillName, "SKILL.md")), entry.version),
            disabled: globalSet.has(skillName) && "installed globally",
        });

        const instructionChoices = instructions.map((entry) => toChoice(entry, toSkillName(entry.filename)));
        const promptChoices = prompts.map((entry) => toChoice(entry, toSkillName(entry.commandFilename)));
        const alreadyGlobal = [...instructionChoices, ...promptChoices].filter((choice) => choice.disabled).map((choice) => choice.name);

        const selectedAssets = await selectUntilConfirmed(
            async (previous = {}) => ({
                selectedInstructions: await pickAssets({ message: "Select instruction files", choices: restoreChecked(instructionChoices, previous.selectedInstructions) }),
                selectedPrompts: await pickAssets({ message: "Select prompt files", choices: restoreChecked(promptChoices, previous.selectedPrompts) }),
            }),
            ({ selectedInstructions, selectedPrompts }) => [
                { title: "Instruction files", items: selectedInstructions.map(({ name }) => name) },
                { title: "Prompt files", items: selectedPrompts.map(({ name }) => name) },
                { title: "Already installed globally", items: alreadyGlobal, note: true },
            ],
            "Install selected files",
            ({ selectedInstructions, selectedPrompts }) => selectedInstructions.length + selectedPrompts.length === 0,
        );
        if (selectedAssets === undefined) {
            consola.info("No files selected.");
            return;
        }
        if (selectedAssets === null) return;
        const { selectedInstructions, selectedPrompts } = selectedAssets;

        const selectedTools = new Set(await selectTargetTools(packs));
        const instructionResult = selectedInstructions.length > 0 ? await installInstructions(selectedInstructions, destRoot, selectedTools, lock, { packs }) : { changed: false, lock };
        const promptResult = selectedPrompts.length > 0 ? await installPrompts(selectedPrompts, destRoot, selectedTools, instructionResult.lock, { packs }) : instructionResult;
        if (instructionResult.changed || promptResult.changed) writeLockFile(destRoot, promptResult.lock);
    } catch (e) {
        if (!isPromptCancellation(e)) throw e;
        handleError(e);
    }
};

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    if (process.argv[2] === "--global") {
        try {
            await installGlobal();
        } catch (e) {
            if (!isPromptCancellation(e)) throw e;
            handleError(e);
        }
    } else {
        await askUser();
    }
}
