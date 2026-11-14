import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadAgentPacks } from "../lib/agent-packs.js";
import { readGlobalSkillSet } from "../lib/global-skill-set.js";
import { readLockFile, reconcileArtifactAdapters, recordArtifact, skillSymlinkAdapter, writeLockFile } from "../lib/lock-file.js";
import { pickAssets } from "../lib/pick-assets.js";
import { formatVersionHint, restoreChecked, selectTargetTools, selectUntilConfirmed } from "../lib/prompts.js";
import { scanTemplates } from "../lib/template-metadata.js";
import { handleError, isPromptCancellation, setupConsola } from "../lib/utils.js";
import { ensureSkillSymlink, installLocalSkills } from "../skills/local/index.js";

/**
 * @fileoverview Interactive installer for canonical AGENTS.md instruction blocks. See
 * `docs/wiki/installer/agent-md.md`. Each `templates/*.md` is one block, discovered by
 * scanning and described by its own frontmatter, which never reaches AGENTS.md. Blocks use
 * markers for in-place upserts; a pack's project instructions pointer to AGENTS.md is
 * unversioned.
 *
 * Installed at /opt/devcontainer/installer/agent-md/ inside the container.
 */

const consola = setupConsola();

const templatesDir = fileURLToPath(new URL("./templates/", import.meta.url));

/**
 * Discover the agent-md blocks by scanning `templates/`. A block's key is its file name
 * without `.md`; its `skills` are the local skill keys its `kit-skills` metadata names.
 * @returns {{ key: string, name: string, description: string, version: string, tags: string[], skills: string[], body: string }[]}
 *   One entry per block, in file-name order, with the block text after the frontmatter.
 * @throws {Error} If a template cannot be read or its metadata is invalid.
 * @effects Reads the templates directory and every block template in it.
 */
export const loadAgentMdBlocks = () => scanTemplates(templatesDir, ".md")
    .map(({ file, name, description, version, tags, skills, body }) => ({
        key: file.replace(/\.md$/, ""), name, description, version, tags, skills, body,
    }));

/**
 * Build the opening and closing HTML markers that wrap a block's content.
 * @param {string} key - Block key (template file name without `.md`).
 * @param {string} version - Block version (`kit-version`).
 * @returns {{ open: string, close: string }}
 */
const buildMarkers = (key, version) => ({
    open: `<!-- @devcontainer:agent-md:${key}@v${version} -->`,
    close: `<!-- /devcontainer:agent-md:${key} -->`,
});

/**
 * Build a regex that matches an existing marked block for the given key, regardless
 * of the version recorded in its opening marker.
 * @param {string} key - Block key (template file name without `.md`).
 * @returns {RegExp}
 */
const buildBlockRegex = (key) =>
    new RegExp(`<!-- @devcontainer:agent-md:${key}@v[^\\s]+ -->[\\s\\S]*?<!-- /devcontainer:agent-md:${key} -->\\n?`);

/**
 * Upsert a single block into file content: replace the existing marked block in-place
 * if present, otherwise append it at the end.
 * @param {string} content - Current file content (may be empty).
 * @param {string} key - Block key (template file name without `.md`).
 * @param {string} version - Block version (`kit-version`).
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
 * Ensure a pack's project instructions file (`projectInstructions.path`, mode `import`) exists
 * and holds an `@<path to AGENTS.md>` import line. Creates the file with just that line if
 * missing; prepends the line if the file exists without it. Logs every action taken via
 * consola.info.
 * @param {string} destRoot - Project root holding AGENTS.md.
 * @param {string} pointerPath - Root-relative path of the pack's instructions file.
 * @returns {void} Nothing.
 * @throws {Error} If the file cannot be read or written.
 * @effects Reads and may create or overwrite the file below destRoot, creating its directory.
 */
const ensureImportPointer = (destRoot, pointerPath) => {
    const filePath = join(destRoot, pointerPath);
    const pointerLine = `@${relative(dirname(filePath), join(destRoot, "AGENTS.md"))}`;
    if (!existsSync(filePath)) {
        consola.info(`${pointerPath} not found — creating it as a pointer to AGENTS.md`);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, `${pointerLine}\n`, "utf8");
        return;
    }

    const content = readFileSync(filePath, "utf8");
    if (content.split("\n").some((line) => line.trim() === pointerLine)) return;

    consola.info(`${pointerPath} found without an AGENTS.md pointer — prepending it`);
    writeFileSync(filePath, `${pointerLine}\n\n${content}`, "utf8");
};

/**
 * Split the skills referenced by the selected blocks into those to install into the project
 * and those already present machine-wide (installed once by the "Sync Global Agent Assets"
 * task). Order follows first appearance across the blocks in file-name order; duplicates are
 * removed. The block text itself is written to AGENTS.md either way — only the per-project
 * skill copy is skipped for a globally installed skill.
 * @param {object[]} blocks - Selected block entries, in file-name order.
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
 * Upsert the selected blocks into the given destination file, in file-name order.
 * Creates the file if it does not exist.
 * @param {object[]} blocks - Selected block entries, in file-name order.
 * @param {string} destPath - Absolute path to the destination file.
 * @param {string} destFilename - Destination file name for logging.
 * @returns {Record<string, string>} Map of block key to installed version.
 * @throws {Error} If destPath cannot be read or written.
 * @effects Reads and overwrites destPath.
 */
const installBlocks = (blocks, destPath, destFilename) => {
    const initialContent = existsSync(destPath) ? readFileSync(destPath, "utf8") : "";
    const { content, written } = blocks.reduce((result, { key, version, body }) => ({
        content: upsertBlock(result.content, key, version, body),
        written: { ...result.written, [key]: version },
    }), { content: initialContent, written: {} });

    writeFileSync(destPath, content, "utf8");
    consola.success(`${destFilename} updated`);
    return written;
};

/**
 * Prompt the user to select agent-md blocks, then install them into canonical AGENTS.md.
 * Each selected pack additionally gets its project instructions pointer (when its
 * `projectInstructions` mode is `import`) and its skill symlinks (when its `skills` mode is
 * `symlink`).
 * A block's referenced skill is installed into the project only when it is not already
 * present machine-wide (see {@link readGlobalSkillSet}); the block text is written either way.
 * Updates template-lock.json's mdBlocks section on completion.
 * @returns {Promise<void>} Nothing.
 * @throws {Error} If a prompt, template, pack, project artifact, or lock operation fails unexpectedly.
 * @effects Prompts the user, reads the coding-agent packs, and may write AGENTS.md, pack pointer files, skills, agent adapters, and the lock below the current project.
 */
const askUser = async () => {
    try {
        const catalog = loadAgentMdBlocks();
        const destRoot = process.cwd();
        const lock = readLockFile(destRoot);
        const state = { lock: { ...lock, mdBlocks: { ...lock.mdBlocks } } };
        const packs = loadAgentPacks();
        const globalSkills = readGlobalSkillSet(packs);

        const choices = catalog.map((entry) => ({
            name: entry.name,
            value: entry,
            description: entry.description,
            tags: entry.tags,
            annotation: formatVersionHint(state.lock.mdBlocks["AGENTS.md"]?.[entry.key] ?? null, entry.version),
        }));

        const selectedBlocks = await selectUntilConfirmed(
            (previous) => pickAssets({ message: "Select AGENTS.md blocks", choices: restoreChecked(choices, previous) }),
            (selected) => {
                const { toInstall, alreadyGlobal } = partitionReferencedSkills(selected, globalSkills);
                return [
                    { title: "Agent MD blocks", items: selected.map(({ name }) => name) },
                    { title: "Included skills", items: toInstall },
                    { title: "Already installed globally", items: alreadyGlobal, note: true },
                ];
            },
            "Install selected blocks",
        );
        if (selectedBlocks === undefined) {
            consola.info("No blocks selected.");
            return;
        }
        if (selectedBlocks === null) return;

        const selectedTools = await selectTargetTools(packs);
        const selectedPacks = packs.filter((pack) => selectedTools.includes(pack.id));
        const agentsMdPath = join(destRoot, "AGENTS.md");
        const written = installBlocks(selectedBlocks, agentsMdPath, "AGENTS.md");
        state.lock = { ...state.lock, mdBlocks: { ...state.lock.mdBlocks, "AGENTS.md": { ...state.lock.mdBlocks["AGENTS.md"], ...written } } };

        for (const pack of selectedPacks) {
            if (pack.projectInstructions.mode === "import") ensureImportPointer(destRoot, pack.projectInstructions.path);
        }

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

        for (const pack of selectedPacks.filter((candidate) => candidate.skills.mode === "symlink")) {
            for (const key of skillKeys) {
                const path = join(".agents", "skills", key, "SKILL.md");
                if (!Object.hasOwn(state.lock.artifacts, path)) continue;
                ensureSkillSymlink(destRoot, pack.skills.path, key);
                state.lock = recordArtifact(state.lock, path, {
                    kind: "skill",
                    adapters: { [pack.id]: [skillSymlinkAdapter(pack.skills.path, key)] },
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

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await askUser();
