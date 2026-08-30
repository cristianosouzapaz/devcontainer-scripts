import { existsSync, lstatSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import chalk from "chalk";
import consola from "consola";
import { checkbox, select } from "@inquirer/prompts";

/**
 * @fileoverview Shared utilities for all framework installer scripts.
 *
 * Exports:
 *   - File writing:  writeWithConflict
 *   - Version read:  readConfigInstalledVersion (lock file)
 *   - Lock file:     readLockFile, writeLockFile, getArtifactVersion, recordArtifact,
 *                    reconcileArtifactAdapters
 *                    → template-lock.json in the user's project root
 *   - UI helpers:    buildTagsStr, setupConsola, selectTargetTools, resolvePageSize, formatVersionHint
 *   - Clipboard:     copyToClipboard, buildInstallCommand
 *   - Catalog:       loadJsonCatalog
 *   - Error:         handleError
 *   - Constants:     AGENTS, TOOLS
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Supported agent identifiers for external skill installers.
 */
export const AGENTS = {
    copilot: "github-copilot",
    claude: "claude-code",
    codex: "codex",
};

/**
 * Logical coding-agent targets used across installers for routing installation output.
 */
export const TOOLS = {
    copilot: "copilot",
    claude: "claude",
    codex: "codex",
};

const LOCK_VERSION = "2";

const emptyLock = () => ({ version: LOCK_VERSION, updatedAt: "", configs: {}, artifacts: {}, mdBlocks: {} });

const addAdapter = (adapters, agent, adapter) => {
    if (!agent || !adapter) return;
    const entries = adapters[agent] ?? [];
    const existing = entries.find((entry) => entry.path === adapter.path && entry.type === adapter.type);
    if (existing) Object.assign(existing, adapter);
    else entries.push(adapter);
    adapters[agent] = entries;
};

/**
 * Upper bound on checkbox pageSize, so a catalog stays on one screen without
 * an unbounded prompt height if it grows very large.
 */
const MAX_CATALOG_PAGE_SIZE = 30;

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
 * Format the "(installed: vX)" / "(installed: vX → vY)" / "(vY)" hint shown
 * next to a catalog entry's name in a selection prompt.
 * @param {string|null} installedVersion - Currently installed version, or null if not installed.
 * @param {string} version - The catalog entry's current version.
 * @returns {string}
 */
export const formatVersionHint = (installedVersion, version) =>
    installedVersion
        ? installedVersion === version
            ? chalk.gray(`(installed: v${installedVersion})`)
            : chalk.gray(`(installed: v${installedVersion} → v${version})`)
        : chalk.gray(`(v${version})`);

/**
 * Resolve a checkbox prompt's pageSize so the full choice list (including any
 * Separator rows) renders on one screen, capped at MAX_CATALOG_PAGE_SIZE.
 * @param {number} choiceCount - Total number of rendered rows (choices + separators).
 * @returns {number}
 */
export const resolvePageSize = (choiceCount) => Math.min(choiceCount, MAX_CATALOG_PAGE_SIZE);

/**
 * Prompt the user to select one or more coding agents.
 *
 * Callers should route outputs from the returned set instead of branching on every
 * possible combination. This keeps the installer extensible as new agents are added.
 * @returns {Promise<string[]>} Selected values from TOOLS.
 */
export const selectTargetTools = () => checkbox({
    message: "Select target tool(s):",
    choices: [
        { name: "GitHub Copilot", value: TOOLS.copilot },
        { name: "Claude Code", value: TOOLS.claude },
        { name: "Codex", value: TOOLS.codex },
    ],
    validate: (selected) => selected.length > 0 || "Select at least one coding agent.",
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
 * Returns a default empty structure if the file does not exist, is invalid, or uses another schema.
 * @param {string} projectRoot - Absolute path to the user's project root.
 * @returns {{ version: "2", updatedAt: string, configs: object, artifacts: object, mdBlocks: object }}
 */
export const readLockFile = (projectRoot) => {
    try {
        const parsed = JSON.parse(readFileSync(join(projectRoot, "template-lock.json"), "utf8"));
        if (parsed.version !== LOCK_VERSION) return emptyLock();
        return {
            ...emptyLock(),
            ...parsed,
            configs: { ...(parsed.configs ?? {}) },
            artifacts: { ...(parsed.artifacts ?? {}) },
            mdBlocks: { ...(parsed.mdBlocks ?? {}) },
        };
    } catch {
        return emptyLock();
    }
};

/**
 * Write lock data to template-lock.json in the user's project root.
 * Always sets updatedAt to the current UTC timestamp.
 * @param {string} projectRoot - Absolute path to the user's project root.
 * @param {{ version: "2", configs: object, artifacts: object, mdBlocks: object }} lockData
 */
export const writeLockFile = (projectRoot, lockData) => {
    const data = { ...lockData, version: LOCK_VERSION, updatedAt: new Date().toISOString() };
    writeFileSync(join(projectRoot, "template-lock.json"), JSON.stringify(data, null, 4) + "\n", "utf8");
};

/** Return an artifact's installed version, if tracked. */
export const getArtifactVersion = (lock, path) => lock.artifacts?.[path]?.version ?? null;

/** Record a canonical artifact and merge its materialized native adapters. */
export const recordArtifact = (lock, path, { kind, version, adapters = {}, source }) => {
    const existing = lock.artifacts[path] ?? { kind, adapters: {} };
    const mergedAdapters = { ...(existing.adapters ?? {}) };
    for (const [agent, entries] of Object.entries(adapters)) {
        for (const entry of entries) addAdapter(mergedAdapters, agent, entry);
    }
    lock.artifacts[path] = {
        ...existing,
        kind,
        ...(version === undefined ? {} : { version }),
        ...(source === undefined ? {} : { source }),
        adapters: mergedAdapters,
    };
};

/** Remove adapter records that no longer match their materialized filesystem entry. */
export const reconcileArtifactAdapters = (lock, root, path) => {
    const artifact = lock.artifacts?.[path];
    if (!artifact) return false;

    const before = JSON.stringify(artifact.adapters ?? {});
    const adapters = {};
    for (const [agent, entries] of Object.entries(artifact.adapters ?? {})) {
        const present = entries.filter((adapter) => {
            try {
                const stats = lstatSync(join(root, adapter.path));
                if (adapter.type === "symlink") {
                    const linkPath = join(root, adapter.path);
                    return stats.isSymbolicLink()
                        && typeof adapter.target === "string"
                        && resolve(dirname(linkPath), readlinkSync(linkPath)) === resolve(root, adapter.target);
                }
                return adapter.type === "file" && stats.isFile();
            } catch {
                return false;
            }
        });
        if (present.length > 0) adapters[agent] = present;
    }
    artifact.adapters = adapters;
    return before !== JSON.stringify(adapters);
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
 * Request that the terminal emulator write the given text to the system clipboard
 * via the OSC 52 escape sequence. This travels through the terminal protocol itself,
 * so it also works over SSH and VS Code Remote / devcontainer sessions where the
 * container has no display server (X11/Wayland) for tools like xclip to attach to.
 * Support is terminal-dependent and cannot be confirmed programmatically: if the
 * terminal ignores the sequence, this is a silent no-op.
 * @param {string} text - The text to copy to the clipboard.
 * @returns {boolean} Whether the escape sequence was written (not whether the copy succeeded).
 */
export const copyToClipboard = (text) => {
    if (!process.stdout.isTTY) return false;
    const base64 = Buffer.from(text, "utf8").toString("base64");
    process.stdout.write(`\x1b]52;c;${base64}\x07`);
    return true;
};

/**
 * Build a "pnpm add -D" command string from a set of package names.
 * @param {string[]} packages - Package names to install as dev dependencies.
 * @returns {string} The formatted install command.
 */
export const buildInstallCommand = (packages) => `pnpm add -D ${packages.join(" ")}`;

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
