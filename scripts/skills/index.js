import { execSync } from "node:child_process";
import chalk from "chalk";
import consola from "consola";
import inquirer from "inquirer";

/**
 * @fileoverview Script to install VS Code Skills interactively or via config file.
 */

consola.options = { ...consola.options, formatOptions: { ...consola.options.formatOptions, date: false } };

/**
 * Predefined list of available skills to choose from.
 */
const SKILLS = [
    {
        name: "Agent Browser",
        skill: "agent-browser",
        tags: ["automation", "web"],
        url: "https://github.com/vercel-labs/agent-browser",
    },
    {
        name: "Better Auth Best Practices",
        skill: "better-auth-best-practices",
        tags: ["authentication", "security"],
        url: "https://github.com/better-auth/skills",
    },
    {
        name: "Find Skills",
        skill: "find-skills",
        tags: ["discovery", "tools"],
        url: "https://github.com/vercel-labs/skills",
    },
    {
        name: "Frontend Design",
        skill: "frontend-design",
        tags: ["design", "frontend"],
        url: "https://github.com/anthropics/skills",
    },
    {
        name: "Next.js App Router Patterns",
        skill: "nextjs-app-router-patterns",
        tags: ["nextjs", "routing"],
        url: "https://github.com/wshobson/agents",
    },
    {
        name: "Next.js Best Practices",
        skill: "next-best-practices",
        tags: ["nextjs", "best-practices"],
        url: "https://github.com/vercel-labs/next-skills",
    },
    {
        name: "Reducing Entropy",
        skill: "reducing-entropy",
        tags: ["code-quality", "refactoring"],
        url: "https://github.com/softaworks/agent-toolkit",
    },
    {
        name: "Skill Creator",
        skill: "skill-creator",
        tags: ["development", "tools"],
        url: "https://github.com/anthropics/skills",
    },
    {
        name: "Vercel Composition Patterns",
        skill: "vercel-composition-patterns",
        tags: ["vercel", "patterns"],
        url: "https://github.com/vercel-labs/agent-skills",
    },
    {
        name: "Vercel React Best Practices",
        skill: "vercel-react-best-practices",
        tags: ["vercel", "react", "best-practices"],
        url: "https://github.com/vercel-labs/agent-skills",
    },
    {
        name: "Web Design Guidelines",
        skill: "web-design-guidelines",
        tags: ["design", "web"],
        url: "https://github.com/vercel-labs/agent-skills",
    },
];
const AGENTS = {
    copilot: "github-copilot",
    claude: "claude-code",
};
const PROMPT_MESSAGE = "Select skills to INSTALL:";

/**
 * Prompt the user to select skills to install.
 * @async
 */
async function askUser() {
    try {
        const agentAnswer = await inquirer.prompt([{
            type: "confirm",
            name: "includeClaude",
            message: "Also install skills for Claude Code?",
            default: false,
        }]);

        const selectedAgents = agentAnswer.includeClaude
            ? [AGENTS.copilot, AGENTS.claude]
            : [AGENTS.copilot];

        const choices = SKILLS.map((s) => {
            const tagsStr = s.tags.map((tag) => chalk.bgWhite.black(` ${tag} `)).join(" ");
            return { name: `${s.name} ${tagsStr}`, value: s };
        });

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
                for (const agent of selectedAgents) {
                    execSync(`echo 'y' | npx skills add "${url}" --skill "${skill}" --agent ${agent} --yes`, {
                        stdio: "pipe",
                    });
                }
                consola.success(`${skill} installed`);
            } catch (e) {
                consola.error(`Failed to install ${skill}: ${e.message}`);
            }
        }
    } catch (e) {
        if (e.message?.includes("User force closed the prompt with SIGINT")) process.exit(0);
        else {
            consola.error(`An error occurred: ${e.message}`);
            process.exit(1);
        }
    }
}

await askUser();
