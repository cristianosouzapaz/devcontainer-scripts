import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import chalk from "chalk";
import consola from "consola";
import { checkbox, select } from "@inquirer/prompts";

/**
 * @fileoverview Shared utilities for all framework installer scripts.
 *
 * Exports:
 *   - File writing:  writeWithConflict (interactive), writeOverwrite (non-interactive --global sync)
 *   - Version read:  readConfigInstalledVersion (lock file)
 *   - Lock file:     readLockFile, writeLockFile, getArtifactVersion, recordArtifact,
 *                    reconcileArtifactAdapters
 *                    → template-lock.json in the user's project root, or in ~/.agents for --global
 *   - Adapters:      claudeSkillAdapter, claudeRuleAdapter (lock-file symlink records)
 *   - UI helpers:    buildTagsStr, setupConsola, selectTargetTools, resolvePageSize, formatVersionHint,
 *                    formatSelectionSummary, confirmSelection, CLEAR_ON_DONE
 *   - Global dedup:  readGlobalSkillSet, disableGlobalChoices
 *                    → grey out per-project picker entries already installed machine-wide
 *   - Clipboard:     copyToClipboard, buildInstallCommand
 *   - Catalog:       loadJsonCatalog, loadValidatedCatalog
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

/** Context shared by interactive prompts so completed screens do not accumulate in the terminal. */
export const CLEAR_ON_DONE = { clearPromptOnDone: true };

/**
 * Upper bound on checkbox pageSize, so a catalog stays on one screen without
 * an unbounded prompt height if it grows very large.
 */
const MAX_CATALOG_PAGE_SIZE = 30;

/**
 * Build a fresh, empty lock structure for the current schema version.
 * @returns {{ version: string, updatedAt: string, configs: object, artifacts: object, mdBlocks: object }}
 */
const emptyLock = () => ({ version: LOCK_VERSION, updatedAt: "", configs: {}, artifacts: {}, mdBlocks: {} });

/**
 * Merge a native adapter record into an agent's adapter list in place.
 * Updates an existing entry with the same path and type, otherwise appends it.
 * @param {Record<string, object[]>} adapters - Map of agent name to adapter entries.
 * @param {string} agent - Agent name key.
 * @param {{ path: string, type: string }} adapter - Adapter record to merge.
 * @returns {void} Nothing; does nothing when agent or adapter is missing.
 */
const addAdapter = (adapters, agent, adapter) => {
    if (!agent || !adapter) return;
    const entries = adapters[agent] ?? [];
    const existing = entries.find((entry) => entry.path === adapter.path && entry.type === adapter.type);
    if (existing) Object.assign(existing, adapter);
    else entries.push(adapter);
    adapters[agent] = entries;
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
 * Load a JSON catalog and validate every entry against a field schema.
 * @param {URL|string} fileUrl - URL or path of the JSON catalog to load.
 * @param {string} catalogName - Name used in the "Invalid <name> catalog entry" error.
 * @param {{
 *   strings?: string[],
 *   nonEmptyStrings?: string[],
 *   stringArrays?: string[],
 *   optionalStringArrays?: string[],
 * }} [schema] - Required string fields, non-empty string fields, string-array fields, and
 *   string-array fields that may also be absent.
 * @returns {object[]} The validated entries.
 * @throws If the file is not an array or any entry violates the schema.
 */
export const loadValidatedCatalog = (fileUrl, catalogName, schema = {}) => {
    const { strings = [], nonEmptyStrings = [], stringArrays = [], optionalStringArrays = [] } = schema;
    const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
    const entries = loadJsonCatalog(fileUrl);

    entries.forEach((entry, index) => {
        const valid =
            strings.every((key) => typeof entry?.[key] === "string")
            && nonEmptyStrings.every((key) => typeof entry?.[key] === "string" && entry[key].length > 0)
            && stringArrays.every((key) => isStringArray(entry?.[key]))
            && optionalStringArrays.every((key) => entry?.[key] === undefined || isStringArray(entry[key]));
        if (!valid) throw new Error(`Invalid ${catalogName} catalog entry at index ${index}.`);
    });

    return entries;
};

/**
 * Configure consola to suppress timestamps in output.
 */
export const setupConsola = () => {
    consola.options = { ...consola.options, formatOptions: { ...consola.options.formatOptions, date: false } };
};

/**
 * Format the common, deliberately plain-text summary shown before an installer proceeds.
 * @param {{title: string, items: string[]}[]} sections - Non-empty summary sections.
 * @returns {string}
 */
export const formatSelectionSummary = (sections) => {
    const visibleSections = sections.filter(({ items }) => items.length > 0);
    const contentLines = visibleSections.flatMap(({ title, items }) => [
        `${title} (${items.length})`,
        ...items.map((item) => `  • ${item}`),
        "",
    ]);
    const width = Math.max(44, ...contentLines.map((line) => line.length));
    const top = `┌─ Selection summary ${"─".repeat(width - 18)}┐`;
    const bottom = `└${"─".repeat(width + 2)}┘`;
    return [
        top,
        ...contentLines.map((line) => `│ ${line.padEnd(width)} │`),
        bottom,
    ].join("\n");
};

/**
 * Print a selection summary and ask whether to install, edit, or cancel it.
 * @param {{title: string, items: string[]}[]} sections - Summary sections.
 * @param {string} installLabel - Action label for the install choice.
 * @returns {Promise<"install"|"edit"|"cancel">}
 */
export const confirmSelection = async (sections, installLabel = "Install selected assets") => {
    consola.log("");
    consola.log(formatSelectionSummary(sections));
    consola.log("");
    return select({
        message: "What would you like to do?",
        choices: [
            { name: installLabel, value: "install" },
            { name: "Continue editing selection", value: "edit" },
            { name: "Cancel", value: "cancel" },
        ],
    }, CLEAR_ON_DONE);
};

/**
 * Repeat a selection and confirmation until the user installs or cancels.
 * Returns undefined for an empty selection and null for an explicit cancellation.
 * @param {() => Promise<unknown>} selectSelection - Function that opens the asset picker.
 * @param {(selection: unknown) => {title: string, items: string[]}[]} buildSections - Summary builder.
 * @param {string} installLabel - Action label for the install choice.
 * @param {(selection: unknown) => boolean} [isEmpty] - Selection emptiness test.
 * @returns {Promise<unknown|null|undefined>}
 */
export const selectUntilConfirmed = async (selectSelection, buildSections, installLabel, isEmpty = (selection) => selection.length === 0) => {
    const selection = await selectSelection();
    if (isEmpty(selection)) return undefined;

    const action = await confirmSelection(buildSections(selection), installLabel);
    if (action === "install") return selection;
    if (action === "cancel") return null;
    return selectUntilConfirmed(selectSelection, buildSections, installLabel, isEmpty);
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
}, CLEAR_ON_DONE);

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
 * Non-interactive writer for the `--global` sync path. Overwrites unconditionally
 * (the template is the source of truth for a globally-installed asset), but reports
 * "not written" when the on-disk content already matches, so the lock file and its
 * `updatedAt` stamp only move on a real change. Same signature as `writeWithConflict`.
 * @param {string} destPath - Absolute destination path.
 * @param {string} content - File content to write.
 * @param {string} filename - Display name for the log line.
 * @returns {Promise<boolean>} Whether the file was (re)written.
 */
export const writeOverwrite = async (destPath, content, filename) => {
    if (existsSync(destPath) && readFileSync(destPath, "utf8") === content) return false;
    mkdirSync(dirname(destPath), { recursive: true });
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

// ─── Claude adapter records ──────────────────────────────────────────────────

/**
 * Lock-file adapter record for a `.claude/skills/<skillName>` symlink that points at
 * the canonical skill directory.
 * @param {string} skillName - Portable Agent Skill name.
 * @returns {{ path: string, type: "symlink", target: string }}
 */
export const claudeSkillAdapter = (skillName) => ({
    path: join(".claude", "skills", skillName),
    type: "symlink",
    target: join(".agents", "skills", skillName),
});

/**
 * Lock-file adapter record for a `.claude/rules/<filename>` symlink that points at a
 * canonical skill's SKILL.md.
 * @param {string} skillName - Portable Agent Skill name.
 * @param {string} filename - Rule filename under .claude/rules/.
 * @returns {{ path: string, type: "symlink", target: string }}
 */
export const claudeRuleAdapter = (skillName, filename) => ({
    path: join(".claude", "rules", filename),
    type: "symlink",
    target: join(".agents", "skills", skillName, "SKILL.md"),
});

// ─── Global asset dedup ──────────────────────────────────────────────────────

/**
 * Names of Agent Skills and commands already installed machine-wide by the
 * "Sync Global Agent Assets" task, so an interactive per-project picker can render them as a
 * non-selectable `disabled` row instead of offering a redundant reinstall.
 *
 * Three optional sources are unioned, so a name counts as global no matter which path
 * installed it: `~/.agents/template-lock.json` (first-party instruction / prompt / local-skill
 * artifacts — the recorded version is kept), plus the directory listings of `~/.agents/skills`
 * and `<CLAUDE_CONFIG_DIR|~/.claude>/skills` (any skill the external `skills` CLI materialized
 * with `-g`). A missing file or directory contributes nothing and never throws.
 *
 * @returns {Map<string, string|null>} skill / command name → recorded version, or null when
 *   the name is only known from a directory listing.
 */
export const readGlobalSkillSet = () => {
    const agentsRoot = join(homedir(), ".agents");
    const claudeRoot = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    const found = new Map();

    for (const dir of [join(agentsRoot, "skills"), join(claudeRoot, "skills")]) {
        try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                if (!entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()) && !found.has(entry.name)) {
                    found.set(entry.name, null);
                }
            }
        } catch { /* directory absent — contributes nothing */ }
    }

    try {
        const lock = JSON.parse(readFileSync(join(agentsRoot, "template-lock.json"), "utf8"));
        for (const [path, artifact] of Object.entries(lock?.artifacts ?? {})) {
            const match = /^\.agents\/skills\/(.+)\/SKILL\.md$/.exec(path);
            if (match) found.set(match[1], artifact?.version ?? null);
        }
    } catch { /* lock absent or invalid — directory listings still stand */ }

    return found;
};

/** Non-selectable annotation for a catalog entry already installed machine-wide. */
const globalInstallLabel = (version) => `installed globally${version ? ` (v${version})` : ""}`;

/**
 * Return a copy of `@inquirer` checkbox `choices` with every entry whose key is already
 * installed machine-wide marked `disabled`, so a per-project picker never re-offers a global
 * asset. Input choices are not mutated.
 * @param {object[]} choices - Checkbox choice objects.
 * @param {(choice: object) => string} keyOf - Extracts the global-set key for a choice.
 * @param {Map<string, string|null>} globalSet - Output of `readGlobalSkillSet`.
 * @returns {object[]}
 */
export const disableGlobalChoices = (choices, keyOf, globalSet) =>
    choices.map((choice) => {
        const key = keyOf(choice);
        return globalSet.has(key) ? { ...choice, disabled: globalInstallLabel(globalSet.get(key)) } : choice;
    });

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
