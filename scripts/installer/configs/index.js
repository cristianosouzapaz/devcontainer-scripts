import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import consola from "consola";
import inquirer from "inquirer";
import { buildInstallCommand, buildTagsStr, copyToClipboard, formatVersionHint, handleError, loadJsonCatalog, readConfigInstalledVersion, readLockFile, resolvePageSize, setupConsola, writeLockFile, writeWithConflict } from "../shared/utils.js";

/**
 * @fileoverview Interactive installer for project config file templates.
 *
 * Reads available templates from configs.json (each entry carries a version field and,
 * where applicable, a list of npm packages required for the config to function).
 * On install, writes files to the user's project root, records installed versions
 * in template-lock.json so subsequent runs can show version hints in the UI, and
 * prints a consolidated dependency installation command for the written configs.
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
 * Each entry must have: name, filename, version (semver), description, templateFile, tags.
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
            && typeof entry?.description === "string"
            && entry.description.length > 0
            && typeof entry?.templateFile === "string"
            && Array.isArray(entry?.tags)
            && entry.tags.every((tag) => typeof tag === "string")
            && (entry.packages === undefined || (Array.isArray(entry.packages) && entry.packages.every((pkg) => typeof pkg === "string")));

        if (!isValidEntry) throw new Error(`Invalid configs catalog entry at index ${index}.`);
    }

    return entries;
};

/**
 * Print a consolidated installation command for the npm packages required by the
 * given set of written configs, and attempt to copy it to the clipboard.
 * Configs without a "packages" entry are silently excluded. No-op if none require packages.
 * @param {object[]} writtenConfigs - Catalog entries that were actually written to disk.
 */
const announceRequiredPackages = (writtenConfigs) => {
    const packages = [...new Set(writtenConfigs.flatMap((c) => c.packages ?? []))];
    if (packages.length === 0) return;

    const installCommand = buildInstallCommand(packages);
    const copied = copyToClipboard(installCommand);

    consola.box({
        title: "Next Steps",
        message: `The following packages are required for the installed configuration files to take effect:\n\n  ${installCommand}\n\n${copied ? "This command has been copied to your clipboard, provided your terminal supports it." : "Please run this command to complete the setup."}`,
        style: { borderColor: "cyan" },
    });
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
            const versionStr = formatVersionHint(installedVersion, c.version);
            return { name: `${c.name} ${versionStr} ${buildTagsStr(c.tags)}`, value: c, description: c.description };
        });

        const { selectedConfigs } = await inquirer.prompt([{
            choices,
            message: "Select config files to copy:",
            name: "selectedConfigs",
            pageSize: resolvePageSize(choices.length),
            type: "checkbox",
        }]);

        if (selectedConfigs.length === 0) {
            consola.info("No files selected.");
            return;
        }

        const lock = readLockFile(destDir);
        const writtenConfigs = [];

        for (const config of selectedConfigs) {
            const destPath = join(destDir, config.filename);
            mkdirSync(dirname(destPath), { recursive: true });
            const content = readFileSync(join(__dirname, "templates", config.templateFile), "utf8");
            const written = await writeWithConflict(destPath, content, config.filename, config.version, lock.configs[config.filename] ?? null);
            if (written) {
                lock.configs[config.filename] = config.version;
                writtenConfigs.push(config);
            }
        }

        if (writtenConfigs.length > 0) writeLockFile(destDir, lock);

        announceRequiredPackages(writtenConfigs);
    } catch (e) {
        handleError(e);
    }
};

await askUser();
