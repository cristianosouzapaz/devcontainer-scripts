import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import chalk from "chalk";
import consola from "consola";
import inquirer from "inquirer";
import { select } from "@inquirer/prompts";

/**
 * @fileoverview Shared utilities for all framework installer scripts.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Supported agent identifiers for GitHub Copilot and Claude Code.
 */
export const AGENTS = {
    copilot: "github-copilot",
    claude: "claude-code",
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
 * Extract the version string from the YAML frontmatter of a markdown file.
 * Returns null if the file has no frontmatter or no version field.
 * @param {string} filePath - Absolute path to the file.
 * @returns {string|null} Semver string or null.
 */
export const readInstalledVersion = (filePath) => {
    try {
        const content = readFileSync(filePath, "utf8");
        const match = content.match(/^---\n[\s\S]*?^version:\s*["']?([^"'\n]+)["']?\s*\n[\s\S]*?^---/m);
        return match ? match[1].trim() : null;
    } catch {
        return null;
    }
};

/**
 * Write content to destPath, prompting the user to resolve conflicts.
 * When both files carry a version, the conflict message shows the version transition.
 * @param {string} destPath - Absolute destination path.
 * @param {string} content - File content to write.
 * @param {string} filename - Display name used in conflict prompts.
 * @param {string|null} templateVersion - Version string from the registry entry.
 */
export const writeWithConflict = async (destPath, content, filename, templateVersion = null) => {
    if (existsSync(destPath)) {
        const installedVersion = readInstalledVersion(destPath);
        const versionHint = installedVersion && templateVersion
            ? ` (v${installedVersion} → v${templateVersion})`
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
            return;
        }

        if (action === "backup and replace") {
            renameSync(destPath, `${destPath}.bak`);
            consola.info(`Backed up existing ${filename} → ${filename}.bak`);
        }
    }

    writeFileSync(destPath, content, "utf8");
    consola.success(`${filename} written`);
};

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
