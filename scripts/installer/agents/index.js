import { readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadJsonObject, loadValidatedCatalog } from "../lib/catalog.js";
import { TOOLS } from "../lib/constants.js";
import { readGlobalSkillSet } from "../lib/global-skill-set.js";
import { claudeRuleAdapter, claudeSkillAdapter, getArtifactVersion, readLockFile, reconcileArtifactAdapters, recordArtifact, writeLockFile } from "../lib/lock-file.js";
import { pickAssets } from "../lib/pick-assets.js";
import { formatVersionHint, restoreChecked, selectTargetTools, selectUntilConfirmed } from "../lib/prompts.js";
import { handleError, isPromptCancellation, setupConsola } from "../lib/utils.js";
import { writeOverwrite, writeWithConflict } from "../lib/write-file.js";
import { ensureClaudeRuleSymlink, ensureClaudeSkillSymlink } from "../skills/local/index.js";

/**
 * @fileoverview Interactive installer for agent instruction and prompt templates. See
 * `docs/wiki/installer/agents.md`. Claude adapters remain symlinks to the canonical skill;
 * Copilot needs materialized adapters for its path-specific formats.
 *
 * Installed at /opt/devcontainer/installer/agents/ inside the container.
 */

const consola = setupConsola();

const BASE_CATALOG_KEYS = ["name", "filename", "version", "templateFile"];
const INSTRUCTIONS_FILE_URL = new URL("./instructions.json", import.meta.url);
const PROMPTS_FILE_URL = new URL("./prompts.json", import.meta.url);
const GLOBAL_MANIFEST_URL = new URL("./agents.global.json", import.meta.url);
const TEMPLATES_URL = new URL("./templates/", import.meta.url);

/**
 * Parse YAML frontmatter from markdown content.
 * Values are returned as raw strings, preserving any surrounding quotes.
 * 
 * @param {string} content
 * @returns {{ raw: Record<string, string>, body: string }}
 */
const parseFrontmatter = (content) => {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) return { raw: {}, body: content };
    const raw = {};
    for (const line of match[1].split(/\r?\n/)) {
        const m = line.match(/^([\w-]+):\s*(.*)$/);
        if (m) raw[m[1]] = m[2].trim();
    }
    return { raw, body: match[2] };
};

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
 * Derive the .claude/rules/ filename from a Copilot instruction filename.
 * Example: agent-orchestration.instructions.md → agent-orchestration.md
 * 
 * @param {string} instructionFilename
 * @returns {string}
 */
const toClaudeRuleFilename = (instructionFilename) => instructionFilename.replace(".instructions.md", ".md");

/**
 * Derive a portable Agent Skill directory name from a catalog filename.
 * @param {string} filename - A catalog filename such as "bash.instructions.md".
 * @returns {string}
 */
const toSkillName = (filename) => filename
    .replace(/\.instructions\.md$/, "")
    .replace(/\.prompt\.md$/, "")
    .replace(/\.md$/, "");

/**
 * Strip a single layer of surrounding double quotes from a raw frontmatter value.
 *
 * @param {string} value
 * @returns {string}
 */
const stripQuotes = (value) => value.replace(/^"|"$/g, "");

/**
 * Whether a Copilot `applyTo` glob targets every file, e.g. `"**"` or `**`.
 *
 * @param {string} applyTo - Raw (possibly quoted) applyTo value.
 * @returns {boolean}
 */
const appliesToAllFiles = (applyTo) => stripQuotes(applyTo) === "**";

/**
 * Read a template file's own frontmatter `description` for display in the picker,
 * so the picker never carries a second, driftable copy of it.
 *
 * @param {string} templateFile - Path relative to templates/, e.g. "instructions/bash.instructions.md".
 * @returns {string}
 */
const readTemplateDescription = (templateFile) => {
    const { raw } = parseFrontmatter(readFileSync(new URL(templateFile, TEMPLATES_URL), "utf8"));
    return stripQuotes(raw.description ?? "");
};

/**
 * Build the portable SKILL.md representation of an instruction or command template.
 * Instruction skills retain Claude's optional `paths` metadata so the same physical file
 * can be loaded through a `.claude/rules` symlink. Codex requires `name` and `description`
 * and ignores additional frontmatter fields.
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
 * Install an Agent Skill source in the layout shared by Codex, Copilot, and Claude Code.
 * @param {string} destRoot - Project root directory.
 * @param {string} skillName - Portable Agent Skill name.
 * @param {string} content - Canonical SKILL.md content.
 * @param {string} version - Catalog version.
 * @param {string|null} installedVersion - Version recorded for this skill in the lock file.
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
 * Load and validate a catalog JSON file.
 *
 * @param {URL} url - URL to the catalog JSON file.
 * @param {string[]} extraKeys - Additional required string keys beyond the base set.
 * @param {string} catalogName - Used in error messages (e.g. "instructions", "prompts").
 * @returns {object[]}
 * @throws Will throw an error if the catalog is invalid or cannot be read.
 */
const loadCatalog = (url, extraKeys, catalogName) => loadValidatedCatalog(url, catalogName, {
    strings: [...BASE_CATALOG_KEYS, ...extraKeys],
    stringArrays: ["tags"],
    safeRelativePaths: ["templateFile"],
});

/**
 * Install canonical Agent Skills and the native adapters for one catalog type.
 * The type-specific descriptor contains only the naming and adapter differences.
 * @param {object[]} entries - Selected catalog entries.
 * @param {string} destRoot - Project root directory.
 * @param {Set<string>} tools - Selected values from TOOLS.
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
        readFileSync(new URL(entry.templateFile, TEMPLATES_URL), "utf8"),
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
    name: "copilot",
    tool: TOOLS.copilot,
    prepare: (destRoot) => mkdirSync(join(destRoot, directory), { recursive: true }),
    install: async ({ destRoot, entry, template, writer, version, installedVersion }) => {
        const relPath = join(directory, entry.filename);
        const written = await writer(join(destRoot, relPath), template, entry.filename, version, installedVersion);
        return written ? { path: relPath, type: "file" } : null;
    },
});

/**
 * Build the Claude adapter that exposes a canonical skill as a `.claude/skills/` symlink.
 * @returns {{ name: string, tool: string, install: (ctx: object) => object }}
 */
const claudeSkillSymlinkAdapter = () => ({
    name: "claude",
    tool: TOOLS.claude,
    install: ({ destRoot, skillName }) => {
        ensureClaudeSkillSymlink(destRoot, skillName);
        return claudeSkillAdapter(skillName);
    },
});

/**
 * Build the instruction-type skill and adapter spec consumed by `installAgentAssets`.
 * A factory so it can sit after the helpers it references while keeping all module
 * constants ahead of every function.
 * @returns {object}
 */
const instructionSpec = () => ({
    kind: "instruction",
    skillName: (entry) => toSkillName(entry.filename),
    buildCanonicalContent: (template, skillName) => buildCanonicalSkillContent(template, skillName, true),
    adapters: [
        {
            name: "claude",
            tool: TOOLS.claude,
            install: ({ destRoot, entry, skillName }) => {
                const filename = toClaudeRuleFilename(entry.filename);
                ensureClaudeRuleSymlink(destRoot, skillName, filename);
                return claudeRuleAdapter(skillName, filename);
            },
        },
        createCopilotAdapter(join(".github", "instructions")),
    ],
});

/**
 * Build the prompt-type skill and adapter spec consumed by `installAgentAssets`.
 * A factory for the same reason as `instructionSpec`.
 * @returns {object}
 */
const promptSpec = () => ({
    kind: "prompt",
    skillName: (entry) => toSkillName(entry.commandFilename),
    buildCanonicalContent: (template, skillName) => buildCanonicalSkillContent(template, skillName),
    adapters: [
        createCopilotAdapter(join(".github", "prompts")),
        claudeSkillSymlinkAdapter(),
    ],
});

/**
 * Install selected instruction skills and their native adapters, updating the lock manifest.
 * @param {object[]} instructions - Selected instruction catalog entries.
 * @param {string} destRoot - Project root directory.
 * @param {Set<string>} tools - Selected values from TOOLS.
 * @param {object} lock - Parsed template-lock.json.
 * @param {{ writer?: typeof writeWithConflict }} [options] - File writer override for tests.
 * @returns {Promise<{ changed: boolean, lock: object }>} Whether the lock changed and updated lock data.
 */
export const installInstructions = (instructions, destRoot, tools, lock, options = {}) =>
    installAgentAssets(instructions, destRoot, tools, lock, options, instructionSpec());

/**
 * Install selected prompt (command) skills and their native adapters, updating the lock manifest.
 * @param {object[]} prompts - Selected prompt catalog entries.
 * @param {string} destRoot - Project root directory.
 * @param {Set<string>} tools - Selected values from TOOLS.
 * @param {object} lock - Parsed template-lock.json.
 * @param {{ writer?: typeof writeWithConflict }} [options] - File writer override for tests.
 * @returns {Promise<{ changed: boolean, lock: object }>} Whether the lock changed and updated lock data.
 */
export const installPrompts = (prompts, destRoot, tools, lock, options = {}) =>
    installAgentAssets(prompts, destRoot, tools, lock, options, promptSpec());

/**
 * Load and validate this installer's machine-wide manifest (`agents.global.json`): the
 * instruction and prompt skill names materialized into the shared `~/.agents` tree.
 * @returns {{ instructions: string[], prompts: string[] }}
 * @throws If a section is missing or is not an array of non-empty strings.
 */
const loadGlobalAgentManifest = () => {
    const manifest = loadJsonObject(GLOBAL_MANIFEST_URL);
    for (const key of ["instructions", "prompts"]) {
        const list = Object.hasOwn(manifest, key) ? manifest[key] : null;
        if (!Array.isArray(list) || !list.every((name) => typeof name === "string" && name.length > 0)) {
            throw new Error(`Invalid agents.global.json: "${key}" must be an array of names.`);
        }
    }
    return manifest;
};

/**
 * Materialize the instruction and prompt skills named in `agents.global.json` into the
 * shared machine-wide `~/.agents` tree (canonical `~/.agents/skills/<name>/SKILL.md`) plus
 * `~/.claude` adapters, tracked in `~/.agents/template-lock.json`. Non-interactive:
 * conflicts are resolved by overwrite (the template is the source of truth for a global
 * asset), and only the Claude adapter is materialized — Codex reads `~/.agents/skills`
 * directly. Assumes `CLAUDE_CONFIG_DIR` is `~/.claude`, as the devcontainer image sets it.
 *
 * @param {{ writer?: typeof writeOverwrite }} [options] - Writer override for tests.
 * @returns {Promise<void>}
 */
export const installGlobal = async (options = {}) => {
    const manifest = loadGlobalAgentManifest();
    const wantInstructions = new Set(manifest.instructions);
    const wantPrompts = new Set(manifest.prompts);

    const instructions = loadCatalog(INSTRUCTIONS_FILE_URL, [], "instructions")
        .filter((entry) => wantInstructions.has(toSkillName(entry.filename)));
    const prompts = loadCatalog(PROMPTS_FILE_URL, ["commandFilename"], "prompts")
        .filter((entry) => wantPrompts.has(toSkillName(entry.commandFilename)));

    const resolvedInstructions = instructions.map((entry) => toSkillName(entry.filename));
    const resolvedPrompts = prompts.map((entry) => toSkillName(entry.commandFilename));
    const missing = [
        ...manifest.instructions.filter((name) => !resolvedInstructions.includes(name)),
        ...manifest.prompts.filter((name) => !resolvedPrompts.includes(name)),
    ];
    if (missing.length > 0) throw new Error(`agents.global.json names absent from the catalog: ${missing.join(", ")}`);

    const destRoot = homedir();
    const lockRoot = join(destRoot, ".agents");
    const lock = readLockFile(lockRoot);
    const tools = new Set([TOOLS.claude]);
    const opts = { writer: options.writer ?? writeOverwrite };

    const instructionResult = instructions.length > 0 ? await installAgentAssets(instructions, destRoot, tools, lock, opts, instructionSpec()) : { changed: false, lock };
    const promptResult = prompts.length > 0 ? await installAgentAssets(prompts, destRoot, tools, instructionResult.lock, opts, promptSpec()) : instructionResult;

    if (instructionResult.changed || promptResult.changed) writeLockFile(lockRoot, promptResult.lock);
    const synced = [...resolvedInstructions, ...resolvedPrompts].sort().join(", ");
    consola.success(`Global agent assets synced: ${synced || "(agents.global.json is empty)"}`);
};

/**
 * Prompt the user to select instruction and prompt templates, then install them.
 * On completion, updates template-lock.json in the project root with the installed versions.
 */
const askUser = async () => {
    try {
        const instructions = loadCatalog(INSTRUCTIONS_FILE_URL, [], "instructions");
        const prompts = loadCatalog(PROMPTS_FILE_URL, ["commandFilename"], "prompts");
        const destRoot = process.cwd();
        const lock = readLockFile(destRoot);
        const globalSet = readGlobalSkillSet();

        const toChoice = (entry, skillName) => ({
            name: entry.name,
            value: entry,
            description: readTemplateDescription(entry.templateFile),
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

        const selectedTools = new Set(await selectTargetTools());
        const instructionResult = selectedInstructions.length > 0 ? await installInstructions(selectedInstructions, destRoot, selectedTools, lock) : { changed: false, lock };
        const promptResult = selectedPrompts.length > 0 ? await installPrompts(selectedPrompts, destRoot, selectedTools, instructionResult.lock) : instructionResult;
        if (instructionResult.changed || promptResult.changed) writeLockFile(destRoot, promptResult.lock);
    } catch (e) {
        if (!isPromptCancellation(e)) throw e;
        handleError(e);
    }
};

if (import.meta.url === `file://${process.argv[1]}`) {
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
