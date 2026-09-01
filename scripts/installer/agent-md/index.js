import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadValidatedCatalog } from "../shared/catalog.js";
import { TOOLS } from "../shared/constants.js";
import { claudeSkillAdapter, readLockFile, reconcileArtifactAdapters, recordArtifact, writeLockFile } from "../shared/lock-file.js";
import { pickAssets } from "../shared/pick-assets.js";
import { formatVersionHint, restoreChecked, selectTargetTools, selectUntilConfirmed } from "../shared/prompts.js";
import { handleError, isPromptCancellation, readGlobalSkillSet, setupConsola } from "../shared/utils.js";
import { ensureClaudeSkillSymlink, installLocalSkills } from "../skills/local/index.js";

/**
 * @fileoverview Interactive installer for canonical AGENTS.md instruction blocks. See
 * `docs/wiki/installer/agent-md.md`. Blocks use markers for in-place upserts; `targets` is
 * metadata only, and the CLAUDE.md pointer is unversioned.
 *
 * Installed at /opt/devcontainer/installer/agent-md/ inside the container.
 */

const consola = setupConsola();

const AGENT_MD_FILE_URL = new URL("./agent-md.json", import.meta.url);
const TEMPLATES_URL = new URL("./templates/", import.meta.url);
const POINTER_LINE = "@AGENTS.md";

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
    safeRelativePaths: ["templateFile"],
});

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

/**
 * Ensure CLAUDE.md exists and starts with the "@AGENTS.md" pointer line.
 * Creates the file with just the pointer line if missing; prepends the line if the file
 * exists without it. Logs every action taken via consola.info.
 * @param {string} claudeMdPath - Absolute path to CLAUDE.md.
 * @returns {string} The resulting CLAUDE.md content.
 * @throws {Error} If CLAUDE.md cannot be read or written.
 * @effects Reads and may create or overwrite claudeMdPath.
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

/**
 * Split the skills referenced by the selected blocks into those to install into the project
 * and those already present machine-wide (installed once by the "Sync Global Agent Assets"
 * task). Order follows first appearance across the blocks in catalog order; duplicates are
 * removed. The block text itself is written to AGENTS.md either way — only the per-project
 * skill copy is skipped for a globally installed skill.
 * @param {object[]} blocks - Selected catalog entries, in catalog order.
 * @param {Map<string, unknown>} globalSkills - Result of {@link readGlobalSkillSet}.
 * @returns {{ toInstall: string[], alreadyGlobal: string[] }}
 */
export const partitionReferencedSkills = (blocks, globalSkills) => {
    const referenced = [...new Set(blocks.flatMap((block) => block.skills ?? []))];
    return {
        toInstall: referenced.filter((key) => !globalSkills.has(key)),
        alreadyGlobal: referenced.filter((key) => globalSkills.has(key)),
    };
};

/**
 * Upsert the selected blocks into the given destination file, in catalog order.
 * Creates the file if it does not exist.
 * @param {object[]} blocks - Selected catalog entries, in catalog order.
 * @param {string} destPath - Absolute path to the destination file.
 * @param {string} destFilename - Destination file name for logging.
 * @returns {Record<string, string>} Map of block key to installed version.
 * @throws {Error} If a selected template cannot be read or destPath cannot be written.
 * @effects Reads selected templates and overwrites destPath.
 */
const installBlocks = (blocks, destPath, destFilename) => {
    const initialContent = existsSync(destPath) ? readFileSync(destPath, "utf8") : "";
    const { content, written } = blocks.reduce((result, { key, version, templateFile }) => {
        const body = readFileSync(new URL(templateFile, TEMPLATES_URL), "utf8");
        return {
            content: upsertBlock(result.content, key, version, body),
            written: { ...result.written, [key]: version },
        };
    }, { content: initialContent, written: {} });

    writeFileSync(destPath, content, "utf8");
    consola.success(`${destFilename} updated`);
    return written;
};

/**
 * Prompt the user to select agent-md blocks, then install them into canonical AGENTS.md.
 * A Claude Code selection additionally creates the CLAUDE.md pointer and skills adapter.
 * A block's referenced skill is installed into the project only when it is not already
 * present machine-wide (see {@link readGlobalSkillSet}); the block text is written either way.
 * Updates template-lock.json's mdBlocks section on completion.
 * @returns {Promise<void>} Nothing.
 * @throws {Error} If a prompt, template, project artifact, or lock operation fails unexpectedly.
 * @effects Prompts the user and may write AGENTS.md, CLAUDE.md, skills, Claude adapters, and the lock below the current project.
 */
const askUser = async () => {
    try {
        const catalog = loadAgentMdCatalog();
        const destRoot = process.cwd();
        const lock = readLockFile(destRoot);
        const state = { lock: { ...lock, mdBlocks: { ...lock.mdBlocks } } };

        // Skills already materialized machine-wide by the "Sync Global Agent Assets" task are
        // not re-installed into the project; the block text in AGENTS.md is still written.
        const globalSkills = readGlobalSkillSet();

        const choices = catalog.map((entry) => ({
            name: entry.name,
            value: entry,
            description: entry.description,
            annotation: formatVersionHint(state.lock.mdBlocks["AGENTS.md"]?.[entry.key] ?? null, entry.version),
        }));

        const selectedBlocks = await selectUntilConfirmed(
            (previous) => pickAssets({ message: "Select AGENTS.md blocks", choices: restoreChecked(choices, previous) }),
            (selected) => {
                const { toInstall, alreadyGlobal } = partitionReferencedSkills(selected, globalSkills);
                return [
                    { title: "Agent MD blocks", items: selected.map(({ name }) => name) },
                    { title: "Included skills", items: toInstall },
                    { title: "Already installed globally", items: alreadyGlobal },
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
        state.lock = { ...state.lock, mdBlocks: { ...state.lock.mdBlocks, "AGENTS.md": { ...state.lock.mdBlocks["AGENTS.md"], ...written } } };

        if (selectedTools.includes(TOOLS.claude)) ensureClaudePointer(claudeMdPath);

        const { toInstall: skillKeys, alreadyGlobal } = partitionReferencedSkills(selectedBlocks, globalSkills);

        if (alreadyGlobal.length > 0) {
            consola.info(`Skills already installed globally — not adding to the project: ${alreadyGlobal.join(", ")}`);
        }

        if (skillKeys.length > 0) {
            const written = await installLocalSkills(skillKeys, destRoot, state.lock);
            for (const [key, version] of Object.entries(written)) {
                state.lock = recordArtifact(state.lock, join(".agents", "skills", key, "SKILL.md"), { kind: "skill", version });
            }
        }

        if (selectedTools.includes(TOOLS.claude)) {
            for (const key of skillKeys) {
                const path = join(".agents", "skills", key, "SKILL.md");
                if (!Object.hasOwn(state.lock.artifacts, path)) continue;
                ensureClaudeSkillSymlink(destRoot, key);
                state.lock = recordArtifact(state.lock, path, {
                    kind: "skill",
                    adapters: { claude: [claudeSkillAdapter(key)] },
                });
                state.lock = reconcileArtifactAdapters(state.lock, destRoot, path).lock;
            }
        }

        writeLockFile(destRoot, state.lock);
    } catch (e) {
        if (!isPromptCancellation(e)) throw e;
        handleError(e);
    }
};

if (import.meta.url === `file://${process.argv[1]}`) await askUser();
