import { lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getArtifactVersion, loadJsonCatalog, writeWithConflict } from "../../shared/utils.js";

/**
 * @fileoverview Local, first-party Agent Skills bundled with the installer package.
 *
 * Unlike `skills/index.js` (third-party skills fetched via `npx skills add <url>`), these
 * skills ship as templates in this repo and are written directly to disk — no network call.
 *
 * Not run standalone: `agent-md/index.js` calls `installLocalSkills` for the union of
 * `skills` referenced by the AGENTS.md blocks the user selected.
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
 * Each entry must have: key, name, version, description, tags (array of strings), templateFile.
 * @returns {object[]} An array of validated local skill entries.
 * @throws Will throw an error if the catalog is invalid or cannot be read.
 */
export const loadLocalSkillsCatalog = () => {
    const entries = loadJsonCatalog(LOCAL_SKILLS_FILE_URL);

    for (const [index, entry] of entries.entries()) {
        const isValidEntry =
            typeof entry?.key === "string"
            && typeof entry?.name === "string"
            && typeof entry?.version === "string"
            && typeof entry?.description === "string"
            && entry.description.length > 0
            && typeof entry?.templateFile === "string"
            && Array.isArray(entry?.tags)
            && entry.tags.every((tag) => typeof tag === "string");

        if (!isValidEntry) throw new Error(`Invalid local skills catalog entry at index ${index}.`);
    }

    return entries;
};

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
