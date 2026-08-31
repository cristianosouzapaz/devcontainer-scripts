import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import consola from "consola";
import { loadValidatedCatalog } from "../shared/catalog.js";
import { readLockFile, writeLockFile } from "../shared/lock-file.js";
import { pickAssets } from "../shared/pick-assets.js";
import { formatVersionHint, restoreChecked, selectUntilConfirmed } from "../shared/prompts.js";
import { copyToClipboard, handleError, setupConsola } from "../shared/utils.js";
import { writeWithConflict } from "../shared/write-file.js";

/**
 * @fileoverview Interactive installer for project config templates. See
 * `docs/wiki/installer/configs.md`.
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

    const installCommand = `pnpm add -D ${packages.join(" ")}`;
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
        const lock = readLockFile(destDir);

        const choices = configs.map((c) => ({
            name: c.name,
            value: c,
            description: c.description,
            annotation: formatVersionHint(lock.configs[c.filename] ?? null, c.version),
        }));

        const selectedConfigs = await selectUntilConfirmed(
            (previous) => pickAssets({ message: "Select config files", choices: restoreChecked(choices, previous) }),
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
