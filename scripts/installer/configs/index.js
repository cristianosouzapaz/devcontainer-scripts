import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import consola from "consola";
import inquirer from "inquirer";
import { buildTagsStr, handleError, loadJsonCatalog, setupConsola, writeWithConflict } from "../shared/utils.js";

/**
 * @fileoverview Interactive installer for project config file templates.
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
 * @returns {object[]} An array of config template entries.
 * @throws Will throw an error if the catalog is invalid or cannot be read.
 */
const loadConfigsCatalog = () => {
    const entries = loadJsonCatalog(CONFIGS_FILE_URL);

    for (const [index, entry] of entries.entries()) {
        const isValidEntry =
            typeof entry?.name === "string"
            && typeof entry?.filename === "string"
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
 * @async
 */
const askUser = async () => {
    try {
        const configs = loadConfigsCatalog();

        const choices = configs.map((c) => ({
            name: `${c.name} ${buildTagsStr(c.tags)}`,
            value: c,
        }));

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

        const destDir = process.cwd();

        for (const config of selectedConfigs) {
            const content = readFileSync(join(__dirname, "templates", config.templateFile), "utf8");
            await writeWithConflict(join(destDir, config.filename), content, config.filename);
        }
    } catch (e) {
        handleError(e);
    }
};

await askUser();
