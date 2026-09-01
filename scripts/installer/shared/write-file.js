import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import consolaBase from "consola";
import { select } from "@inquirer/prompts";
import { PROMPT_THEME } from "./theme.js";

/**
 * @fileoverview The two ways an installer writes a file: `writeWithConflict` for the
 * interactive per-project path (asks before touching an existing file) and `writeOverwrite`
 * for the non-interactive `--global` sync (template wins, but skips an identical file so the
 * lock's `updatedAt` only moves on a real change).
 */

const CLEAR_ON_DONE = { clearPromptOnDone: true };
const consola = consolaBase.withDefaults({ formatOptions: { date: false } });

/**
 * Write content to destPath, prompting the user to resolve a conflict with an existing file.
 * When both files carry a version, the prompt shows the version transition.
 * @param {string} destPath - Absolute destination path.
 * @param {string} content - File content to write.
 * @param {string} filename - Display name used in conflict prompts.
 * @param {string|null} templateVersion - Version string from the catalog entry.
 * @param {string|null} knownInstalledVersion - Installed version read from template-lock.json.
 * @returns {Promise<boolean>} True when written, false when the user skipped.
 * @throws {Error} If the prompt, backup rename, or destination write fails.
 * @effects Reads and, when selected, writes or renames `destPath`; the supplied destination is the only filesystem target.
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
            theme: PROMPT_THEME,
        }, CLEAR_ON_DONE);

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

/**
 * Non-interactive writer for the `--global` sync. Overwrites unconditionally, but reports
 * "not written" when the on-disk content already matches. Same signature as `writeWithConflict`.
 * @param {string} destPath - Absolute destination path.
 * @param {string} content - File content to write.
 * @param {string} filename - Display name for the log line.
 * @returns {Promise<boolean>} Whether the file was (re)written.
 * @throws {Error} If the destination cannot be read, created, or written.
 * @effects Reads `destPath`; creates its parent directory and overwrites `destPath` only when the content differs.
 */
export const writeOverwrite = async (destPath, content, filename) => {
    if (existsSync(destPath) && readFileSync(destPath, "utf8") === content) return false;
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, content, "utf8");
    consola.success(`${filename} written`);
    return true;
};
