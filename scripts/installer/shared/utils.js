import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import consola from "consola";

/**
 * @fileoverview Process- and environment-level helpers that don't belong to a narrower
 * module: consola setup, the machine-wide asset lookup, clipboard/OSC-52, and the top-level
 * error handler. Catalog loading is in `catalog.js`, the lock file in `lock-file.js`, file
 * writing in `write-file.js`, and the selection prompts in `prompts.js` / `pick-assets.js`.
 */

/**
 * Return a consola instance configured for installer output without changing the shared default.
 * @returns {typeof consola} A timestamp-free consola instance.
 */
export const setupConsola = () => consola.withDefaults({ formatOptions: { date: false } });

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

/**
 * Ask the terminal emulator to copy `text` to the system clipboard via the OSC 52 escape
 * sequence. This travels through the terminal protocol, so it also works over SSH and VS Code
 * Remote / devcontainer sessions with no display server. Terminal support cannot be probed:
 * an unsupported terminal silently ignores it.
 * @param {string} text - The text to copy.
 * @returns {boolean} Whether the sequence was written (not whether the copy succeeded).
 * @effects Writes an OSC 52 sequence to the current process stdout when it is a TTY.
 */
export const copyToClipboard = (text) => {
    if (!process.stdout.isTTY) return false;
    const base64 = Buffer.from(text, "utf8").toString("base64");
    process.stdout.write(`\x1b]52;c;${base64}\x07`);
    return true;
};

/**
 * Whether Inquirer reported an expected user cancellation.
 * @param {unknown} error - Caught prompt error.
 * @returns {boolean} Whether the error is the known SIGINT cancellation.
 */
export const isPromptCancellation = (error) => error instanceof Error && error.message.includes("User force closed the prompt with SIGINT");

/**
 * End an installer after an expected prompt cancellation.
 * Effects: writes no files; exits the current process with status 0. Unexpected errors rethrow.
 * @param {unknown} error - Caught error to handle.
 * @returns {never} Does not return for a prompt cancellation.
 * @throws {unknown} If error is not the known SIGINT cancellation.
 */
export const handleError = (error) => {
    if (!isPromptCancellation(error)) throw error;
    process.exit(0);
};
