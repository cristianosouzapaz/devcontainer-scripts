import { lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsonCatalog, loadValidatedCatalog } from "../../lib/catalog.js";
import { TOOLS } from "../../lib/constants.js";
import { claudeSkillAdapter, getArtifactVersion, readLockFile, recordArtifact, writeLockFile } from "../../lib/lock-file.js";
import { handleError, setupConsola } from "../../lib/utils.js";
import { writeOverwrite, writeWithConflict } from "../../lib/write-file.js";

/**
 * @fileoverview Local, first-party Agent Skills bundled with the installer package. See
 * `docs/wiki/installer/skills.md`. Claude instruction skills are linked only from
 * `.claude/rules` so they cannot load twice.
 *
 * Installed at /opt/devcontainer/installer/skills/local/ inside the container.
 */

const consola = setupConsola();
const TEMPLATE_ROOT = fileURLToPath(new URL("./templates/", import.meta.url));

const LOCAL_SKILLS_FILE_URL = new URL("./skills.json", import.meta.url);
const GLOBAL_MANIFEST_URL = new URL("./skills.global.json", import.meta.url);

/**
 * Assert that a value is an absolute project root path.
 * @param {unknown} root - Candidate project root path.
 * @returns {asserts root is string} Nothing.
 * @throws {TypeError} If the path is not an absolute, non-empty string.
 */
const assertProjectRoot = (root) => {
    if (typeof root !== "string" || root.length === 0 || !root.startsWith("/")) {
        throw new TypeError("Project root must be an absolute path.");
    }
};

/**
 * Assert that a value is a single safe filesystem path segment.
 * @param {unknown} value - Candidate path segment.
 * @param {string} label - Name used in the validation error.
 * @returns {asserts value is string} Nothing.
 * @throws {TypeError} If the segment is empty or could traverse a path.
 */
const assertPathSegment = (value, label) => {
    if (typeof value !== "string" || value.length === 0 || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
        throw new TypeError(`${label} must be a single path segment.`);
    }
};

/**
 * Assert that a catalog template path is a relative path without traversal segments.
 * @param {unknown} value - Candidate template file path.
 * @returns {asserts value is string} Nothing.
 * @throws {TypeError} If the template path is unsafe.
 */
const assertTemplatePath = (value) => {
    if (typeof value !== "string" || value.length === 0 || value.startsWith("/")
        || value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.includes("\\"))) {
        throw new TypeError("Template file must be a safe relative path.");
    }
};

/**
 * Assert that a local skills catalog entry owns every field used by this module.
 * @param {unknown} entry - Candidate local skills catalog entry.
 * @returns {asserts entry is { key: string, name: string, version: string, description: string, tags: string[], templateFile: string, resources?: string[] }} Nothing.
 * @throws {TypeError} If the entry is malformed.
 */
const assertLocalSkillEntry = (entry) => {
    if (entry === null || typeof entry !== "object"
        || !Object.hasOwn(entry, "key") || !Object.hasOwn(entry, "name")
        || !Object.hasOwn(entry, "version") || !Object.hasOwn(entry, "description")
        || !Object.hasOwn(entry, "tags") || !Object.hasOwn(entry, "templateFile")
        || typeof entry.name !== "string" || typeof entry.version !== "string"
        || typeof entry.description !== "string" || entry.description.length === 0
        || !Array.isArray(entry.tags) || entry.tags.some((tag) => typeof tag !== "string")) {
        throw new TypeError("Invalid local skills catalog entry.");
    }
    assertPathSegment(entry.key, "Local skill key");
    assertTemplatePath(entry.templateFile);
    const resources = entry.resources ?? [];
    if (!Array.isArray(resources) || resources.some((resource) => typeof resource !== "string")
        || new Set(resources).size !== resources.length || resources.includes(entry.templateFile)) {
        throw new TypeError("Local skill resources must be distinct template paths.");
    }
    for (const resource of resources) {
        assertTemplatePath(resource);
        const destination = relative(dirname(entry.templateFile), resource);
        if (destination.length === 0 || destination.startsWith("..") || isAbsolute(destination)) {
            throw new TypeError("Local skill resources must stay inside their skill template directory.");
        }
    }
};

/**
 * Return the template files that make up one local skill and their destinations below its
 * installed skill directory. Resources are constrained to the primary template's directory,
 * preventing one catalog entry from writing into another skill.
 * @param {{ templateFile: string, resources?: string[] }} entry - Validated local skill entry.
 * @returns {{ source: string, destination: string }[]} Template source and installed relative path pairs.
 */
const localSkillFiles = (entry) => {
    const templateRoot = dirname(entry.templateFile);
    return [entry.templateFile, ...(entry.resources ?? [])].map((source) => ({
        source,
        destination: relative(templateRoot, source),
    }));
};

/**
 * Assert that selected local skill keys can safely identify catalog entries and paths.
 * @param {unknown} keys - Candidate local skill keys.
 * @returns {asserts keys is string[]} Nothing.
 * @throws {TypeError} If keys is not an array of safe path segments.
 */
const assertSkillKeys = (keys) => {
    if (!Array.isArray(keys)) throw new TypeError("Local skill keys must be an array.");
    for (const key of keys) assertPathSegment(key, "Local skill key");
};

/**
 * Return whether a caught value is the expected missing-path filesystem error.
 * @param {unknown} error - Failure from an filesystem operation.
 * @returns {boolean} True only for ENOENT errors.
 */
const isMissingPathError = (error) => error instanceof Error
    && Object.hasOwn(error, "code") && error.code === "ENOENT";

/**
 * Build the former relative target used by Claude adapters. It is retained only to
 * migrate adapters created before ~/.claude became a managed symlink.
 * @param {string} skillName - Canonical `.agents/skills/<skillName>` directory name.
 * @returns {string} Legacy relative symlink target.
 */
const relativeCanonicalSkill = (skillName) => join("..", "..", ".agents", "skills", skillName);

/**
 * Create a symlink when absent, validate its target, or replace a known legacy target.
 * @param {string} linkPath - Absolute path of the adapter symlink.
 * @param {string} target - Expected absolute symlink target.
 * @param {string} description - Human-readable path used in conflict errors.
 * @param {string} [legacyTarget] - Former target that is safe to replace.
 * @returns {void}
 * @throws If the path exists and is not the expected symlink.
 * @effects Creates or replaces linkPath; other existing paths are left untouched and throw.
 */
const ensureSymlink = (linkPath, target, description, legacyTarget) => {
    try {
        const stats = lstatSync(linkPath);
        if (stats.isSymbolicLink() && readlinkSync(linkPath) === target) return;
        if (stats.isSymbolicLink() && readlinkSync(linkPath) === legacyTarget) {
            unlinkSync(linkPath);
            symlinkSync(target, linkPath);
            return;
        }
        throw new Error(`${description} already exists and is not the expected symlink. Migrate it explicitly before installing shared assets.`);
    } catch (error) {
        if (!isMissingPathError(error)) throw error;
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
 * @returns {void} Nothing.
 * @throws {TypeError} If the root or skill name is unsafe.
 * @throws {Error} If the target contains a conflicting Claude skills entry.
 * @effects Creates directories and an absolute `.claude/skills/<skillName>` symlink beneath destRoot when absent; replaces only the known legacy relative target.
 */
export const ensureClaudeSkillSymlink = (destRoot, skillName) => {
    assertProjectRoot(destRoot);
    assertPathSegment(skillName, "Skill name");
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
        if (!isMissingPathError(error)) throw error;
        mkdirSync(claudeSkillsPath, { recursive: true });
    }

    ensureSymlink(join(claudeSkillsPath, skillName), join(canonicalSkillsDir, skillName), `.claude/skills/${skillName}`, relativeCanonicalSkill(skillName));
};

/**
 * Expose an instruction skill as a Claude path-scoped rule without copying its body.
 * @param {string} destRoot - Project root directory.
 * @param {string} skillName - Canonical `.agents/skills/<skillName>` directory name.
 * @param {string} ruleFilename - Native Claude rule filename.
 * @returns {void} Nothing.
 * @throws {TypeError} If an input path is unsafe.
 * @throws {Error} If the target rule path conflicts with another file or symlink.
 * @effects Creates the `.claude/rules/<ruleFilename>` directory and an absolute symlink beneath destRoot when absent; replaces only the known legacy relative target.
 */
export const ensureClaudeRuleSymlink = (destRoot, skillName, ruleFilename) => {
    assertProjectRoot(destRoot);
    assertPathSegment(skillName, "Skill name");
    assertPathSegment(ruleFilename, "Rule filename");
    const rulesDir = join(destRoot, ".claude", "rules");
    mkdirSync(rulesDir, { recursive: true });
    ensureSymlink(join(rulesDir, ruleFilename), join(destRoot, ".agents", "skills", skillName, "SKILL.md"), `.claude/rules/${ruleFilename}`, relativeCanonicalSkill(skillName) + "/SKILL.md");
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
    optionalStringArrays: ["resources"],
    optionalSafeRelativePathArrays: ["resources"],
}).map((entry) => {
    assertLocalSkillEntry(entry);
    return entry;
});

/**
 * Write the given local skills and their declared resources below `.agents/skills/<key>/`,
 * prompting to resolve a conflict with the primary SKILL.md. Resources are written only when
 * that primary file is accepted, so an interactive skip leaves the existing skill payload whole.
 * Unknown keys are ignored.
 * @param {string[]} keys - Catalog entry keys to install (typically the union of `skills`
 *   referenced by the agent-md blocks the user selected).
 * @param {string} destRoot - Project root directory.
 * @param {object} lock - Parsed template-lock.json, used to resolve each skill's currently
 *   installed version for the conflict prompt.
 * @returns {Promise<Record<string, string>>} Map of skill key to installed version, for the
 *   caller to record in `lock.artifacts`.
 * @throws {TypeError} If keys, destination, or lock shape are invalid.
 * @throws {Error} If a template cannot be read or the target write is rejected.
 * @effects Reads each selected template and may write `.agents/skills/<key>/SKILL.md` below destRoot.
 */
export const installLocalSkills = async (keys, destRoot, lock) => {
    assertSkillKeys(keys);
    assertProjectRoot(destRoot);
    if (lock === null || typeof lock !== "object" || !Object.hasOwn(lock, "artifacts")
        || lock.artifacts === null || typeof lock.artifacts !== "object" || Array.isArray(lock.artifacts)) {
        throw new TypeError("Template lock must contain an artifacts object.");
    }
    const catalog = loadLocalSkillsCatalog();
    const written = {};

    for (const key of keys) {
        const entry = catalog.find((candidate) => candidate.key === key);
        if (!entry) continue;

        const skillDir = join(destRoot, ".agents", "skills", key);
        mkdirSync(skillDir, { recursive: true });
        const files = localSkillFiles(entry);
        const [primary, ...resources] = files;
        const canonicalPath = join(".agents", "skills", key, primary.destination);
        const content = readFileSync(join(TEMPLATE_ROOT, primary.source), "utf8");
        const ok = await writeWithConflict(join(skillDir, primary.destination), content, `${key}/${primary.destination}`, entry.version, getArtifactVersion(lock, canonicalPath));
        if (!ok) continue;

        for (const resource of resources) {
            const resourcePath = join(skillDir, resource.destination);
            mkdirSync(dirname(resourcePath), { recursive: true });
            const resourceContent = readFileSync(join(TEMPLATE_ROOT, resource.source), "utf8");
            await writeOverwrite(resourcePath, resourceContent, `${key}/${resource.destination}`);
        }
        written[key] = entry.version;
    }

    return written;
};

/**
 * Load and validate this installer's machine-wide manifest (`skills.global.json`): the flat
 * list of local skill catalog keys materialized into the shared `~/.agents` tree.
 * @returns {string[]}
 * @throws If the manifest is not an array of non-empty strings.
 */
const loadGlobalLocalSkills = () => {
    const keys = loadJsonCatalog(GLOBAL_MANIFEST_URL);
    try {
        assertSkillKeys(keys);
    } catch (error) {
        if (error instanceof TypeError) throw new Error("skills.global.json must be an array of local skill keys.", { cause: error });
        throw error;
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
 * @throws {TypeError} If options are malformed.
 * @throws {Error} If the manifest names missing catalog entries, a template cannot be read, or
 *   the shared target cannot be updated.
 * @effects Writes the selected skill files and Claude symlinks below the user home directory, then writes its lock file.
 */
export const installGlobalLocalSkills = async (options = {}) => {
    if (options === null || typeof options !== "object" || Array.isArray(options)
        || (Object.hasOwn(options, "writer") && typeof options.writer !== "function")) {
        throw new TypeError("Global local skills options must be an object with an optional writer function.");
    }
    const catalog = loadLocalSkillsCatalog();
    const keys = loadGlobalLocalSkills();
    const missing = keys.filter((key) => !catalog.some((entry) => entry.key === key));
    if (missing.length > 0) throw new Error(`skills.global.json keys absent from the catalog: ${missing.join(", ")}`);

    const destRoot = homedir();
    const lockRoot = join(destRoot, ".agents");
    const write = Object.hasOwn(options, "writer") ? options.writer : writeOverwrite;
    const result = await keys.reduce(async (pending, key) => {
        const { lock, changes } = await pending;
        const entry = catalog.find((candidate) => candidate.key === key);
        if (entry === undefined) throw new Error(`Local skill catalog is missing ${key}.`);
        const canonicalPath = join(".agents", "skills", key, "SKILL.md");
        const before = JSON.stringify(lock.artifacts[canonicalPath] ?? null);

        const files = localSkillFiles(entry);
        const writes = await files.reduce(async (pending, file) => {
            const changes = await pending;
            const content = readFileSync(join(TEMPLATE_ROOT, file.source), "utf8");
            const changed = await write(join(destRoot, ".agents", "skills", key, file.destination), content, `${key}/${file.destination}`);
            return [...changes, changed];
        }, Promise.resolve([]));
        const withArtifact = recordArtifact(lock, canonicalPath, { kind: "skill", version: entry.version });

        ensureClaudeSkillSymlink(destRoot, key);
        const updatedLock = recordArtifact(withArtifact, canonicalPath, {
            kind: "skill",
            adapters: { [TOOLS.claude]: [claudeSkillAdapter(key)] },
        });

        return {
            lock: updatedLock,
            changes: [...changes, writes.some(Boolean) || JSON.stringify(updatedLock.artifacts[canonicalPath]) !== before],
        };
    }, Promise.resolve({ lock: readLockFile(lockRoot), changes: [] }));

    if (result.changes.some(Boolean)) writeLockFile(lockRoot, result.lock);
    const synced = keys.slice().sort().join(", ");
    consola.success(`Global local skills synced: ${synced || "(skills.global.json is empty)"}`);
};

if (import.meta.url === `file://${process.argv[1]}`) {
    if (process.argv[2] === "--global") {
        try {
            await installGlobalLocalSkills();
        } catch (e) {
            handleError(e);
        }
    }
}
