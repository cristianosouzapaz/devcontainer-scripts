import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsonCatalog, writeWithConflict } from "../../shared/utils.js";

/**
 * @fileoverview Local, first-party Claude Code Skills bundled with the installer package.
 *
 * Unlike `skills/index.js` (third-party skills fetched via `npx skills add <url>`), these
 * skills ship as templates in this repo and are written directly to disk — no network call.
 *
 * Not run standalone: `agent-md/index.js` calls `installLocalSkills` for the union of
 * `skills` referenced by the CLAUDE.md/AGENTS.md blocks the user selected.
 *
 * Always written to `.claude/skills/<key>/SKILL.md`, regardless of the selected target tool
 * (claude / copilot / all) — `.claude/skills` is the only location both Claude Code and
 * GitHub Copilot scan.
 *
 * Installed at /opt/devcontainer/installer/skills/local/ inside the container.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

const LOCAL_SKILLS_FILE_URL = new URL("./skills.json", import.meta.url);

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
 * Write the given local skills to `.claude/skills/<key>/SKILL.md`, prompting to resolve
 * conflicts with any existing file. Unknown keys are ignored.
 * @param {string[]} keys - Catalog entry keys to install (typically the union of `skills`
 *   referenced by the agent-md blocks the user selected).
 * @param {string} destRoot - Project root directory.
 * @param {object} lock - Parsed template-lock.json, used to resolve each skill's currently
 *   installed version for the conflict prompt.
 * @returns {Promise<Record<string, string>>} Map of skill key to installed version, for the
 *   caller to merge into `lock.skills`.
 */
export const installLocalSkills = async (keys, destRoot, lock) => {
    const catalog = loadLocalSkillsCatalog();
    const written = {};

    for (const key of keys) {
        const entry = catalog.find((candidate) => candidate.key === key);
        if (!entry) continue;

        const content = readFileSync(join(__dirname, "templates", entry.templateFile), "utf8");
        const skillDir = join(destRoot, ".claude", "skills", key);
        mkdirSync(skillDir, { recursive: true });

        const ok = await writeWithConflict(join(skillDir, "SKILL.md"), content, `${key}/SKILL.md`, entry.version, lock.skills?.[key] ?? null);
        if (ok) written[key] = entry.version;
    }

    return written;
};
