import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @fileoverview Shared fixtures for the installer's `node --test` suite.
 *
 * Not a test file itself (no `*.test.js` suffix), so `node --test test/*.test.js`
 * never picks it up as a suite.
 */

const installerDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Read and parse a JSON file resolved relative to the installer directory.
 * @param {string} relPath - Path to the JSON file, relative to the installer root.
 * @returns {*} The parsed JSON value.
 */
export const readJson = (relPath) => JSON.parse(readFileSync(join(installerDir, relPath), "utf8"));

/**
 * Read a UTF-8 text file resolved relative to the installer directory.
 * @param {string} relPath - Path to the file, relative to the installer root.
 * @returns {string} The file contents.
 */
export const readText = (relPath) => readFileSync(join(installerDir, relPath), "utf8");

/**
 * Read and parse the scoped `~/.agents/template-lock.json` written by a `--global` run.
 * @param {string} home - Temporary home directory used for the run.
 * @returns {*} The parsed lock object.
 */
export const readAgentsLock = (home) => JSON.parse(readFileSync(join(home, ".agents", "template-lock.json"), "utf8"));

/**
 * Run a callback against a fresh `os.tmpdir()` directory, awaiting it (sync or async) and
 * deleting the directory afterwards.
 * @param {string} prefix - `mkdtempSync` name prefix.
 * @param {(dir: string) => void | Promise<void>} run - Callback invoked with the directory path.
 * @returns {Promise<void>}
 */
const withTempDir = async (prefix, run) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    try {
        await run(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

/**
 * Run a callback with `HOME` and `CLAUDE_CONFIG_DIR` pointed at a throwaway directory,
 * restoring the previous environment afterwards.
 * @param {(home: string) => void | Promise<void>} run - Callback invoked with the temporary home path.
 * @returns {Promise<void>}
 */
export const withTemporaryHome = (run) => withTempDir("devcontainer-global-", async (home) => {
    const prev = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    try {
        await run(home);
    } finally {
        for (const [key, value] of Object.entries(prev)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

/**
 * Run a callback against a freshly created temporary project root, deleting it afterwards.
 * @param {(root: string) => void | Promise<void>} run - Callback invoked with the temporary project path.
 * @returns {Promise<void>}
 */
export const withTemporaryProject = (run) => withTempDir("devcontainer-installer-", run);
