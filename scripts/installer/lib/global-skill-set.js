import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * @fileoverview The machine-wide asset lookup: which Agent Skills and commands are already
 * installed globally by the "Sync Global Agent Assets" task, so an interactive per-project
 * picker can render them as non-selectable rows instead of offering a redundant reinstall.
 */

/** @param {unknown} error - Filesystem failure. @returns {boolean} Whether an optional global source is unavailable. */
const isUnavailableGlobalSource = (error) => error instanceof Error && "code" in error && ["EACCES", "ENOENT", "ENOTDIR"].includes(error.code);

/**
 * Names of Agent Skills and commands already installed machine-wide by the "Sync Global Agent
 * Assets" task, so an interactive per-project picker can render them as a non-selectable
 * `disabled` row instead of offering a redundant reinstall.
 *
 * Three optional sources are unioned, so a name counts as global no matter which path
 * installed it: `~/.agents/template-lock.json` (first-party instruction / prompt / local-skill
 * artifacts — the recorded version is kept), plus the directory listings of `~/.agents/skills`
 * and `<CLAUDE_CONFIG_DIR|~/.claude>/skills` (any skill the external `skills` CLI materialized
 * with `-g`). A missing file or directory contributes nothing and never throws.
 *
 * @returns {Map<string, string|null>} name → recorded version, or null when the name is only
 *   known from a directory listing.
 * @throws {Error} If an existing global source cannot be inspected.
 * @effects Reads the global `.agents` and `.claude` directories and optional lock file below the current user home directory.
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
        } catch (error) {
            if (!isUnavailableGlobalSource(error)) throw error;
        }
    }

    try {
        const lock = JSON.parse(readFileSync(join(agentsRoot, "template-lock.json"), "utf8"));
        const artifacts = lock !== null && typeof lock === "object" && !Array.isArray(lock) && Object.hasOwn(lock, "artifacts") && lock.artifacts !== null && typeof lock.artifacts === "object" && !Array.isArray(lock.artifacts) ? lock.artifacts : {};
        for (const [path, artifact] of Object.entries(artifacts)) {
            const match = /^\.agents\/skills\/(.+)\/SKILL\.md$/.exec(path);
            const version = artifact !== null && typeof artifact === "object" && !Array.isArray(artifact) && Object.hasOwn(artifact, "version") && typeof artifact.version === "string" ? artifact.version : null;
            if (match) found.set(match[1], version);
        }
    } catch (error) {
        if (!(error instanceof SyntaxError) && !isUnavailableGlobalSource(error)) throw error;
    }

    return found;
};
