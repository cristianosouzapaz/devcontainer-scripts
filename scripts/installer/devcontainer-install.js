import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { select } from "@inquirer/prompts";
import { PROMPT_THEME } from "./lib/theme.js";
import { setupConsola } from "./lib/utils.js";

/**
 * @fileoverview The `devcontainer-install` dispatcher. It launches the installers as child
 * processes (never imports them) and offers an interactive menu over them. The image-side
 * Bash entry bootstraps the installer release once, then execs this file.
 */

const consola = setupConsola();
const here = dirname(fileURLToPath(import.meta.url));
const USAGE = "Usage: devcontainer-install {skills|configs|agents|agent-md|sync|interactive}";
const INSTALLERS = ["skills", "configs", "agents", "agent-md"];

export const MENU_CHOICES = [
    { name: "Skills", value: "skills" },
    { name: "Config templates", value: "configs" },
    { name: "Agent templates", value: "agents" },
    { name: "CLAUDE.md / AGENTS.md blocks", value: "agent-md" },
    { name: "Sync global agent assets", value: "sync" },
    { name: "Quit", value: "quit" },
];

/**
 * Prompt for which installer to run.
 * @param {unknown} _config
 * @param {Record<string, unknown>} [context]
 * @returns {Promise<string>} A MENU_CHOICES value.
 * @throws {Error} Rejects with `ExitPromptError` when the prompt is cancelled (Ctrl+C).
 */
export const selectInstallAction = (_config, context) => select({
    message: "Select what to install",
    choices: MENU_CHOICES,
    theme: PROMPT_THEME,
}, context);

/**
 * Run a command with inherited stdio. SIGINT is ignored in this process while the child runs,
 * so Ctrl+C reaches only the child and control returns here. Effects: spawns a child process
 * and installs a no-op SIGINT listener on `process` for the child's lifetime. A spawn error is
 * logged and resolves 127; it never rejects for string arguments.
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<number>} The exit code (128+signal when the child was killed by a signal).
 */
const runChild = (command, args) => new Promise((resolve) => {
    const ignore = () => {};
    process.on("SIGINT", ignore);
    const done = (code) => {
        process.off("SIGINT", ignore);
        resolve(code);
    };
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", (error) => {
        consola.error(error.message);
        done(127);
    });
    child.on("close", (code, signal) => done(signal ? 128 + (constants.signals[signal] ?? 0) : code ?? 1));
});

/**
 * Read the short release SHA from `<dir>/.release-proof`.
 * @param {string} dir - Directory holding the proof file.
 * @returns {string} The 7-char short SHA, or "unknown" when the file is missing or malformed.
 * @throws {Error} Rethrows any read error other than a missing file.
 */
const releaseSha = (dir) => {
    try {
        const match = readFileSync(join(dir, ".release-proof"), "utf8").split("\n")[0].match(/^release-sha ([0-9a-f]{40})$/);
        return match ? match[1].slice(0, 7) : "unknown";
    } catch (error) {
        if (error?.code === "ENOENT") return "unknown";
        throw error;
    }
};

/**
 * @typedef {object} Deps
 * @property {(command: string, args: string[]) => Promise<number>} [run] - Spawn seam; resolves to an exit code.
 * @property {boolean} [isTTY]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {() => Promise<string>} [menu] - Resolves to a MENU_CHOICES value.
 * @property {string} [dir] - Directory holding the installer folders.
 */

/**
 * Validate the argument, gate everything except `sync` on a TTY, and launch the chosen installer
 * or the sync script as a child process. Effects: child processes, stderr/stdout output, and
 * reading the release proof through `releaseSha`.
 * @param {string[]} argv - Arguments after the script name.
 * @param {Deps} [deps]
 * @returns {Promise<number>} A subcommand returns the child's exit code (127 on spawn
 * error, 128+signal on kill); 1 on bad usage, no TTY, or missing DEVCONTAINER_SYNC_SCRIPT;
 * interactive returns 0 on Quit/cancellation; menu errors log but loop continues.
 * @throws {Error} Rethrows any prompt error other than cancellation, and unrecognized proof-read errors.
 */
export const main = async (argv, deps = {}) => {
    const {
        run = runChild, isTTY = Boolean(process.stdin.isTTY), env = process.env,
        menu = selectInstallAction, dir = here,
    } = deps;
    const [command, ...extra] = argv;
    const known = [...INSTALLERS, "sync", "interactive"];
    if (!known.includes(command) || extra.length) {
        console.error(USAGE);
        return 1;
    }
    if (command !== "sync" && !isTTY) {
        console.error(`devcontainer-install ${command} needs an interactive terminal (stdin is not a TTY).`);
        return 1;
    }
    const launch = (name) => {
        if (name !== "sync") return run(process.execPath, [join(dir, name, "index.js")]);
        if (!env.DEVCONTAINER_SYNC_SCRIPT) {
            consola.error("DEVCONTAINER_SYNC_SCRIPT is not set; cannot run sync.");
            return 1;
        }
        return run("bash", [env.DEVCONTAINER_SYNC_SCRIPT]);
    };
    if (command !== "interactive") return launch(command);

    consola.log(`Installer release ${releaseSha(dir)} · ${env.SCRIPTS_REPO || "cristianosouzapaz/devcontainer-scripts"}@${env.SCRIPTS_REF || "main"}`);
    for (;;) {
        let choice;
        try {
            choice = await menu();
        } catch (error) {
            if (error?.name === "ExitPromptError") return 0;
            throw error;
        }
        if (choice === "quit") return 0;
        const code = await launch(choice);
        if (code !== 0 && code !== 130) consola.error(`${choice} exited with code ${code}`);
    }
};

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    process.exitCode = await main(process.argv.slice(2));
}
