import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import consola from "consola";
import inquirer from "inquirer";
import { select } from "@inquirer/prompts";
import { buildTagsStr, handleError, loadJsonCatalog, readInstalledVersion, setupConsola, writeWithConflict } from "../shared/utils.js";

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
 *     All           → .claude/commands/<name>.md                     (wrapper referencing .github/prompts/)
 *     Claude only   → .claude/commands/<name>.md                     (full content, self-contained)
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
const TOOL = { copilot: "copilot", claude: "claude", all: "all" };

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
 * Field values are written as-is, preserving the original quoting from the source template.
 * 
 * @param {Record<string, string>} fields
 * @param {string} body
 * @returns {string}
 */
const buildFrontmatter = (fields, body) => {
    const fm = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n");
    return `---\n${fm}\n---\n${body}`;
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
 * Build the content for a .claude/rules/ file from a Copilot instruction template.
 * Strips Copilot-specific frontmatter keys, preserving version, description, and body.
 * 
 * @param {string} templateContent
 * @returns {string}
 */
const buildClaudeRuleContent = (templateContent) => {
    const { raw, body } = parseFrontmatter(templateContent);
    const filtered = Object.fromEntries(Object.entries(raw).filter(([k]) => !COPILOT_INSTRUCTION_KEYS.includes(k)));
    
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
    lines.push("---", "", `Follow @../../.github/prompts/${item.filename}.`, "", "$ARGUMENTS");
    
    return lines.join("\n") + "\n";
};

/**
 * Build a self-contained .claude/commands/ file for Claude-only installs.
 * Strips Copilot-specific frontmatter keys, keeps version for conflict detection,
 * and appends $ARGUMENTS so the user's input is forwarded to the command.
 * 
 * @param {string} templateContent
 * @returns {string}
 */
const buildClaudeCommandFull = (templateContent) => {
    const { raw, body } = parseFrontmatter(templateContent);
    const filtered = Object.fromEntries(Object.entries(raw).filter(([k]) => !COPILOT_PROMPT_KEYS.includes(k)));
    
    return buildFrontmatter(filtered, body.trimEnd() + "\n\n$ARGUMENTS\n");
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
 *
 * Claude / All  → .claude/rules/<basename>.md  (Copilot also reads this natively in VS Code)
 * Copilot only  → .github/instructions/<filename>
 *
 * @param {object[]} instructions - Selected instruction entries.
 * @param {string} destRoot - Project root directory.
 * @param {string} tool - One of TOOL.copilot | TOOL.claude | TOOL.all.
 */
const installInstructions = async (instructions, destRoot, tool) => {
    if (tool === TOOL.claude || tool === TOOL.all) {
        const rulesDir = join(destRoot, ".claude", "rules");
        mkdirSync(rulesDir, { recursive: true });
        for (const item of instructions) {
            const template = readFileSync(join(__dirname, "templates", item.templateFile), "utf8");
            const content = buildClaudeRuleContent(template);
            const filename = toClaudeRuleFilename(item.filename);
            await writeWithConflict(join(rulesDir, filename), content, filename, item.version);
        }
    }

    if (tool === TOOL.copilot) {
        const instructionsDir = join(destRoot, ".github", "instructions");
        mkdirSync(instructionsDir, { recursive: true });
        for (const item of instructions) {
            const content = readFileSync(join(__dirname, "templates", item.templateFile), "utf8");
            await writeWithConflict(join(instructionsDir, item.filename), content, item.filename, item.version);
        }
    }
};

/**
 * Write prompt files to the appropriate directories based on the selected tool.
 *
 * Copilot / All  → .github/prompts/<filename>              (canonical, Copilot-native format)
 * All            → .claude/commands/<commandFilename>      (wrapper referencing .github/prompts/)
 * Claude only    → .claude/commands/<commandFilename>      (full content, self-contained)
 *
 * @param {object[]} prompts - Selected prompt entries.
 * @param {string} destRoot - Project root directory.
 * @param {string} tool - One of TOOL.copilot | TOOL.claude | TOOL.all.
 */
const installPrompts = async (prompts, destRoot, tool) => {
    if (tool === TOOL.copilot || tool === TOOL.all) {
        const promptsDir = join(destRoot, ".github", "prompts");
        mkdirSync(promptsDir, { recursive: true });
        for (const item of prompts) {
            const content = readFileSync(join(__dirname, "templates", item.templateFile), "utf8");
            await writeWithConflict(join(promptsDir, item.filename), content, item.filename, item.version);
        }
    }

    if (tool === TOOL.claude || tool === TOOL.all) {
        const commandsDir = join(destRoot, ".claude", "commands");
        mkdirSync(commandsDir, { recursive: true });
        for (const item of prompts) {
            const template = readFileSync(join(__dirname, "templates", item.templateFile), "utf8");
            const { raw } = parseFrontmatter(template);
            const content = tool === TOOL.all
                ? buildClaudeCommandWrapper(item, raw)
                : buildClaudeCommandFull(template);
            const version = tool === TOOL.all ? null : item.version;
            await writeWithConflict(join(commandsDir, item.commandFilename), content, item.commandFilename, version);
        }
    }
};

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Prompt the user to select instruction and prompt templates, then install them.
 * 
 * @async
 */
const askUser = async () => {
    try {
        const instructions = loadCatalog(INSTRUCTIONS_FILE_URL, [], "instructions");
        const prompts = loadCatalog(PROMPTS_FILE_URL, ["commandFilename"], "prompts");
        const destRoot = process.cwd();

        const instructionChoices = instructions.map(({ filename, version, name, tags, templateFile }) => {
            const claudePath = join(destRoot, ".claude", "rules", toClaudeRuleFilename(filename));
            const copilotPath = join(destRoot, ".github", "instructions", filename);
            const installedVersion = readInstalledVersion(claudePath) ?? readInstalledVersion(copilotPath);
            const versionStr = installedVersion
                ? chalk.gray(`(installed: v${installedVersion} → v${version})`)
                : chalk.gray(`(v${version})`);
            return { name: `${name} ${versionStr} ${buildTagsStr(tags)}`, value: { filename, version, name, tags, templateFile } };
        });

        const promptChoices = prompts.map(({ filename, commandFilename, version, name, tags, templateFile }) => {
            const copilotPath = join(destRoot, ".github", "prompts", filename);
            const claudePath = join(destRoot, ".claude", "commands", commandFilename);
            const installedVersion = readInstalledVersion(copilotPath) ?? readInstalledVersion(claudePath);
            const versionStr = installedVersion
                ? chalk.gray(`(installed: v${installedVersion} → v${version})`)
                : chalk.gray(`(v${version})`);
            return { name: `${name} ${versionStr} ${buildTagsStr(tags)}`, value: { filename, commandFilename, version, name, tags, templateFile } };
        });

        const { selectedInstructions } = await inquirer.prompt([{
            type: "checkbox",
            name: "selectedInstructions",
            message: "Select instruction files to install:",
            choices: instructionChoices,
        }]);

        const { selectedPrompts } = await inquirer.prompt([{
            type: "checkbox",
            name: "selectedPrompts",
            message: "Select prompt files to install:",
            choices: promptChoices,
        }]);

        if (selectedInstructions.length + selectedPrompts.length === 0) {
            consola.info("No files selected.");
            return;
        }

        const selectedTool = await select({
            message: "Select target tool(s):",
            choices: [
                { name: "All supported tools", value: TOOL.all },
                { name: "GitHub Copilot", value: TOOL.copilot },
                { name: "Claude Code", value: TOOL.claude },
            ],
        });

        if (selectedInstructions.length > 0) await installInstructions(selectedInstructions, destRoot, selectedTool);
        if (selectedPrompts.length > 0) await installPrompts(selectedPrompts, destRoot, selectedTool);
    } catch (e) {
        handleError(e);
    }
};

await askUser();
