import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import consola from "consola";
import inquirer from "inquirer";

/**
 * @fileoverview Interactive installer for agent instruction and prompt templates.
 *
 * Single source of truth strategy:
 *   Instructions → .github/instructions/  (Copilot reads natively; Claude via CLAUDE.md @import)
 *   Prompts      → .github/prompts/       (Copilot reads natively; Claude via .claude/commands/ wrappers)
 */

consola.options = { ...consola.options, formatOptions: { ...consola.options.formatOptions, date: false } };

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Constants ───────────────────────────────────────────────────────────────

const AGENTS = {
    copilot: "github-copilot",
    claude: "claude-code",
};

/**
 * Predefined list of available instruction templates.
 * - filename:    output filename in .github/instructions/ (.instructions.md required by Copilot)
 * - version:     semver string matching the version field in the template frontmatter
 */
const INSTRUCTIONS = [
    {
        name: "Agent Orchestration",
        filename: "agent-orchestration.instructions.md",
        version: "1.0.0",
        tags: ["agents", "multi-agent"],
        templateFile: "instructions/agent-orchestration.instructions.md",
    },
    {
        name: "Documentation Rules",
        filename: "documentation.instructions.md",
        version: "1.0.0",
        tags: ["docs", "jsdoc", "typescript"],
        templateFile: "instructions/documentation.instructions.md",
    },
    {
        name: "Next.js Rules",
        filename: "nextjs.instructions.md",
        version: "1.0.0",
        tags: ["nextjs", "react"],
        templateFile: "instructions/nextjs.instructions.md",
    },
    {
        name: "TypeScript Rules",
        filename: "typescript.instructions.md",
        version: "1.0.0",
        tags: ["typescript"],
        templateFile: "instructions/typescript.instructions.md",
    },
];

/**
 * Predefined list of available prompt templates.
 * - filename:              output filename in .github/prompts/ (.prompt.md required by Copilot)
 * - commandFilename:       output filename for the .claude/commands/ wrapper (plain .md)
 * - commandTemplateFile:   static wrapper template to copy into .claude/commands/
 * - version:               semver string matching the version field in the template frontmatter
 */
const PROMPTS = [
    {
        name: "Index Components",
        filename: "index-components.prompt.md",
        commandFilename: "index-components.md",
        version: "1.0.0",
        tags: ["react", "docs"],
        templateFile: "prompts/index-components.prompt.md",
        commandTemplateFile: "prompts/index-components.md",
    },
];

// ─── Functions ───────────────────────────────────────────────────────────────

/**
 * Extract the version string from the YAML frontmatter of a markdown file.
 * Returns null if the file has no frontmatter or no version field.
 * @param {string} filePath - Absolute path to the installed file.
 * @returns {string|null} Semver string or null.
 */
const readInstalledVersion = (filePath) => {
    try {
        const content = readFileSync(filePath, "utf8");
        const match = content.match(/^---\n[\s\S]*?^version:\s*["']?([^"'\n]+)["']?\s*\n[\s\S]*?^---/m);
        return match ? match[1].trim() : null;
    } catch {
        return null;
    }
};

/**
 * Compare two semver strings numerically (major.minor.patch).
 * @param {string} a - First version string.
 * @param {string} b - Second version string.
 * @returns {number} Positive if a > b, negative if a < b, 0 if equal.
 */
const compareSemver = (a, b) => {
    const parts = (v) => v.split(".").map(Number).concat([0, 0, 0]).slice(0, 3);
    const [aMaj, aMin, aPatch] = parts(a);
    const [bMaj, bMin, bPatch] = parts(b);
    return aMaj - bMaj || aMin - bMin || aPatch - bPatch;
};

/**
 * Write content to destPath, prompting the user to resolve conflicts.
 * When both files carry a version, shows a version-aware message and auto-skips
 * when the installed file is already up to date.
 * @param {string} destPath - Absolute destination path.
 * @param {string} content - File content to write.
 * @param {string} filename - Display name used in conflict prompts.
 * @param {string|null} templateVersion - Version string from the registry entry.
 */
const writeWithConflict = async (destPath, content, filename, templateVersion) => {
    if (existsSync(destPath)) {
        const installedVersion = readInstalledVersion(destPath);

        if (installedVersion && templateVersion) {
            const diff = compareSemver(templateVersion, installedVersion);

            if (diff === 0) {
                consola.info(`${filename} is already up to date (v${installedVersion})`);
                return;
            }

            const label = diff > 0
                ? `${filename} can be updated (v${installedVersion} → v${templateVersion})`
                : `${filename} installed version (v${installedVersion}) is newer than template (v${templateVersion})`;

            const { action } = await inquirer.prompt([{
                type: "list",
                name: "action",
                message: `${label}. What do you want to do?`,
                choices: ["overwrite", "skip", "backup and replace"],
            }]);

            if (action === "skip") { consola.info(`Skipped ${filename}`); return; }
            if (action === "backup and replace") {
                renameSync(destPath, `${destPath}.bak`);
                consola.info(`Backed up existing ${filename} → ${filename}.bak`);
            }
        } else {
            const { action } = await inquirer.prompt([{
                type: "list",
                name: "action",
                message: `${filename} already exists. What do you want to do?`,
                choices: ["overwrite", "skip", "backup and replace"],
            }]);

            if (action === "skip") { consola.info(`Skipped ${filename}`); return; }
            if (action === "backup and replace") {
                renameSync(destPath, `${destPath}.bak`);
                consola.info(`Backed up existing ${filename} → ${filename}.bak`);
            }
        }
    }

    writeFileSync(destPath, content, "utf8");
    consola.success(`${filename} written`);
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

    if (installClaude) {
        mkdirSync(join(destRoot, ".claude", "commands"), { recursive: true });
    }

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
        const instructionChoices = INSTRUCTIONS.map((i) => {
            const tagsStr = i.tags.map((tag) => chalk.bgWhite.black(` ${tag} `)).join(" ");
            return { name: `${i.name} ${chalk.gray(`(v${i.version})`)} ${tagsStr}`, value: i };
        });

        const promptChoices = PROMPTS.map((p) => {
            const tagsStr = p.tags.map((tag) => chalk.bgWhite.black(` ${tag} `)).join(" ");
            return { name: `${p.name} ${chalk.gray(`(v${p.version})`)} ${tagsStr}`, value: p };
        });

        const answers = await inquirer.prompt([
            {
                choices: instructionChoices,
                message: "Select instruction files to install:",
                name: "selectedInstructions",
                type: "checkbox",
            },
            {
                choices: promptChoices,
                message: "Select prompt files to install:",
                name: "selectedPrompts",
                type: "checkbox",
            },
            {
                type: "checkbox",
                name: "selectedAgents",
                message: "Install for which tool(s)?",
                choices: [
                    { name: "GitHub Copilot", value: AGENTS.copilot, checked: true },
                    { name: "Claude Code", value: AGENTS.claude, checked: true },
                ],
            },
        ]);

        const totalSelected = answers.selectedInstructions.length + answers.selectedPrompts.length;
        if (totalSelected === 0) {
            consola.info("No files selected.");
            return;
        }

        if (answers.selectedAgents.length === 0) {
            consola.info("No target selected.");
            return;
        }

        const destRoot = process.cwd();
        const installClaude = answers.selectedAgents.includes(AGENTS.claude);

        if (answers.selectedInstructions.length > 0) await installInstructions(answers.selectedInstructions, destRoot);
        if (answers.selectedPrompts.length > 0) await installPrompts(answers.selectedPrompts, destRoot, installClaude);
        if (answers.selectedInstructions.length > 0 && installClaude) updateClaudeMd(answers.selectedInstructions, destRoot);
    } catch (e) {
        if (e.message?.includes("User force closed the prompt with SIGINT")) process.exit(0);
        else {
            consola.error(`An error occurred: ${e.message}`);
            process.exit(1);
        }
    }
};

await askUser();
