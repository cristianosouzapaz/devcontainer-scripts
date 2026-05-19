import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import consola from "consola";
import inquirer from "inquirer";
import { AGENTS, buildTagsStr, handleError, loadJsonCatalog, readInstalledVersion, setupConsola, writeWithConflict } from "../shared/utils.js";

/**
 * @fileoverview Interactive installer for agent instruction and prompt templates.
 *
 * Single source of truth strategy:
 *   Instructions → .github/instructions/  (Copilot reads natively; Claude via CLAUDE.md @import)
 *   Prompts      → .github/prompts/       (Copilot reads natively; Claude via .claude/commands/ wrappers)
 *
 * Installed at /opt/devcontainer/installer/agents/ inside the container.
 */

setupConsola();

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Constants ───────────────────────────────────────────────────────────────

const INSTRUCTIONS_FILE_URL = new URL("./instructions.json", import.meta.url);
const PROMPTS_FILE_URL = new URL("./prompts.json", import.meta.url);

// ─── Functions ───────────────────────────────────────────────────────────────

/**
 * Load and validate the instructions catalog from instructions.json.
 * @returns {object[]} An array of instruction template entries.
 * @throws Will throw an error if the catalog is invalid or cannot be read.
 */
const loadInstructionsCatalog = () => {
    const entries = loadJsonCatalog(INSTRUCTIONS_FILE_URL);

    for (const [index, entry] of entries.entries()) {
        const isValidEntry =
            typeof entry?.name === "string"
            && typeof entry?.filename === "string"
            && typeof entry?.version === "string"
            && typeof entry?.templateFile === "string"
            && Array.isArray(entry?.tags)
            && entry.tags.every((tag) => typeof tag === "string");

        if (!isValidEntry) throw new Error(`Invalid instructions catalog entry at index ${index}.`);
    }

    return entries;
};

/**
 * Load and validate the prompts catalog from prompts.json.
 * @returns {object[]} An array of prompt template entries.
 * @throws Will throw an error if the catalog is invalid or cannot be read.
 */
const loadPromptsCatalog = () => {
    const entries = loadJsonCatalog(PROMPTS_FILE_URL);

    for (const [index, entry] of entries.entries()) {
        const isValidEntry =
            typeof entry?.name === "string"
            && typeof entry?.filename === "string"
            && typeof entry?.commandFilename === "string"
            && typeof entry?.version === "string"
            && typeof entry?.templateFile === "string"
            && typeof entry?.commandTemplateFile === "string"
            && Array.isArray(entry?.tags)
            && entry.tags.every((tag) => typeof tag === "string");

        if (!isValidEntry) throw new Error(`Invalid prompts catalog entry at index ${index}.`);
    }

    return entries;
};

/**
 * Write instruction files to .github/instructions/.
 * @param {object[]} instructions - Selected instruction entries.
 * @param {string} destRoot - Project root directory.
 */
const installInstructions = async (instructions, destRoot) => {
    const instructionsDir = join(destRoot, ".github", "instructions");
    mkdirSync(instructionsDir, { recursive: true });

    for (const item of instructions) {
        const content = readFileSync(join(__dirname, "templates", item.templateFile), "utf8");
        await writeWithConflict(join(instructionsDir, item.filename), content, item.filename, item.version);
    }
};

/**
 * Write prompt files to .github/prompts/ and optionally copy the static command
 * wrapper to .claude/commands/ when Claude Code is a selected target.
 * @param {object[]} prompts - Selected prompt entries.
 * @param {string} destRoot - Project root directory.
 * @param {boolean} installClaude - Whether to install .claude/commands/ wrappers.
 */
const installPrompts = async (prompts, destRoot, installClaude) => {
    const promptsDir = join(destRoot, ".github", "prompts");
    mkdirSync(promptsDir, { recursive: true });

    if (installClaude) mkdirSync(join(destRoot, ".claude", "commands"), { recursive: true });

    for (const item of prompts) {
        const promptContent = readFileSync(join(__dirname, "templates", item.templateFile), "utf8");
        await writeWithConflict(join(promptsDir, item.filename), promptContent, item.filename, item.version);

        if (installClaude) {
            const commandContent = readFileSync(join(__dirname, "templates", item.commandTemplateFile), "utf8");
            await writeWithConflict(join(destRoot, ".claude", "commands", item.commandFilename), commandContent, item.commandFilename, null);
        }
    }
};

/**
 * Prepend missing @import lines to CLAUDE.md for each installed instruction.
 * Creates CLAUDE.md if it does not exist. Inserts at the top, separated from
 * any existing content by a blank line.
 * @param {object[]} instructions - Selected instruction entries.
 * @param {string} destRoot - Project root directory.
 */
const updateClaudeMd = (instructions, destRoot) => {
    const claudeMdPath = join(destRoot, "CLAUDE.md");
    const existing = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf8") : "";

    const toAdd = instructions
        .map((i) => `@.github/instructions/${i.filename}`)
        .filter((line) => !existing.includes(line));

    if (toAdd.length === 0) {
        consola.info("CLAUDE.md already contains all selected @import lines");
        return;
    }

    const newBlock = toAdd.join("\n") + "\n";
    const content = existing.length === 0
        ? newBlock
        : existing.startsWith("@")
            ? newBlock + existing
            : newBlock + "\n" + existing;
    writeFileSync(claudeMdPath, content, "utf8");
    consola.success(`CLAUDE.md updated (+${toAdd.length} @import line${toAdd.length > 1 ? "s" : ""})`);
};

/**
 * Prompt the user to select instruction and prompt templates, then install them.
 * Log order: instruction files → prompt files → CLAUDE.md.
 * @async
 */
const askUser = async () => {
    try {
        const instructions = loadInstructionsCatalog();
        const prompts = loadPromptsCatalog();
        const destRoot = process.cwd();

        const instructionChoices = instructions.map((i) => {
            const installedPath = join(destRoot, ".github", "instructions", i.filename);
            const installedVersion = readInstalledVersion(installedPath);
            const versionStr = installedVersion
                ? chalk.gray(`(installed: v${installedVersion} → v${i.version})`)
                : chalk.gray(`(v${i.version})`);
            return { name: `${i.name} ${versionStr} ${buildTagsStr(i.tags)}`, value: i };
        });

        const promptChoices = prompts.map((p) => {
            const installedPath = join(destRoot, ".github", "prompts", p.filename);
            const installedVersion = readInstalledVersion(installedPath);
            const versionStr = installedVersion
                ? chalk.gray(`(installed: v${installedVersion} → v${p.version})`)
                : chalk.gray(`(v${p.version})`);
            return { name: `${p.name} ${versionStr} ${buildTagsStr(p.tags)}`, value: p };
        });

        const { selectedInstructions } = await inquirer.prompt([{
            choices: instructionChoices,
            message: "Select instruction files to install:",
            name: "selectedInstructions",
            type: "checkbox",
        }]);

        const { selectedPrompts } = await inquirer.prompt([{
            choices: promptChoices,
            message: "Select prompt files to install:",
            name: "selectedPrompts",
            type: "checkbox",
        }]);

        const totalSelected = selectedInstructions.length + selectedPrompts.length;
        if (totalSelected === 0) {
            consola.info("No files selected.");
            return;
        }

        const { selectedAgents } = await inquirer.prompt([{
            type: "checkbox",
            name: "selectedAgents",
            message: "Install for which tool(s)?",
            choices: [
                { name: "GitHub Copilot", value: AGENTS.copilot, checked: true },
                { name: "Claude Code", value: AGENTS.claude, checked: true },
            ],
        }]);

        if (selectedAgents.length === 0) {
            consola.info("No target selected.");
            return;
        }

        const installClaude = selectedAgents.includes(AGENTS.claude);

        if (selectedInstructions.length > 0) await installInstructions(selectedInstructions, destRoot);
        if (selectedPrompts.length > 0) await installPrompts(selectedPrompts, destRoot, installClaude);
        if (selectedInstructions.length > 0 && installClaude) updateClaudeMd(selectedInstructions, destRoot);
    } catch (e) {
        handleError(e);
    }
};

await askUser();
