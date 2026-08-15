import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import consola from "consola";
import inquirer from "inquirer";
import { buildTagsStr, formatVersionHint, handleError, loadJsonCatalog, readLockFile, resolvePageSize, selectTargetTool, setupConsola, TOOLS, writeLockFile, writeWithConflict } from "../shared/utils.js";

/**
 * @fileoverview Interactive installer for agent instruction and prompt templates.
 *
 * Source-of-truth strategy:
 *
 *   Instructions:
 *     Claude / All  → .claude/rules/<name>.md                        (Copilot and Claude Code both read this natively)
 *     Copilot only  → .github/instructions/<name>.instructions.md
 *
 *   Prompts:
 *     Copilot / All → .github/prompts/<name>.prompt.md               (canonical)
 *     All           → .claude/commands/<name>.md                     (wrapper referencing .github/prompts/, no version)
 *     Claude only   → .claude/commands/<name>.md                     (full content, self-contained)
 *
 * On install, updates template-lock.json in the project root with the written paths and versions.
 * Wrapper files (.claude/commands/ under tool=all) are not tracked since they carry no version.
 * Version display in the UI is read from template-lock.json (single source of truth for installed versions).
 *
 * Installed at /opt/devcontainer/installer/agents/ inside the container.
 */

setupConsola();

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Constants ───────────────────────────────────────────────────────────────

const BASE_CATALOG_KEYS = ["name", "filename", "version", "templateFile"];
const COPILOT_INSTRUCTION_KEYS = ["applyTo", "name"];
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
 * Build the content for a .claude/rules/ file from a Copilot instruction template.
 * Strips Copilot-specific frontmatter keys (name), preserving description and body.
 * Translates `applyTo` into Claude Code's `paths:` field, the only field Claude Code
 * reads for conditional rule loading. When `applyTo` targets every file (`**`), `paths`
 * is omitted so the rule loads unconditionally at session start, matching Claude Code's
 * own convention for rules without `paths:`.
 *
 * @param {string} templateContent
 * @returns {string}
 */
const buildClaudeRuleContent = (templateContent) => {
    const { raw, body } = parseFrontmatter(templateContent);
    const filtered = Object.fromEntries(Object.entries(raw).filter(([k]) => !COPILOT_INSTRUCTION_KEYS.includes(k)));

    if (raw.applyTo && !appliesToAllFiles(raw.applyTo)) {
        filtered.paths = [raw.applyTo];
    }

    return buildFrontmatter(filtered, body);
};

/**
 * Build a .claude/commands/ wrapper that delegates to the canonical .github/prompts/ file.
 * Used in the All scenario. Has no version since .github/prompts/ tracks it.
 * 
 * @param {object} item - Prompt catalog entry.
 * @param {Record<string, string>} raw - Parsed frontmatter from the template.
 * @returns {string}
 */
const buildClaudeCommandWrapper = (item, raw) => {
    const lines = ["---"];
    if (raw.description) lines.push(`description: ${raw.description}`);
    if (raw["argument-hint"]) lines.push(`argument-hint: ${raw["argument-hint"]}`);
    lines.push("---", "", `Follow @../../.github/prompts/${item.filename}.`);

    return lines.join("\n") + "\n";
};

/**
 * Build a self-contained .claude/commands/ file for Claude-only installs.
 * Strips Copilot-specific frontmatter keys. Claude Code automatically appends
 * the user's argument when $ARGUMENTS is absent from the content.
 *
 * @param {string} templateContent
 * @returns {string}
 */
const buildClaudeCommandFull = (templateContent) => {
    const { raw, body } = parseFrontmatter(templateContent);
    const filtered = Object.fromEntries(Object.entries(raw).filter(([k]) => !COPILOT_PROMPT_KEYS.includes(k)));

    return buildFrontmatter(filtered, body);
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
 * Write instruction files to the appropriate directory based on the selected tool.
 * Returns a map of written relative paths to their installed versions.
 *
 * Claude / All  → .claude/rules/<basename>.md
 * Copilot only  → .github/instructions/<filename>
 *
 * @param {object[]} instructions - Selected instruction entries.
 * @param {string} destRoot - Project root directory.
 * @param {string} tool - One of TOOLS.copilot | TOOLS.claude | TOOLS.all.
 * @param {object} lock - Parsed template-lock.json used to resolve the currently installed version.
 * @returns {Promise<Record<string, string>>}
 */
const installInstructions = async (instructions, destRoot, tool, lock) => {
    const written = {};

    if (tool === TOOLS.claude || tool === TOOLS.all) {
        const rulesDir = join(destRoot, ".claude", "rules");
        mkdirSync(rulesDir, { recursive: true });
        for (const item of instructions) {
            const template = readFileSync(join(__dirname, "templates", item.templateFile), "utf8");
            const content = buildClaudeRuleContent(template);
            const filename = toClaudeRuleFilename(item.filename);
            const relPath = join(".claude", "rules", filename);
            const ok = await writeWithConflict(join(rulesDir, filename), content, filename, item.version, lock.instructions[relPath] ?? null);
            if (ok) written[relPath] = item.version;
        }
    }

    if (tool === TOOLS.copilot) {
        const instructionsDir = join(destRoot, ".github", "instructions");
        mkdirSync(instructionsDir, { recursive: true });
        for (const item of instructions) {
            const content = readFileSync(join(__dirname, "templates", item.templateFile), "utf8");
            const relPath = join(".github", "instructions", item.filename);
            const ok = await writeWithConflict(join(instructionsDir, item.filename), content, item.filename, item.version, lock.instructions[relPath] ?? null);
            if (ok) written[relPath] = item.version;
        }
    }

    return written;
};

/**
 * Write prompt files to the appropriate directories based on the selected tool.
 * Returns a map of written relative paths to their installed versions.
 * Wrapper files (tool = all) are not tracked since they carry no version.
 *
 * Copilot / All  → .github/prompts/<filename>              (canonical, Copilot-native format)
 * All            → .claude/commands/<commandFilename>      (wrapper referencing .github/prompts/)
 * Claude only    → .claude/commands/<commandFilename>      (full content, self-contained)
 *
 * @param {object[]} prompts - Selected prompt entries.
 * @param {string} destRoot - Project root directory.
 * @param {string} tool - One of TOOLS.copilot | TOOLS.claude | TOOLS.all.
 * @param {object} lock - Parsed template-lock.json used to resolve the currently installed version.
 * @returns {Promise<Record<string, string>>}
 */
const installPrompts = async (prompts, destRoot, tool, lock) => {
    const written = {};
    const templateCache = new Map(
        prompts.map((item) => [item.templateFile, readFileSync(join(__dirname, "templates", item.templateFile), "utf8")])
    );

    if (tool === TOOLS.copilot || tool === TOOLS.all) {
        const promptsDir = join(destRoot, ".github", "prompts");
        mkdirSync(promptsDir, { recursive: true });
        for (const item of prompts) {
            const content = templateCache.get(item.templateFile);
            const relPath = join(".github", "prompts", item.filename);
            const ok = await writeWithConflict(join(promptsDir, item.filename), content, item.filename, item.version, lock.prompts[relPath] ?? null);
            if (ok) written[relPath] = item.version;
        }
    }

    if (tool === TOOLS.claude || tool === TOOLS.all) {
        const commandsDir = join(destRoot, ".claude", "commands");
        mkdirSync(commandsDir, { recursive: true });
        for (const item of prompts) {
            const template = templateCache.get(item.templateFile);
            const { raw } = parseFrontmatter(template);
            const content = tool === TOOLS.all
                ? buildClaudeCommandWrapper(item, raw)
                : buildClaudeCommandFull(template);
            const version = tool === TOOLS.all ? null : item.version;
            const relPath = join(".claude", "commands", item.commandFilename);
            const ok = await writeWithConflict(join(commandsDir, item.commandFilename), content, item.commandFilename, version, version ? (lock.prompts[relPath] ?? null) : null);
            if (ok && version) written[relPath] = version;
        }
    }

    return written;
};

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
            const claudeRelPath = join(".claude", "rules", toClaudeRuleFilename(filename));
            const copilotRelPath = join(".github", "instructions", filename);
            const installedVersion = lock.instructions[claudeRelPath] ?? lock.instructions[copilotRelPath] ?? null;
            const versionStr = formatVersionHint(installedVersion, version);
            return {
                name: `${name} ${versionStr} ${buildTagsStr(tags)}`,
                value: { filename, version, name, tags, templateFile },
                description: readTemplateDescription(templateFile),
            };
        });

        const promptChoices = prompts.map(({ filename, commandFilename, version, name, tags, templateFile }) => {
            const copilotRelPath = join(".github", "prompts", filename);
            const claudeRelPath = join(".claude", "commands", commandFilename);
            const installedVersion = lock.prompts[copilotRelPath] ?? lock.prompts[claudeRelPath] ?? null;
            const versionStr = formatVersionHint(installedVersion, version);
            return {
                name: `${name} ${versionStr} ${buildTagsStr(tags)}`,
                value: { filename, commandFilename, version, name, tags, templateFile },
                description: readTemplateDescription(templateFile),
            };
        });

        const { selectedInstructions } = await inquirer.prompt([{
            type: "checkbox",
            name: "selectedInstructions",
            message: "Select instruction files to install:",
            choices: instructionChoices,
            pageSize: resolvePageSize(instructionChoices.length),
        }]);

        const { selectedPrompts } = await inquirer.prompt([{
            type: "checkbox",
            name: "selectedPrompts",
            message: "Select prompt files to install:",
            choices: promptChoices,
            pageSize: resolvePageSize(promptChoices.length),
        }]);

        if (selectedInstructions.length + selectedPrompts.length === 0) {
            consola.info("No files selected.");
            return;
        }

        const selectedTool = await selectTargetTool();
        const writtenFlags = [];

        if (selectedInstructions.length > 0) {
            const writtenInstructions = await installInstructions(selectedInstructions, destRoot, selectedTool, lock);
            Object.assign(lock.instructions, writtenInstructions);
            writtenFlags.push(Object.keys(writtenInstructions).length > 0);
        }
        if (selectedPrompts.length > 0) {
            const writtenPrompts = await installPrompts(selectedPrompts, destRoot, selectedTool, lock);
            Object.assign(lock.prompts, writtenPrompts);
            writtenFlags.push(Object.keys(writtenPrompts).length > 0);
        }

        if (writtenFlags.some(Boolean)) writeLockFile(destRoot, lock);
    } catch (e) {
        handleError(e);
    }
};

await askUser();
