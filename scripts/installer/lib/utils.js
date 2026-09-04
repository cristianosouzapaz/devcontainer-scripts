import consola from "consola";

/**
 * @fileoverview Process- and environment-level helpers that don't belong to a narrower
 * module: consola setup, clipboard/OSC-52, and the top-level error handler. The machine-wide
 * asset lookup is in `global-skill-set.js`, catalog loading in `catalog.js`, the lock file in
 * `lock-file.js`, file writing in `write-file.js`, and the selection prompts in `prompts.js` /
 * `pick-assets.js`.
 */

/**
 * Return a consola instance configured for installer output without changing the shared default.
 * @returns {typeof consola} A timestamp-free consola instance.
 */
export const setupConsola = () => consola.withDefaults({ formatOptions: { date: false } });

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
