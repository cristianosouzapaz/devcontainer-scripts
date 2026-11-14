import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertRelativePath, loadAgentPacks, selectAgentPacks } from "../../lib/agent-packs.js";
import { getArtifactVersion, readLockFile, recordArtifact, skillSymlinkAdapter, writeLockFile } from "../../lib/lock-file.js";
import { readKitMetadata, stripKitMetadata } from "../../lib/template-metadata.js";
import { handleError, setupConsola } from "../../lib/utils.js";
import { writeOverwrite, writeWithConflict } from "../../lib/write-file.js";

/**
 * @fileoverview Local, first-party Agent Skills bundled with the installer package. See
 * `docs/wiki/installer/skills.md`. Each directory below `templates/` is one skill, described
 * by its own SKILL.md frontmatter; no catalog lists them. Agent adapters are symlinks placed
 * where each coding-agent pack's exposures say.
 *
 * Installed at /opt/devcontainer/installer/skills/local/ inside the container.
 */

const consola = setupConsola();
const templateRoot = fileURLToPath(new URL("./templates/", import.meta.url));

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
 * Assert that selected local skill keys can safely identify skill directories and paths.
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
 * Build the former relative target used by symlink adapters, e.g. `../../.agents/skills/<name>`
 * from a two-level adapter directory, which the external `skills` CLI still writes. It is
 * retained only to migrate adapters created before the agent's home directory became a
 * managed symlink.
 * @param {string} destRoot - Root holding both the adapter directory and `.agents`.
 * @param {string} adapterDir - Root-relative directory holding the adapter symlink.
 * @param {string} skillName - Canonical `.agents/skills/<skillName>` directory name.
 * @returns {string} Legacy relative symlink target.
 */
export const relativeCanonicalSkill = (destRoot, adapterDir, skillName) =>
    relative(join(destRoot, adapterDir), join(destRoot, ".agents", "skills", skillName));

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
 * Ensure an agent resolves a canonical skill through its native skills directory, a pack's
 * `skills.path`. Existing directories and links to another target are deliberately left
 * untouched: replacing them could discard an unmanaged agent-only skill tree, which must be
 * migrated explicitly rather than silently by an installer run.
 * @param {string} destRoot - Project or home root directory.
 * @param {string} skillsPath - Root-relative skills directory of the agent.
 * @param {string} skillName - Canonical `.agents/skills/<skillName>` directory name to link.
 * @returns {void} Nothing.
 * @throws {TypeError} If the root, skills directory or skill name is unsafe.
 * @throws {Error} If the target contains a conflicting skills entry.
 * @effects Creates directories and an absolute `<skillsPath>/<skillName>` symlink beneath destRoot when absent; replaces only the known legacy relative target.
 */
export const ensureSkillSymlink = (destRoot, skillsPath, skillName) => {
    assertProjectRoot(destRoot);
    assertRelativePath(skillsPath, "Skills directory");
    assertPathSegment(skillName, "Skill name");
    const canonicalSkillsDir = join(destRoot, ".agents", "skills");
    const agentSkillsDir = join(destRoot, skillsPath);

    mkdirSync(canonicalSkillsDir, { recursive: true });
    mkdirSync(dirname(agentSkillsDir), { recursive: true });

    try {
        const stats = lstatSync(agentSkillsDir);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new Error(
                `${skillsPath} must be a directory for selective skill symlinks. `
                + "The legacy directory symlink must be migrated explicitly before installing shared assets.",
            );
        }
    } catch (error) {
        if (!isMissingPathError(error)) throw error;
        mkdirSync(agentSkillsDir, { recursive: true });
    }

    ensureSymlink(join(agentSkillsDir, skillName), join(canonicalSkillsDir, skillName), join(skillsPath, skillName), relativeCanonicalSkill(destRoot, skillsPath, skillName));
};

/**
 * Expose an instruction skill as a path-scoped rule in an agent's rules directory, a pack's
 * `rules.path`, without copying its body.
 * @param {string} destRoot - Project or home root directory.
 * @param {string} rulesPath - Root-relative rules directory of the agent.
 * @param {string} skillName - Canonical `.agents/skills/<skillName>` directory name.
 * @param {string} ruleFilename - Rule filename.
 * @returns {void} Nothing.
 * @throws {TypeError} If an input path is unsafe.
 * @throws {Error} If the target rule path conflicts with another file or symlink.
 * @effects Creates the `<rulesPath>` directory and an absolute `<rulesPath>/<ruleFilename>` symlink beneath destRoot when absent; replaces only the known legacy relative target.
 */
export const ensureRuleSymlink = (destRoot, rulesPath, skillName, ruleFilename) => {
    assertProjectRoot(destRoot);
    assertRelativePath(rulesPath, "Rules directory");
    assertPathSegment(skillName, "Skill name");
    assertPathSegment(ruleFilename, "Rule filename");
    const rulesDir = join(destRoot, rulesPath);
    mkdirSync(rulesDir, { recursive: true });
    ensureSymlink(join(rulesDir, ruleFilename), join(destRoot, ".agents", "skills", skillName, "SKILL.md"), join(rulesPath, ruleFilename), join(relativeCanonicalSkill(destRoot, rulesPath, skillName), "SKILL.md"));
};

/**
 * List the files of one skill template directory as paths relative to it, SKILL.md first.
 * @param {string} key - Skill directory name below the templates root.
 * @returns {string[]} SKILL.md, then every other file of the directory in name order.
 * @throws {Error} If the directory cannot be read.
 * @effects Reads the directory tree of templates/<key>.
 */
const listSkillFiles = (key) => {
    const dir = join(templateRoot, key);
    const resources = readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter((path) => path !== "SKILL.md" && statSync(join(dir, path)).isFile())
        .sort();
    return ["SKILL.md", ...resources];
};

/**
 * Discover the local skills by scanning the templates root: every directory below it must
 * hold a SKILL.md whose frontmatter `name` is the directory name and whose `metadata` carries
 * the kit's `kit-*` keys.
 * @returns {{ key: string, version: string, tags: string[], global: boolean, files: string[] }[]}
 *   One entry per skill, in directory-name order.
 * @throws {Error} If a template cannot be read, its metadata is invalid, or its name differs
 *   from its directory.
 * @effects Reads every skill directory below the templates root.
 */
export const loadLocalSkills = () => readdirSync(templateRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((key) => {
        const label = `skills/local/templates/${key}/SKILL.md`;
        const { name, version, tags, global } = readKitMetadata(readFileSync(join(templateRoot, key, "SKILL.md"), "utf8"), label);
        if (name !== key) throw new Error(`${label}: name "${name}" must match its directory.`);
        return { key, version, tags, global, files: listSkillFiles(key) };
    });

/**
 * Read one file of a skill template as an installed file receives it: SKILL.md without the
 * kit's `kit-*` metadata keys, any other file as written.
 * @param {string} key - Skill directory name.
 * @param {string} file - Path relative to the skill directory.
 * @returns {string} The content to install.
 * @throws {Error} If the template file cannot be read.
 * @effects Reads templates/<key>/<file>.
 */
const readSkillFile = (key, file) => {
    const content = readFileSync(join(templateRoot, key, file), "utf8");
    return file === "SKILL.md" ? stripKitMetadata(content) : content;
};

/**
 * Write the given local skills and their other files below `.agents/skills/<key>/`,
 * prompting to resolve a conflict with the primary SKILL.md. The other files are written only
 * when that primary file is accepted, so an interactive skip leaves the existing skill payload
 * whole. Unknown keys are ignored.
 * @param {string[]} keys - Skill keys to install (typically the union of `kit-skills`
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
    const catalog = loadLocalSkills();
    const written = {};

    for (const key of keys) {
        const entry = catalog.find((candidate) => candidate.key === key);
        if (!entry) continue;

        const skillDir = join(destRoot, ".agents", "skills", key);
        mkdirSync(skillDir, { recursive: true });
        const [primary, ...resources] = entry.files;
        const canonicalPath = join(".agents", "skills", key, primary);
        const ok = await writeWithConflict(join(skillDir, primary), readSkillFile(key, primary), `${key}/${primary}`, entry.version, getArtifactVersion(lock, canonicalPath));
        if (!ok) continue;

        for (const resource of resources) {
            const resourcePath = join(skillDir, resource);
            mkdirSync(dirname(resourcePath), { recursive: true });
            await writeOverwrite(resourcePath, readSkillFile(key, resource), `${key}/${resource}`);
        }
        written[key] = entry.version;
    }

    return written;
};

/**
 * Non-interactive `--global` path: write the local skills whose metadata sets
 * `kit-global: "true"` into the shared machine-wide tree — canonical `~/.agents/skills/<key>/SKILL.md`
 * plus a `~/<skills.path>/<key>` symlink for every pack that exposes skills by symlink — tracked
 * in `~/.agents/template-lock.json`. Conflicts are overwritten (the template owns a global
 * asset); a pack whose agent reads `~/.agents/skills` natively gets no adapter. Assumes each
 * agent's config directory is the one under the home its pack names, as the devcontainer
 * image sets it.
 * @param {{ writer?: typeof writeOverwrite }} [options] - Writer override for tests.
 * @returns {Promise<void>}
 * @throws {TypeError} If options are malformed.
 * @throws {Error} If a template cannot be read or its metadata is invalid, the packs cannot
 *   be loaded, or the shared target cannot be updated.
 * @effects Reads the coding-agent packs and `CODING_AGENTS`, writes the selected skill files and the selected agents' symlinks below the user home directory, then writes its lock file.
 */
export const installGlobalLocalSkills = async (options = {}) => {
    if (options === null || typeof options !== "object" || Array.isArray(options)
        || (Object.hasOwn(options, "writer") && typeof options.writer !== "function")) {
        throw new TypeError("Global local skills options must be an object with an optional writer function.");
    }
    const globalSkills = loadLocalSkills().filter((entry) => entry.global);
    const keys = globalSkills.map((entry) => entry.key);
    const symlinkPacks = selectAgentPacks(loadAgentPacks(), process.env.CODING_AGENTS).filter((pack) => pack.skills.mode === "symlink");

    const destRoot = homedir();
    const lockRoot = join(destRoot, ".agents");
    const write = Object.hasOwn(options, "writer") ? options.writer : writeOverwrite;
    const result = await globalSkills.reduce(async (pending, entry) => {
        const { lock, changes } = await pending;
        const { key } = entry;
        const canonicalPath = join(".agents", "skills", key, "SKILL.md");
        const before = JSON.stringify(lock.artifacts[canonicalPath] ?? null);

        const writes = await entry.files.reduce(async (pending, file) => {
            const changes = await pending;
            const changed = await write(join(destRoot, ".agents", "skills", key, file), readSkillFile(key, file), `${key}/${file}`);
            return [...changes, changed];
        }, Promise.resolve([]));
        const withArtifact = recordArtifact(lock, canonicalPath, { kind: "skill", version: entry.version });

        for (const pack of symlinkPacks) ensureSkillSymlink(destRoot, pack.skills.path, key);
        const updatedLock = recordArtifact(withArtifact, canonicalPath, {
            kind: "skill",
            adapters: Object.fromEntries(symlinkPacks.map((pack) => [pack.id, [skillSymlinkAdapter(pack.skills.path, key)]])),
        });

        return {
            lock: updatedLock,
            changes: [...changes, writes.some(Boolean) || JSON.stringify(updatedLock.artifacts[canonicalPath]) !== before],
        };
    }, Promise.resolve({ lock: readLockFile(lockRoot), changes: [] }));

    if (result.changes.some(Boolean)) writeLockFile(lockRoot, result.lock);
    const synced = keys.slice().sort().join(", ");
    consola.success(`Global local skills synced: ${synced || "(no local skill sets kit-global)"}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    if (process.argv[2] === "--global") {
        try {
            await installGlobalLocalSkills();
        } catch (e) {
            handleError(e);
        }
    }
}
