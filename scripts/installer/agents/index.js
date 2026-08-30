import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import consola from "consola";
import { checkbox } from "@inquirer/prompts";
import { buildTagsStr, CLEAR_ON_DONE, formatVersionHint, getArtifactVersion, handleError, loadJsonCatalog, readLockFile, reconcileArtifactAdapters, recordArtifact, resolvePageSize, selectTargetTools, selectUntilConfirmed, setupConsola, TOOLS, writeLockFile, writeWithConflict } from "../shared/utils.js";
import { ensureClaudeRuleSymlink, ensureClaudeSkillSymlink } from "../skills/local/index.js";

/**
 * @fileoverview Interactive installer for agent instruction and prompt templates.
 *
 * Canonical source and adapter strategy:
 *
 *   Canonical skills (always):
 *     Instructions → .agents/skills/<instruction>/SKILL.md
 *     Commands     → .agents/skills/<command>/SKILL.md
 *
 *   Native adapters (only for selected agents):
 *     Claude Code    → selective symlinks in .claude/rules/ and .claude/skills/
 *     GitHub Copilot → .github/instructions/ and .github/prompts/
 *     Codex          → no adapter; reads AGENTS.md and .agents/skills directly
 *
 * Claude adapters are symlinks to the canonical skill, so there is never a second editable
 * copy. Copilot still receives materialized native adapters because its path-specific
 * instruction and prompt formats are not Agent Skills.
 *
 * On install, updates template-lock.json with each canonical asset's version and the
 * native adapters materialized for it. Version display in the UI reads that manifest.
 *
 * Installed at /opt/devcontainer/installer/agents/ inside the container.
 */

setupConsola();

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Constants ───────────────────────────────────────────────────────────────

const BASE_CATALOG_KEYS = ["name", "filename", "version", "templateFile"];
const COPILOT_PROMPT_KEYS = ["agent", "name"];
const INSTRUCTIONS_FILE_URL = new URL("./instructions.json", import.meta.url);
const PROMPTS_FILE_URL = new URL("./prompts.json", import.meta.url);

// ─── Frontmatter helpers ─────────────────────────────────────────────────────

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

// ─── Filename helpers ────────────────────────────────────────────────────────

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

const claudeRuleAdapter = (skillName, filename) => ({
    path: join(".claude", "rules", filename),
    type: "symlink",
    target: join(".agents", "skills", skillName, "SKILL.md"),
});

const claudeSkillAdapter = (skillName) => ({
    path: join(".claude", "skills", skillName),
    type: "symlink",
    target: join(".agents", "skills", skillName),
});

// ─── Claude content builders ─────────────────────────────────────────────────

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
    const { raw } = parseFrontmatter(readFileSync(join(__dirname, "templates", templateFile), "utf8"));
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

// ─── Catalog loaders ─────────────────────────────────────────────────────────

/**
 * Load and validate a catalog JSON file.
 *
 * @param {URL} url - URL to the catalog JSON file.
 * @param {string[]} extraKeys - Additional required string keys beyond the base set.
 * @param {string} catalogName - Used in error messages (e.g. "instructions", "prompts").
 * @returns {object[]}
 * @throws Will throw an error if the catalog is invalid or cannot be read.
 */
const loadCatalog = (url, extraKeys, catalogName) => {
    const entries = loadJsonCatalog(url);
    const requiredKeys = [...BASE_CATALOG_KEYS, ...extraKeys];
    for (const [index, entry] of entries.entries()) {
        const isValid =
            requiredKeys.every((key) => typeof entry?.[key] === "string")
            && Array.isArray(entry?.tags)
            && entry.tags.every((tag) => typeof tag === "string");
        if (!isValid) throw new Error(`Invalid ${catalogName} catalog entry at index ${index}.`);
    }
    return entries;
};

// ─── Installers ──────────────────────────────────────────────────────────────

/**
 * Install canonical Agent Skills and the native adapters for one catalog type.
 * The type-specific descriptor contains only the naming and adapter differences.
 * @param {object[]} entries - Selected catalog entries.
 * @param {string} destRoot - Project root directory.
 * @param {Set<string>} tools - Selected values from TOOLS.
 * @param {object} lock - Parsed template-lock.json.
 * @param {{ writer?: typeof writeWithConflict }} options - File writer override for tests.
 * @param {object} spec - Type-specific skill and adapter operations.
 * @returns {Promise<boolean>} Whether the lock manifest changed.
 */
const installAgentAssets = async (entries, destRoot, tools, lock, options, spec) => {
    const changedPaths = new Set();
    const writer = options.writer ?? writeWithConflict;
    const templates = new Map(entries.map((entry) => [
        entry.templateFile,
        readFileSync(join(__dirname, "templates", entry.templateFile), "utf8"),
    ]));
    const managedPaths = new Set(entries
        .map((entry) => join(".agents", "skills", spec.skillName(entry), "SKILL.md"))
        .filter((path) => lock.artifacts[path]));

    for (const entry of entries) {
        const skillName = spec.skillName(entry);
        const canonicalPath = join(".agents", "skills", skillName, "SKILL.md");
        const { written } = await installCanonicalSkill(
            destRoot,
            skillName,
            spec.buildCanonicalContent(templates.get(entry.templateFile), skillName),
            entry.version,
            getArtifactVersion(lock, canonicalPath),
            writer,
        );
        if (written) {
            recordArtifact(lock, canonicalPath, { kind: spec.kind, version: entry.version });
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
                installedVersion: getArtifactVersion(lock, canonicalPath),
            });
            if (materialized) {
                recordArtifact(lock, canonicalPath, { kind: spec.kind, adapters: { [adapter.name]: [materialized] } });
                changedPaths.add(canonicalPath);
            }
        }
    }

    for (const path of managedPaths) {
        if (reconcileArtifactAdapters(lock, destRoot, path)) changedPaths.add(path);
    }
    return changedPaths.size > 0;
};

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

const instructionSpec = {
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
};

const promptSpec = {
    kind: "prompt",
    skillName: (entry) => toSkillName(entry.commandFilename),
    buildCanonicalContent: (template, skillName) => buildCanonicalSkillContent(template, skillName),
    adapters: [
        createCopilotAdapter(join(".github", "prompts")),
        {
            name: "claude",
            tool: TOOLS.claude,
            install: ({ destRoot, skillName }) => {
                ensureClaudeSkillSymlink(destRoot, skillName);
                return claudeSkillAdapter(skillName);
            },
        },
    ],
};

export const installInstructions = (instructions, destRoot, tools, lock, options = {}) =>
    installAgentAssets(instructions, destRoot, tools, lock, options, instructionSpec);

export const installPrompts = (prompts, destRoot, tools, lock, options = {}) =>
    installAgentAssets(prompts, destRoot, tools, lock, options, promptSpec);

// ─── Main ────────────────────────────────────────────────────────────────────

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

        const instructionChoices = instructions.map(({ filename, version, name, tags, templateFile }) => {
            const canonicalRelPath = join(".agents", "skills", toSkillName(filename), "SKILL.md");
            const installedVersion = getArtifactVersion(lock, canonicalRelPath);
            const versionStr = formatVersionHint(installedVersion, version);
            return {
                name: `${name} ${versionStr} ${buildTagsStr(tags)}`,
                value: { filename, version, name, tags, templateFile },
                description: readTemplateDescription(templateFile),
            };
        });

        const promptChoices = prompts.map(({ filename, commandFilename, version, name, tags, templateFile }) => {
            const canonicalRelPath = join(".agents", "skills", toSkillName(commandFilename), "SKILL.md");
            const installedVersion = getArtifactVersion(lock, canonicalRelPath);
            const versionStr = formatVersionHint(installedVersion, version);
            return {
                name: `${name} ${versionStr} ${buildTagsStr(tags)}`,
                value: { filename, commandFilename, version, name, tags, templateFile },
                description: readTemplateDescription(templateFile),
            };
        });

        const selectedAssets = await selectUntilConfirmed(
            async () => ({
                selectedInstructions: await checkbox({
                    message: "Select instruction files to install:",
                    choices: instructionChoices,
                    pageSize: resolvePageSize(instructionChoices.length),
                }, CLEAR_ON_DONE),
                selectedPrompts: await checkbox({
                    message: "Select prompt files to install:",
                    choices: promptChoices,
                    pageSize: resolvePageSize(promptChoices.length),
                }, CLEAR_ON_DONE),
            }),
            ({ selectedInstructions, selectedPrompts }) => [
                { title: "Instruction files", items: selectedInstructions.map(({ name }) => name) },
                { title: "Prompt files", items: selectedPrompts.map(({ name }) => name) },
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
        const writtenFlags = [];

        if (selectedInstructions.length > 0) {
            writtenFlags.push(await installInstructions(selectedInstructions, destRoot, selectedTools, lock));
        }
        if (selectedPrompts.length > 0) {
            writtenFlags.push(await installPrompts(selectedPrompts, destRoot, selectedTools, lock));
        }

        if (writtenFlags.some(Boolean)) {
            writeLockFile(destRoot, lock);
        }
    } catch (e) {
        handleError(e);
    }
};

if (import.meta.url === `file://${process.argv[1]}`) await askUser();
