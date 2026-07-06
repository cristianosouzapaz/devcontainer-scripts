import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import consola from "consola";
import inquirer from "inquirer";
import { buildTagsStr, handleError, loadJsonCatalog, readConfigInstalledVersion, readLockFile, setupConsola, writeLockFile, writeWithConflict } from "../shared/utils.js";

/**
 * @fileoverview Interactive installer for project config file templates.
 *
 * Reads available templates from configs.json (each entry carries a version field).
 * On install, writes files to the user's project root and records installed versions
 * in template-lock.json so subsequent runs can show version hints in the UI.
 *
 * Installed at /opt/devcontainer/installer/configs/ inside the container.
 */

setupConsola();

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Constants ───────────────────────────────────────────────────────────────

const CONFIGS_FILE_URL = new URL("./configs.json", import.meta.url);

// ─── Functions ───────────────────────────────────────────────────────────────

/**
 * Load and validate the config templates catalog from configs.json.
 * Each entry must have: name, filename, version (semver), templateFile, tags.
 * @returns {object[]} An array of validated config template entries.
 * @throws Will throw an error if the catalog is invalid or cannot be read.
 */
const loadConfigsCatalog = () => {
    const entries = loadJsonCatalog(CONFIGS_FILE_URL);

    for (const [index, entry] of entries.entries()) {
        const isValidEntry =
            typeof entry?.name === "string"
            && typeof entry?.filename === "string"
            && typeof entry?.version === "string"
            && typeof entry?.templateFile === "string"
            && Array.isArray(entry?.tags)
            && entry.tags.every((tag) => typeof tag === "string");

        if (!isValidEntry) throw new Error(`Invalid configs catalog entry at index ${index}.`);
    }

    return entries;
};

/**
 * Prompt the user to select config files to copy into the current directory.
 * Handles conflicts (overwrite / skip / backup and replace) per file.
 * On completion, updates template-lock.json in the project root with the installed versions.
 */
const askUser = async () => {
    try {
        const configs = loadConfigsCatalog();
        const destDir = process.cwd();

        const choices = configs.map((c) => {
            const installedVersion = readConfigInstalledVersion(destDir, c.filename);
            const versionStr = installedVersion
                ? installedVersion === c.version
                    ? chalk.gray(`(installed: v${installedVersion})`)
                    : chalk.gray(`(installed: v${installedVersion} → v${c.version})`)
                : chalk.gray(`(v${c.version})`);
            return { name: `${c.name} ${versionStr} ${buildTagsStr(c.tags)}`, value: c };
        });

        const { selectedConfigs } = await inquirer.prompt([{
            choices,
            message: "Select config files to copy:",
            name: "selectedConfigs",
            type: "checkbox",
        }]);

        if (selectedConfigs.length === 0) {
            consola.info("No files selected.");
            return;
        }

        const lock = readLockFile(destDir);

        for (const config of selectedConfigs) {
            const destPath = join(destDir, config.filename);
            mkdirSync(dirname(destPath), { recursive: true });
            const content = readFileSync(join(__dirname, "templates", config.templateFile), "utf8");
            const written = await writeWithConflict(destPath, content, config.filename, config.version, lock.configs[config.filename] ?? null);
            if (written) lock.configs[config.filename] = config.version;
        }

        writeLockFile(destDir, lock);
    } catch (e) {
        handleError(e);
    }
};

await askUser();
