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

/** Configure consola to drop timestamps from installer output. */
export const setupConsola = () => {
    consola.options = { ...consola.options, formatOptions: { ...consola.options.formatOptions, date: false } };
};

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
        } catch { /* directory absent — contributes nothing */ }
    }

    try {
        const lock = JSON.parse(readFileSync(join(agentsRoot, "template-lock.json"), "utf8"));
        for (const [path, artifact] of Object.entries(lock?.artifacts ?? {})) {
            const match = /^\.agents\/skills\/(.+)\/SKILL\.md$/.exec(path);
            if (match) found.set(match[1], artifact?.version ?? null);
        }
    } catch { /* lock absent or invalid — directory listings still stand */ }

    return found;
};

/**
 * Ask the terminal emulator to copy `text` to the system clipboard via the OSC 52 escape
 * sequence. This travels through the terminal protocol, so it also works over SSH and VS Code
 * Remote / devcontainer sessions with no display server. Terminal support cannot be probed:
 * an unsupported terminal silently ignores it.
 * @param {string} text - The text to copy.
 * @returns {boolean} Whether the sequence was written (not whether the copy succeeded).
 */
export const copyToClipboard = (text) => {
    if (!process.stdout.isTTY) return false;
    const base64 = Buffer.from(text, "utf8").toString("base64");
    process.stdout.write(`\x1b]52;c;${base64}\x07`);
    return true;
};

/**
 * Handle a top-level installer error: exit 0 on SIGINT, otherwise log and exit 1.
 * @param {unknown} e - The caught error.
 */
export const handleError = (e) => {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("User force closed the prompt with SIGINT")) process.exit(0);
    consola.error(`An error occurred: ${message}`);
    process.exit(1);
};
