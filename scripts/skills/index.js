import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import chalk from "chalk";
import consola from "consola";
import inquirer from "inquirer";

/**
 * @fileoverview Script to install VS Code Skills interactively or via config file.
 */

consola.options = { ...consola.options, formatOptions: { ...consola.options.formatOptions, date: false } };

// ─── Constants ───────────────────────────────────────────────────────────────

const SKILLS_FILE_URL = new URL("./skills.json", import.meta.url);
const AGENTS = {
    copilot: "github-copilot",
    claude: "claude-code",
};
const PROMPT_MESSAGE = "Select skills to INSTALL:";

// ─── Functions ───────────────────────────────────────────────────────────────

/**
 * Load and validate the skills catalog from the JSON file.
 * 
 * @returns An array of skill entries from the catalog.
 * @throws Will throw an error if the catalog is invalid or cannot be read.
 */
const loadSkillsCatalog = () => {
    const raw = readFileSync(SKILLS_FILE_URL, "utf8");
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) throw new Error("Invalid skills catalog: expected an array.");

    for (const [index, entry] of parsed.entries()) {
        const isValidEntry =
            typeof entry?.name === "string"
            && typeof entry?.skill === "string"
            && typeof entry?.url === "string"
            && Array.isArray(entry?.tags)
            && entry.tags.every((tag) => typeof tag === "string");

        if (!isValidEntry) throw new Error(`Invalid skills catalog entry at index ${index}.`);
    }

    return parsed;
}

/**
 * Convert an error to a string message.
 * 
 * @param error - The error to convert.
 * @returns A string message representing the error.
 */
const toErrorMessage = (error) => error instanceof Error ? error.message : String(error);

/**
 * Build a choice object for inquirer from a skill entry.
 * 
 * @param skillEntry - The skill entry to build the choice from.
 * @returns An object with `name` and `value` properties for inquirer.
 */
const buildSkillChoice = (skillEntry) => {
    const tagsStr = skillEntry.tags.map((tag) => chalk.bgWhite.black(` ${tag} `)).join(" ");
    return {
        name: `${skillEntry.name} ${tagsStr}`,
        value: skillEntry,
    };
}

/**
 * Install a skill for the specified agents.
 * 
 * @param url - The URL of the skill to install.
 * @param skill - The name of the skill to install.
 * @param agents - The agents to install the skill for.
 * @throws Will throw an error if the installation fails.
 */
const installSkillForAgents = (url, skill, agents) => {
    for (const agent of agents) {
        execFileSync("npx", ["skills", "add", url, "--skill", skill, "--agent", agent, "--yes"], {
            stdio: "pipe",
        });
    }
}

/**
 * Prompt the user to select skills to install.
 * @async
 */
const askUser = async () => {
    try {
        const skills = loadSkillsCatalog();

        const agentAnswer = await inquirer.prompt([{
            type: "confirm",
            name: "includeClaude",
            message: "Also install skills for Claude Code?",
            default: false,
        }]);

        const selectedAgents = agentAnswer.includeClaude
            ? [AGENTS.copilot, AGENTS.claude]
            : [AGENTS.copilot];

        const choices = skills.map(buildSkillChoice);

        const answer = await inquirer.prompt([
            {
                choices,
                message: PROMPT_MESSAGE,
                name: "selectedSkills",
                type: "checkbox",
            },
        ]);
        for (const { url, skill } of answer.selectedSkills) {
            consola.start(`Installing ${skill}`);
            try {
                installSkillForAgents(url, skill, selectedAgents);
                consola.success(`${skill} installed`);
            } catch (e) {
                consola.error(`Failed to install ${skill}: ${toErrorMessage(e)}`);
            }
        }
    } catch (e) {
        const message = toErrorMessage(e);
        if (message.includes("User force closed the prompt with SIGINT")) process.exit(0);
        else {
            consola.error(`An error occurred: ${message}`);
            process.exit(1);
        }
    }
}

await askUser();
