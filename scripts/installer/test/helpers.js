import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @fileoverview Shared fixtures for the installer's `node --test` suite.
 *
 * Not a test file itself (no `*.test.js` suffix), so `node --test test/*.test.js`
 * never picks it up as a suite.
 */

const installerDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Validate a relative path and resolve it inside the installer directory.
 * @param {unknown} relPath - Candidate path relative to the installer directory.
 * @returns {string} Absolute path inside the installer directory.
 * @throws {TypeError} If `relPath` is not a non-empty relative string or escapes the installer directory.
 */
const resolveInstallerPath = (relPath) => {
    if (typeof relPath !== "string" || relPath.length === 0 || isAbsolute(relPath)) {
        throw new TypeError("Expected a non-empty relative installer path.");
    }

    const target = resolve(installerDir, relPath);
    const relativeTarget = relative(installerDir, target);
    if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
        throw new TypeError("Expected a path inside the installer directory.");
    }

    return target;
};

/**
 * Validate a callback before a fixture invokes it.
 * @param {unknown} run - Candidate fixture callback.
 * @returns {(dir: string) => void | Promise<void>} The validated callback.
 * @throws {TypeError} If `run` is not a function.
 */
const validateCallback = (run) => {
    if (typeof run !== "function") throw new TypeError("Expected a fixture callback.");
    return run;
};

/**
 * Validate an absolute temporary-home directory path.
 * @param {unknown} home - Candidate temporary-home path.
 * @returns {string} The validated absolute path.
 * @throws {TypeError} If `home` is not an absolute, non-empty string.
 */
const validateTemporaryHome = (home) => {
    if (typeof home !== "string" || home.length === 0 || !isAbsolute(home)) {
        throw new TypeError("Expected an absolute temporary home path.");
    }

    return home;
};

/**
 * Restore a process-environment variable to its previous value.
 * @param {string} key - Name of the environment variable to restore.
 * @param {string | undefined} value - Previous value, or `undefined` when absent.
 * @returns {void}
 * @effects Sets or deletes `process.env[key]`; process assignment failures propagate.
 */
const restoreEnvironmentVariable = (key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
};

/**
 * Read and parse a JSON file resolved relative to the installer directory.
 * @param {string} relPath - Non-empty path to a JSON file inside the installer root.
 * @returns {*} Parsed JSON value.
 * @throws {TypeError} If `relPath` is invalid or escapes the installer root.
 * @throws {Error} If the target file cannot be read or its content is not valid JSON.
 * @effects Reads the resolved file inside the installer directory; does not modify files.
 */
export const readJson = (relPath) => JSON.parse(readFileSync(resolveInstallerPath(relPath), "utf8"));

/**
 * Read a UTF-8 text file resolved relative to the installer directory.
 * @param {string} relPath - Non-empty path to a file inside the installer root.
 * @returns {string} The file contents.
 * @throws {TypeError} If `relPath` is invalid or escapes the installer root.
 * @throws {Error} If the target file cannot be read.
 * @effects Reads the resolved file inside the installer directory; does not modify files.
 */
export const readText = (relPath) => readFileSync(resolveInstallerPath(relPath), "utf8");

/**
 * Read and parse the scoped `~/.agents/template-lock.json` written by a `--global` run.
 * @param {string} home - Absolute temporary home directory used for the run.
 * @returns {*} Parsed lock object.
 * @throws {TypeError} If `home` is not an absolute, non-empty string.
 * @throws {Error} If `<home>/.agents/template-lock.json` cannot be read or is not valid JSON.
 * @effects Reads `<home>/.agents/template-lock.json`; does not modify files.
 */
export const readAgentsLock = (home) => JSON.parse(readFileSync(join(validateTemporaryHome(home), ".agents", "template-lock.json"), "utf8"));

/**
 * Run a callback against a fresh `os.tmpdir()` directory, awaiting it (sync or async) and
 * deleting the directory afterwards.
 * @param {string} prefix - `mkdtempSync` name prefix.
 * @param {(dir: string) => void | Promise<void>} run - Callback invoked with the directory path.
 * @returns {Promise<void>}
 * @throws {TypeError} If `run` is not a function.
 * @throws {Error} If directory creation or cleanup fails, or if `run` throws or rejects.
 * @effects Creates a directory with the supplied prefix under `os.tmpdir()` and recursively removes that exact directory after `run` settles.
 */
const withTempDir = async (prefix, run) => {
    const callback = validateCallback(run);
    const dir = mkdtempSync(join(tmpdir(), prefix));
    try {
        await callback(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

/**
 * Run a callback with `HOME` and `CLAUDE_CONFIG_DIR` pointed at a throwaway directory,
 * restoring the previous environment afterwards.
 * @param {(home: string) => void | Promise<void>} run - Callback invoked with the temporary home path.
 * @returns {Promise<void>}
 * @throws {TypeError} If `run` is not a function.
 * @throws {Error} If fixture creation or cleanup fails, or if `run` throws or rejects.
 * @effects Creates then removes a `devcontainer-global-` directory under `os.tmpdir()`. Temporarily sets `process.env.HOME` and `process.env.CLAUDE_CONFIG_DIR` to paths in that directory and restores both original values on every exit.
 */
export const withTemporaryHome = (run) => {
    const callback = validateCallback(run);
    return withTempDir("devcontainer-global-", async (home) => {
        const prev = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
        try {
            process.env.HOME = home;
            process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
            await callback(home);
        } finally {
            try {
                restoreEnvironmentVariable("HOME", prev.HOME);
            } finally {
                restoreEnvironmentVariable("CLAUDE_CONFIG_DIR", prev.CLAUDE_CONFIG_DIR);
            }
        }
    });
};

/**
 * Run a callback against a freshly created temporary project root, deleting it afterwards.
 * @param {(root: string) => void | Promise<void>} run - Callback invoked with the temporary project path.
 * @returns {Promise<void>}
 * @throws {TypeError} If `run` is not a function.
 * @throws {Error} If fixture creation or cleanup fails, or if `run` throws or rejects.
 * @effects Creates then removes a `devcontainer-installer-` directory under `os.tmpdir()` after `run` settles.
 */
export const withTemporaryProject = (run) => withTempDir("devcontainer-installer-", validateCallback(run));
