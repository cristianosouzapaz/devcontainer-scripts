import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import consola from "consola";
import { checkbox } from "@inquirer/prompts";
import { formatVersionHint, handleError, loadJsonCatalog, readLockFile, resolvePageSize, selectTargetTool, setupConsola, TOOLS, writeLockFile } from "../shared/utils.js";
import { installLocalSkills } from "../skills/local/index.js";

/**
 * @fileoverview Interactive installer for CLAUDE.md / AGENTS.md instruction blocks.
 *
 * Each catalog entry is a self-contained markdown block, wrapped in an HTML marker on
 * install so subsequent runs can find and update it in place instead of duplicating it.
 *
 * Routing (no manual file choice — determined entirely by the selected tool):
 *   claude  → blocks are upserted into CLAUDE.md (created if missing). AGENTS.md untouched.
 *   copilot → blocks are upserted into AGENTS.md (created if missing). CLAUDE.md untouched.
 *   all     → blocks are upserted into AGENTS.md (created if missing). CLAUDE.md becomes a
 *             pointer file: created with a single "@AGENTS.md" line if missing, or that line
 *             is prepended if the file exists without it.
 *
 * The catalog's "targets" field is declarative metadata only (documents which files a block
 * is valid in) — it does not filter the picker or affect routing.
 *
 * On install, updates template-lock.json's "mdBlocks" section (nested by destination file)
 * with the installed block versions. The pointer line in CLAUDE.md (all mode) is not versioned.
 *
 * Installed at /opt/devcontainer/installer/agent-md/ inside the container.
 */

setupConsola();

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Constants ───────────────────────────────────────────────────────────────

const AGENT_MD_FILE_URL = new URL("./agent-md.json", import.meta.url);
const POINTER_LINE = "@AGENTS.md";

// ─── Catalog ─────────────────────────────────────────────────────────────────

/**
 * Load and validate the agent-md catalog from agent-md.json.
 * Each entry must have: key, name, version, description, tags (array of strings),
 * templateFile, targets (array of strings), and an optional skills array (skill catalog
 * keys, from skills/local/skills.json, that the block links to).
 * @returns {object[]} An array of validated agent-md block entries.
 * @throws Will throw an error if the catalog is invalid or cannot be read.
 */
export const loadAgentMdCatalog = () => {
    const entries = loadJsonCatalog(AGENT_MD_FILE_URL);

    for (const [index, entry] of entries.entries()) {
        const isValidEntry =
            typeof entry?.key === "string"
            && typeof entry?.name === "string"
            && typeof entry?.version === "string"
            && typeof entry?.description === "string"
            && entry.description.length > 0
            && typeof entry?.templateFile === "string"
            && Array.isArray(entry?.tags)
            && entry.tags.every((tag) => typeof tag === "string")
            && Array.isArray(entry?.targets)
            && entry.targets.every((target) => typeof target === "string")
            && (entry?.skills === undefined
                || (Array.isArray(entry.skills) && entry.skills.every((skill) => typeof skill === "string")));

        if (!isValidEntry) throw new Error(`Invalid agent-md catalog entry at index ${index}.`);
    }

    return entries;
};

// ─── Block marker helpers ────────────────────────────────────────────────────

/**
 * Build the opening and closing HTML markers that wrap a block's content.
 * @param {string} key - Catalog entry key.
 * @param {string} version - Catalog entry version.
 * @returns {{ open: string, close: string }}
 */
const buildMarkers = (key, version) => ({
    open: `<!-- @devcontainer:agent-md:${key}@v${version} -->`,
    close: `<!-- /devcontainer:agent-md:${key} -->`,
});

/**
 * Build a regex that matches an existing marked block for the given key, regardless
 * of the version recorded in its opening marker.
 * @param {string} key - Catalog entry key.
 * @returns {RegExp}
 */
const buildBlockRegex = (key) =>
    new RegExp(`<!-- @devcontainer:agent-md:${key}@v[^\\s]+ -->[\\s\\S]*?<!-- /devcontainer:agent-md:${key} -->\\n?`);

/**
 * Upsert a single block into file content: replace the existing marked block in-place
 * if present, otherwise append it at the end.
 * @param {string} content - Current file content (may be empty).
 * @param {string} key - Catalog entry key.
 * @param {string} version - Catalog entry version.
 * @param {string} body - Rendered block body (markdown, without markers).
 * @returns {string} Updated file content.
 */
export const upsertBlock = (content, key, version, body) => {
    const { open, close } = buildMarkers(key, version);
    const block = `${open}\n${body.trimEnd()}\n${close}\n`;
    const regex = buildBlockRegex(key);

    if (regex.test(content)) return content.replace(regex, block);

    const separator = content.length > 0 && !content.endsWith("\n\n") ? (content.endsWith("\n") ? "\n" : "\n\n") : "";
    return `${content}${separator}${block}`;
};

// ─── Pointer file helpers ────────────────────────────────────────────────────

/**
 * Ensure CLAUDE.md exists and starts with the "@AGENTS.md" pointer line, in "all" mode.
 * Creates the file with just the pointer line if missing; prepends the line if the file
 * exists without it. Logs every action taken via consola.info.
 * @param {string} claudeMdPath - Absolute path to CLAUDE.md.
 * @returns {string} The (possibly updated) CLAUDE.md content, for further block upserts.
 */
export const ensureClaudePointer = (claudeMdPath) => {
    if (!existsSync(claudeMdPath)) {
        consola.info("CLAUDE.md not found — creating it as a pointer to AGENTS.md");
        writeFileSync(claudeMdPath, `${POINTER_LINE}\n`, "utf8");
        return `${POINTER_LINE}\n`;
    }

    const content = readFileSync(claudeMdPath, "utf8");
    if (content.split("\n").some((line) => line.trim() === POINTER_LINE)) return content;

    consola.info("CLAUDE.md found without an AGENTS.md pointer — prepending it");
    const updated = `${POINTER_LINE}\n\n${content}`;
    writeFileSync(claudeMdPath, updated, "utf8");
    return updated;
};

// ─── Installer ───────────────────────────────────────────────────────────────

/**
 * Upsert the selected blocks into the given destination file, in catalog order.
 * Creates the file if it does not exist.
 * @param {object[]} blocks - Selected catalog entries, in catalog order.
 * @param {string} destPath - Absolute path to the destination file.
 * @param {string} destFilename - "CLAUDE.md" or "AGENTS.md".
 * @returns {Record<string, string>} Map of block key to installed version.
 */
export const installBlocks = (blocks, destPath, destFilename) => {
    let content = existsSync(destPath) ? readFileSync(destPath, "utf8") : "";
    const written = {};

    for (const { key, version, templateFile } of blocks) {
        const body = readFileSync(join(__dirname, "templates", templateFile), "utf8");
        content = upsertBlock(content, key, version, body);
        written[key] = version;
    }

    writeFileSync(destPath, content, "utf8");
    consola.success(`${destFilename} updated`);
    return written;
};

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Prompt the user to select agent-md blocks, then install them into CLAUDE.md and/or
 * AGENTS.md depending on the selected target tool. Updates template-lock.json's mdBlocks
 * section on completion.
 */
const askUser = async () => {
    try {
        const catalog = loadAgentMdCatalog();
        const destRoot = process.cwd();
        const lock = readLockFile(destRoot);
        if (!lock.mdBlocks) lock.mdBlocks = {};

        const choices = catalog.map((entry) => {
            const claudeVersion = lock.mdBlocks["CLAUDE.md"]?.[entry.key] ?? null;
            const agentsVersion = lock.mdBlocks["AGENTS.md"]?.[entry.key] ?? null;
            const installedVersion = claudeVersion ?? agentsVersion;
            const versionStr = formatVersionHint(installedVersion, entry.version);
            return {
                name: `${entry.name} ${versionStr}`,
                value: entry,
                description: entry.description,
            };
        });

        const selectedBlocks = await checkbox({
            message: "Select blocks to install:",
            choices,
            pageSize: resolvePageSize(choices.length),
        });

        if (selectedBlocks.length === 0) {
            consola.info("No blocks selected.");
            return;
        }

        const selectedTool = await selectTargetTool();
        const claudeMdPath = join(destRoot, "CLAUDE.md");
        const agentsMdPath = join(destRoot, "AGENTS.md");

        if (selectedTool === TOOLS.claude) {
            const written = installBlocks(selectedBlocks, claudeMdPath, "CLAUDE.md");
            lock.mdBlocks["CLAUDE.md"] = { ...lock.mdBlocks["CLAUDE.md"], ...written };
        }

        if (selectedTool === TOOLS.copilot) {
            const written = installBlocks(selectedBlocks, agentsMdPath, "AGENTS.md");
            lock.mdBlocks["AGENTS.md"] = { ...lock.mdBlocks["AGENTS.md"], ...written };
        }

        if (selectedTool === TOOLS.all) {
            const written = installBlocks(selectedBlocks, agentsMdPath, "AGENTS.md");
            lock.mdBlocks["AGENTS.md"] = { ...lock.mdBlocks["AGENTS.md"], ...written };
            ensureClaudePointer(claudeMdPath);
        }

        const skillKeys = [...new Set(selectedBlocks.flatMap((block) => block.skills ?? []))];
        if (skillKeys.length > 0) {
            if (!lock.skills) lock.skills = {};
            const written = await installLocalSkills(skillKeys, destRoot, lock);
            lock.skills = { ...lock.skills, ...written };
        }

        writeLockFile(destRoot, lock);
    } catch (e) {
        handleError(e);
    }
};

if (import.meta.url === `file://${process.argv[1]}`) await askUser();
