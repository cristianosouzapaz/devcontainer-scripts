import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import consola from "consola";
import { checkbox } from "@inquirer/prompts";
import { claudeSkillAdapter, CLEAR_ON_DONE, formatVersionHint, handleError, loadValidatedCatalog, readLockFile, reconcileArtifactAdapters, recordArtifact, resolvePageSize, restoreChecked, selectTargetTools, selectUntilConfirmed, setupConsola, TOOLS, writeLockFile } from "../shared/utils.js";
import { ensureClaudeSkillSymlink, installLocalSkills } from "../skills/local/index.js";

/**
 * @fileoverview Interactive installer for canonical AGENTS.md instruction blocks.
 *
 * Each catalog entry is a self-contained markdown block, wrapped in an HTML marker on
 * install so subsequent runs can find and update it in place instead of duplicating it.
 *
 * All blocks are upserted into AGENTS.md, the canonical project instruction file, regardless
 * of the selected coding agent. When Claude Code is selected, CLAUDE.md is a small adapter
 * that imports AGENTS.md. This leaves Codex, GitHub Copilot, and future coding agents with
 * one shared source of truth.
 *
 * The catalog's "targets" field is declarative metadata only (documents which files a block
 * is valid in) — it does not filter the picker or affect routing.
 *
 * On install, updates template-lock.json's "mdBlocks.AGENTS.md" section and records local
 * skills with the native adapters materialized for them. The CLAUDE.md pointer is unversioned.
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
 * Load and validate the agent-md catalog. An entry's optional `skills` array holds skill
 * catalog keys (from skills/local/skills.json) that the block links to.
 * @returns {object[]} Validated agent-md block entries.
 * @throws If the catalog file or any entry is invalid.
 */
const loadAgentMdCatalog = () => loadValidatedCatalog(AGENT_MD_FILE_URL, "agent-md", {
    strings: ["key", "name", "version", "templateFile"],
    nonEmptyStrings: ["description"],
    stringArrays: ["tags", "targets"],
    optionalStringArrays: ["skills"],
});

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
const upsertBlock = (content, key, version, body) => {
    const { open, close } = buildMarkers(key, version);
    const block = `${open}\n${body.trimEnd()}\n${close}\n`;
    const regex = buildBlockRegex(key);

    if (regex.test(content)) return content.replace(regex, block);

    const separator = content.length > 0 && !content.endsWith("\n\n") ? (content.endsWith("\n") ? "\n" : "\n\n") : "";
    return `${content}${separator}${block}`;
};

// ─── Pointer file helpers ────────────────────────────────────────────────────

/**
 * Ensure CLAUDE.md exists and starts with the "@AGENTS.md" pointer line.
 * Creates the file with just the pointer line if missing; prepends the line if the file
 * exists without it. Logs every action taken via consola.info.
 * @param {string} claudeMdPath - Absolute path to CLAUDE.md.
 * @returns {string} The (possibly updated) CLAUDE.md content, for further block upserts.
 */
const ensureClaudePointer = (claudeMdPath) => {
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
 * @param {string} destFilename - Destination file name for logging.
 * @returns {Record<string, string>} Map of block key to installed version.
 */
const installBlocks = (blocks, destPath, destFilename) => {
    const initialContent = existsSync(destPath) ? readFileSync(destPath, "utf8") : "";
    const { content, written } = blocks.reduce((result, { key, version, templateFile }) => {
        const body = readFileSync(join(__dirname, "templates", templateFile), "utf8");
        return {
            content: upsertBlock(result.content, key, version, body),
            written: { ...result.written, [key]: version },
        };
    }, { content: initialContent, written: {} });

    writeFileSync(destPath, content, "utf8");
    consola.success(`${destFilename} updated`);
    return written;
};

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Prompt the user to select agent-md blocks, then install them into canonical AGENTS.md.
 * A Claude Code selection additionally creates the CLAUDE.md pointer and skills adapter.
 * Updates template-lock.json's mdBlocks section on completion.
 */
const askUser = async () => {
    try {
        const catalog = loadAgentMdCatalog();
        const destRoot = process.cwd();
        const lock = readLockFile(destRoot);
        if (!lock.mdBlocks) lock.mdBlocks = {};

        const choices = catalog.map((entry) => {
            const agentsVersion = lock.mdBlocks["AGENTS.md"]?.[entry.key] ?? null;
            const versionStr = formatVersionHint(agentsVersion, entry.version);
            return {
                name: `${entry.name} ${versionStr}`,
                value: entry,
                description: entry.description,
            };
        });

        const selectedBlocks = await selectUntilConfirmed(
            (previous) => checkbox({
                message: "Select blocks to install:",
                choices: restoreChecked(choices, previous),
                pageSize: resolvePageSize(choices.length),
            }, CLEAR_ON_DONE),
            (selected) => {
                const skillKeys = [...new Set(selected.flatMap((block) => block.skills ?? []))];
                return [
                    { title: "Agent MD blocks", items: selected.map(({ name }) => name) },
                    { title: "Included skills", items: skillKeys },
                ];
            },
            "Install selected blocks",
        );
        if (selectedBlocks === undefined) {
            consola.info("No blocks selected.");
            return;
        }
        if (selectedBlocks === null) return;

        const selectedTools = await selectTargetTools();
        const claudeMdPath = join(destRoot, "CLAUDE.md");
        const agentsMdPath = join(destRoot, "AGENTS.md");
        const written = installBlocks(selectedBlocks, agentsMdPath, "AGENTS.md");
        lock.mdBlocks["AGENTS.md"] = { ...lock.mdBlocks["AGENTS.md"], ...written };

        if (selectedTools.includes(TOOLS.claude)) ensureClaudePointer(claudeMdPath);

        const skillKeys = [...new Set(selectedBlocks.flatMap((block) => block.skills ?? []))];
        if (skillKeys.length > 0) {
            const written = await installLocalSkills(skillKeys, destRoot, lock);
            for (const [key, version] of Object.entries(written)) {
                recordArtifact(lock, join(".agents", "skills", key, "SKILL.md"), { kind: "skill", version });
            }
        }

        if (selectedTools.includes(TOOLS.claude)) {
            for (const key of skillKeys) {
                const path = join(".agents", "skills", key, "SKILL.md");
                if (!lock.artifacts[path]) continue;
                ensureClaudeSkillSymlink(destRoot, key);
                recordArtifact(lock, path, {
                    kind: "skill",
                    adapters: { claude: [claudeSkillAdapter(key)] },
                });
                reconcileArtifactAdapters(lock, destRoot, path);
            }
        }

        writeLockFile(destRoot, lock);
    } catch (e) {
        handleError(e);
    }
};

if (import.meta.url === `file://${process.argv[1]}`) await askUser();
