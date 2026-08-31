import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import consola from "consola";
import { checkbox } from "@inquirer/prompts";
import { buildInstallCommand, buildTagsStr, CLEAR_ON_DONE, copyToClipboard, formatVersionHint, handleError, loadValidatedCatalog, readConfigInstalledVersion, readLockFile, resolvePageSize, selectUntilConfirmed, setupConsola, writeLockFile, writeWithConflict } from "../shared/utils.js";

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
 * @returns {object[]} Validated config template entries.
 * @throws If the catalog file or any entry is invalid.
 */
const loadConfigsCatalog = () => loadValidatedCatalog(CONFIGS_FILE_URL, "configs", {
    strings: ["name", "filename", "version", "templateFile"],
    nonEmptyStrings: ["description"],
    stringArrays: ["tags"],
    optionalStringArrays: ["packages"],
});

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

        const selectedConfigs = await selectUntilConfirmed(
            () => checkbox({
                choices,
                message: "Select config files to copy:",
                pageSize: resolvePageSize(choices.length),
            }, CLEAR_ON_DONE),
            (selected) => {
                const packages = [...new Set(selected.flatMap((config) => config.packages ?? []))];
                return [
                    { title: "Config files", items: selected.map(({ name }) => name) },
                    { title: "Required packages (run separately)", items: packages },
                ];
            },
            "Install selected files",
        );
        if (selectedConfigs === undefined) {
            consola.info("No files selected.");
            return;
        }
        if (selectedConfigs === null) return;

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
