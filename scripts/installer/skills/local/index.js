import { lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import consola from "consola";
import { claudeSkillAdapter, getArtifactVersion, handleError, loadJsonCatalog, loadValidatedCatalog, readLockFile, recordArtifact, setupConsola, TOOLS, writeLockFile, writeOverwrite, writeWithConflict } from "../../shared/utils.js";

/**
 * @fileoverview Local, first-party Agent Skills bundled with the installer package.
 *
 * Unlike `skills/index.js` (third-party skills fetched via `npx skills add <url>`), these
 * skills ship as templates in this repo and are written directly to disk — no network call.
 *
 * Two entry points:
 *   - default (library): `agent-md/index.js` calls `installLocalSkills` for the union of
 *     `skills` referenced by the AGENTS.md blocks the user selected.
 *   - `--global`: non-interactive machine-wide install of the keys listed in this
 *     installer's own `skills.global.json`, into `~/.agents` + `~/.claude`, tracked in
 *     `~/.agents/template-lock.json`. See `installGlobalLocalSkills`.
 *
 * Always written to `.agents/skills/<key>/SKILL.md`, the canonical project location shared
 * by Codex and GitHub Copilot. Claude receives a selective symlink for each skill that is
 * actually a Claude skill; instruction skills are linked only from `.claude/rules` so they
 * cannot be loaded twice by Claude.
 *
 * Installed at /opt/devcontainer/installer/skills/local/ inside the container.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

const LOCAL_SKILLS_FILE_URL = new URL("./skills.json", import.meta.url);
const GLOBAL_MANIFEST_URL = new URL("./skills.global.json", import.meta.url);

/**
 * Build the relative path from a Claude adapter directory to a canonical Agent Skill.
 * @param {string} skillName - Canonical `.agents/skills/<skillName>` directory name.
 * @returns {string} Relative symlink target.
 */
const relativeCanonicalSkill = (skillName) => join("..", "..", ".agents", "skills", skillName);

/**
 * Create a symlink when absent, or validate the existing symlink target.
 * @param {string} linkPath - Absolute path of the adapter symlink.
 * @param {string} target - Expected relative symlink target.
 * @param {string} description - Human-readable path used in conflict errors.
 * @returns {void}
 * @throws If the path exists and is not the expected symlink.
 */
const ensureSymlink = (linkPath, target, description) => {
    try {
        const stats = lstatSync(linkPath);
        if (stats.isSymbolicLink() && readlinkSync(linkPath) === target) return;
        throw new Error(`${description} already exists and is not the expected symlink. Migrate it explicitly before installing shared assets.`);
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }
    symlinkSync(target, linkPath);
};

/**
 * Ensure Claude Code resolves the canonical project skills through its native discovery
 * path. Existing directories and links to another target are deliberately left untouched:
 * replacing them could discard an unmanaged Claude-only skill tree, which must be migrated
 * explicitly rather than silently by an installer run.
 * @param {string} destRoot - Project root directory.
 * @param {string} skillName - Canonical `.agents/skills/<skillName>` directory name to link.
 * @throws If `.claude/skills` exists as the legacy global symlink or a conflicting entry exists.
 */
export const ensureClaudeSkillSymlink = (destRoot, skillName) => {
    const canonicalSkillsDir = join(destRoot, ".agents", "skills");
    const claudeDir = join(destRoot, ".claude");
    const claudeSkillsPath = join(claudeDir, "skills");

    mkdirSync(canonicalSkillsDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });

    try {
        const stats = lstatSync(claudeSkillsPath);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new Error(
                ".claude/skills must be a directory for selective skill symlinks. "
                + "The legacy directory symlink must be migrated explicitly before installing shared assets.",
            );
        }
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        mkdirSync(claudeSkillsPath, { recursive: true });
    }

    ensureSymlink(join(claudeSkillsPath, skillName), relativeCanonicalSkill(skillName), `.claude/skills/${skillName}`);
};

/**
 * Expose an instruction skill as a Claude path-scoped rule without copying its body.
 * @param {string} destRoot - Project root directory.
 * @param {string} skillName - Canonical `.agents/skills/<skillName>` directory name.
 * @param {string} ruleFilename - Native Claude rule filename.
 */
export const ensureClaudeRuleSymlink = (destRoot, skillName, ruleFilename) => {
    const rulesDir = join(destRoot, ".claude", "rules");
    mkdirSync(rulesDir, { recursive: true });
    ensureSymlink(join(rulesDir, ruleFilename), relativeCanonicalSkill(skillName) + "/SKILL.md", `.claude/rules/${ruleFilename}`);
};

/**
 * Load and validate the local skills catalog from skills.json.
 * @returns {object[]} Validated local skill entries.
 * @throws If the catalog file or any entry is invalid.
 */
const loadLocalSkillsCatalog = () => loadValidatedCatalog(LOCAL_SKILLS_FILE_URL, "local skills", {
    strings: ["key", "name", "version", "templateFile"],
    nonEmptyStrings: ["description"],
    stringArrays: ["tags"],
});

/**
 * Write the given local skills to `.agents/skills/<key>/SKILL.md`, prompting to resolve
 * conflicts with any existing file. Unknown keys are ignored.
 * @param {string[]} keys - Catalog entry keys to install (typically the union of `skills`
 *   referenced by the agent-md blocks the user selected).
 * @param {string} destRoot - Project root directory.
 * @param {object} lock - Parsed template-lock.json, used to resolve each skill's currently
 *   installed version for the conflict prompt.
 * @returns {Promise<Record<string, string>>} Map of skill key to installed version, for the
 *   caller to record in `lock.artifacts`.
 */
export const installLocalSkills = async (keys, destRoot, lock) => {
    const catalog = loadLocalSkillsCatalog();
    const written = {};

    for (const key of keys) {
        const entry = catalog.find((candidate) => candidate.key === key);
        if (!entry) continue;

        const content = readFileSync(join(__dirname, "templates", entry.templateFile), "utf8");
        const skillDir = join(destRoot, ".agents", "skills", key);
        mkdirSync(skillDir, { recursive: true });

        const canonicalPath = join(".agents", "skills", key, "SKILL.md");
        const ok = await writeWithConflict(join(skillDir, "SKILL.md"), content, `${key}/SKILL.md`, entry.version, getArtifactVersion(lock, canonicalPath));
        if (ok) written[key] = entry.version;
    }

    return written;
};

// ─── Global (non-interactive) scope ──────────────────────────────────────────

/**
 * Load and validate this installer's machine-wide manifest (`skills.global.json`): the flat
 * list of local skill catalog keys materialized into the shared `~/.agents` tree.
 * @returns {string[]}
 * @throws If the manifest is not an array of non-empty strings.
 */
const loadGlobalLocalSkills = () => {
    const keys = loadJsonCatalog(GLOBAL_MANIFEST_URL);
    if (!keys.every((key) => typeof key === "string" && key.length > 0)) {
        throw new Error("skills.global.json must be an array of local skill keys.");
    }
    return keys;
};

/**
 * Non-interactive `--global` path: write the local skills named in `skills.global.json`
 * into the shared machine-wide tree — canonical `~/.agents/skills/<key>/SKILL.md` plus a
 * `~/.claude/skills/<key>` symlink — tracked in `~/.agents/template-lock.json`. Conflicts
 * are overwritten (the template owns a global asset) and only the Claude adapter is
 * materialized; Codex reads `~/.agents/skills` directly. Assumes `CLAUDE_CONFIG_DIR` is
 * `~/.claude`, as the devcontainer image sets it.
 * @param {{ writer?: typeof writeOverwrite }} [options] - Writer override for tests.
 * @returns {Promise<void>}
 */
export const installGlobalLocalSkills = async (options = {}) => {
    const catalog = loadLocalSkillsCatalog();
    const keys = loadGlobalLocalSkills();
    const missing = keys.filter((key) => !catalog.some((entry) => entry.key === key));
    if (missing.length > 0) throw new Error(`skills.global.json keys absent from the catalog: ${missing.join(", ")}`);

    const destRoot = homedir();
    const lockRoot = join(destRoot, ".agents");
    const lock = readLockFile(lockRoot);
    const write = options.writer ?? writeOverwrite;

    const changes = [];
    for (const key of keys) {
        const entry = catalog.find((candidate) => candidate.key === key);
        const canonicalPath = join(".agents", "skills", key, "SKILL.md");
        const before = JSON.stringify(lock.artifacts[canonicalPath] ?? null);

        const content = readFileSync(join(__dirname, "templates", entry.templateFile), "utf8");
        const written = await write(join(destRoot, canonicalPath), content, `${key}/SKILL.md`);
        recordArtifact(lock, canonicalPath, { kind: "skill", version: entry.version });

        ensureClaudeSkillSymlink(destRoot, key);
        recordArtifact(lock, canonicalPath, {
            kind: "skill",
            adapters: { [TOOLS.claude]: [claudeSkillAdapter(key)] },
        });

        changes.push(written || JSON.stringify(lock.artifacts[canonicalPath]) !== before);
    }

    if (changes.some(Boolean)) writeLockFile(lockRoot, lock);
    const synced = keys.slice().sort().join(", ");
    consola.success(`Global local skills synced: ${synced || "(skills.global.json is empty)"}`);
};

if (import.meta.url === `file://${process.argv[1]}`) {
    if (process.argv[2] === "--global") {
        setupConsola();
        try {
            await installGlobalLocalSkills();
        } catch (e) {
            handleError(e);
        }
    }
}
