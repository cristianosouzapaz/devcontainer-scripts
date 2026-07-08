import { execFileSync } from "node:child_process";
import consola from "consola";
import inquirer from "inquirer";
import { AGENTS, buildTagsStr, handleError, loadJsonCatalog, selectTargetTool, setupConsola, TOOLS } from "../shared/utils.js";

/**
 * @fileoverview Interactive installer for VS Code Skills.
 *
 * Installed at /opt/devcontainer/installer/skills/ inside the container.
 */

setupConsola();

// ─── Constants ───────────────────────────────────────────────────────────────

const SKILLS_FILE_URL = new URL("./skills.json", import.meta.url);
const PROMPT_MESSAGE = "Select skills to INSTALL:";

// ─── Functions ───────────────────────────────────────────────────────────────

/**
 * Load and validate the skills catalog from skills.json.
 * @returns {object[]} An array of skill entries.
 * @throws Will throw an error if the catalog is invalid or cannot be read.
 */
const loadSkillsCatalog = () => {
    const entries = loadJsonCatalog(SKILLS_FILE_URL);

    for (const [index, entry] of entries.entries()) {
        const isValidEntry =
            typeof entry?.name === "string"
            && typeof entry?.skill === "string"
            && typeof entry?.url === "string"
            && Array.isArray(entry?.tags)
            && entry.tags.every((tag) => typeof tag === "string")
            && (entry?.requires === undefined
                || (Array.isArray(entry.requires) && entry.requires.every((dep) => typeof dep === "string")));

        if (!isValidEntry) throw new Error(`Invalid skills catalog entry at index ${index}.`);
    }

    return entries;
};

/**
 * Install a skill for the specified agents.
 * @param {string} url - The URL of the skill repository.
 * @param {string} skill - The skill identifier.
 * @param {string[]} agents - Agent identifiers to install the skill for.
 * @throws Will throw an error if the installation fails.
 */
const installSkillForAgents = (url, skill, agents) => {
    for (const agent of agents) execFileSync("npx", ["skills", "add", url, "--skill", skill, "--agent", agent, "--yes"], {
            stdio: "pipe",
        });
};

/**
 * Prompt the user to select skills to install.
 * @async
 */
const askUser = async () => {
    try {
        const skills = loadSkillsCatalog();

        const choices = skills.map((entry) => ({
            name: `${entry.name} ${buildTagsStr(entry.tags)}`,
            value: entry,
        }));

        const { selectedSkills } = await inquirer.prompt([{
            choices,
            message: PROMPT_MESSAGE,
            name: "selectedSkills",
            type: "checkbox",
        }]);

        if (selectedSkills.length === 0) {
            consola.info("No skills selected.");
            return;
        }

        const selectedTool = await selectTargetTool();

        const agentsByTool = {
            [TOOLS.all]:     [AGENTS.copilot, AGENTS.claude],
            [TOOLS.copilot]: [AGENTS.copilot],
            [TOOLS.claude]:  [AGENTS.claude],
        };

        for (const { url, skill, requires = [] } of selectedSkills) {
            consola.start(`Installing ${skill}`);
            try {
                installSkillForAgents(url, skill, agentsByTool[selectedTool]);
                for (const dependency of requires) installSkillForAgents(url, dependency, agentsByTool[selectedTool]);
                consola.success(`${skill} installed`);
            } catch (e) {
                consola.error(`Failed to install ${skill}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    } catch (e) {
        handleError(e);
    }
};

await askUser();
