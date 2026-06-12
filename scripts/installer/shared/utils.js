import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import consola from "consola";
import { select } from "@inquirer/prompts";

/**
 * @fileoverview Shared utilities for all framework installer scripts.
 *
 * Exports:
 *   - File writing:  writeWithConflict
 *   - Version read:  readConfigInstalledVersion (lock file)
 *   - Lock file:     readLockFile, writeLockFile  →  template-lock.json in the user's project root
 *   - UI helpers:    buildTagsStr, setupConsola, selectTargetTool
 *   - Catalog:       loadJsonCatalog
 *   - Error:         handleError
 *   - Constants:     AGENTS, TOOLS
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Supported agent identifiers for GitHub Copilot and Claude Code.
 */
export const AGENTS = {
    copilot: "github-copilot",
    claude: "claude-code",
};

/**
 * Logical tool targets used across installers for routing installation output.
 */
export const TOOLS = {
    all: "all",
    copilot: "copilot",
    claude: "claude",
};

// ─── Functions ───────────────────────────────────────────────────────────────

/**
 * Read and parse a JSON catalog file, validating that it is an array.
 * @param {URL|string} fileUrl - URL or path of the JSON file to load.
 * @returns {object[]} Parsed array of catalog entries.
 * @throws If the file cannot be read or the root value is not an array.
 */
export const loadJsonCatalog = (fileUrl) => {
    const raw = readFileSync(fileUrl, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`Invalid catalog: expected an array in ${fileUrl}.`);
    return parsed;
};

/**
 * Configure consola to suppress timestamps in output.
 */
export const setupConsola = () => {
    consola.options = { ...consola.options, formatOptions: { ...consola.options.formatOptions, date: false } };
};

/**
 * Render an array of tag strings as chalk-styled inline badges.
 * @param {string[]} tags - Tag labels to render.
 * @returns {string} Space-separated styled badge string.
 */
export const buildTagsStr = (tags) =>
    tags.map((tag) => chalk.bgWhite.black(` ${tag} `)).join(" ");

/**
 * Prompt the user to select a target tool via a single-choice radio.
 * @returns {Promise<"all"|"copilot"|"claude">}
 */
export const selectTargetTool = () => select({
    message: "Select target tool(s):",
    choices: [
        { name: "All supported tools", value: TOOLS.all },
        { name: "GitHub Copilot",      value: TOOLS.copilot },
        { name: "Claude Code",         value: TOOLS.claude },
    ],
});

/**
 * Write content to destPath, prompting the user to resolve conflicts.
 * When both files carry a version, the conflict message shows the version transition.
 * Returns true if the file was written, false if skipped.
 * @param {string} destPath - Absolute destination path.
 * @param {string} content - File content to write.
 * @param {string} filename - Display name used in conflict prompts.
 * @param {string|null} templateVersion - Version string from the registry entry.
 * @param {string|null} knownInstalledVersion - Installed version read from template-lock.json.
 * @returns {Promise<boolean>}
 */
export const writeWithConflict = async (destPath, content, filename, templateVersion = null, knownInstalledVersion = null) => {
    if (existsSync(destPath)) {
        const versionHint = knownInstalledVersion && templateVersion
            ? ` (v${knownInstalledVersion} → v${templateVersion})`
            : "";

        const action = await select({
            message: `${filename} already exists${versionHint}. What do you want to do?`,
            choices: [
                { name: "Overwrite", value: "overwrite" },
                { name: "Skip", value: "skip" },
                { name: "Backup and replace", value: "backup and replace" },
            ],
            default: "skip",
        });

        if (action === "skip") {
            consola.info(`Skipped ${filename}`);
            return false;
        }

        if (action === "backup and replace") {
            renameSync(destPath, `${destPath}.bak`);
            consola.info(`Backed up existing ${filename} → ${filename}.bak`);
        }
    }

    writeFileSync(destPath, content, "utf8");
    consola.success(`${filename} written`);
    return true;
};

// ─── Lock file ───────────────────────────────────────────────────────────────

/**
 * Read and parse template-lock.json from the user's project root.
 * Returns a default empty structure if the file does not exist or cannot be parsed.
 * @param {string} projectRoot - Absolute path to the user's project root.
 * @returns {{ version: string, updatedAt: string, configs: object, instructions: object, prompts: object }}
 */
export const readLockFile = (projectRoot) => {
    const empty = { version: "1", updatedAt: "", configs: {}, instructions: {}, prompts: {} };
    try {
        return { ...empty, ...JSON.parse(readFileSync(join(projectRoot, "template-lock.json"), "utf8")) };
    } catch {
        return empty;
    }
};

/**
 * Write lock data to template-lock.json in the user's project root.
 * Always sets updatedAt to the current UTC timestamp.
 * @param {string} projectRoot - Absolute path to the user's project root.
 * @param {{ version: string, configs: object, instructions: object, prompts: object }} lockData
 */
export const writeLockFile = (projectRoot, lockData) => {
    const data = { ...lockData, updatedAt: new Date().toISOString() };
    writeFileSync(join(projectRoot, "template-lock.json"), JSON.stringify(data, null, 4) + "\n", "utf8");
};

/**
 * Read the installed version of a config from template-lock.json.
 * Returns null if the config is not recorded or the lock file does not exist.
 * @param {string} projectRoot - Absolute path to the user's project root.
 * @param {string} filename - The config filename key (e.g. "biome.json", ".claude/settings.local.json").
 * @returns {string|null}
 */
export const readConfigInstalledVersion = (projectRoot, filename) => readLockFile(projectRoot).configs[filename] ?? null;

/**
 * Handle a top-level installer error.
 * Exits cleanly on SIGINT, logs and exits with code 1 for all other errors.
 * @param {unknown} e - The caught error.
 */
export const handleError = (e) => {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("User force closed the prompt with SIGINT")) process.exit(0);
    consola.error(`An error occurred: ${message}`);
    process.exit(1);
};
