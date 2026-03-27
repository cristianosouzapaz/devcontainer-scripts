import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import consola from "consola";
import inquirer from "inquirer";

/**
 * @fileoverview Interactive installer for project config file templates.
 */

consola.options = { ...consola.options, formatOptions: { ...consola.options.formatOptions, date: false } };

const __dirname = dirname(fileURLToPath(import.meta.url));

// ----- CONFIG REGISTRY --------------------------------------------------------

/**
 * Predefined list of available config templates.
 * Each entry maps a display name and tags to a file in the templates/ directory.
 */
const CONFIGS = [
    {
        name: "Biome",
        filename: "biome.json",
        tags: ["linting", "formatting"],
        templateFile: "biome.json",
    },
    {
        name: "Git Ignore",
        filename: ".gitignore",
        tags: ["git"],
        templateFile: ".gitignore",
    },
    {
        name: "Git Attributes",
        filename: ".gitattributes",
        tags: ["git"],
        templateFile: ".gitattributes",
    },
    {
        name: "Lefthook",
        filename: "lefthook.yml",
        tags: ["git-hooks"],
        templateFile: "lefthook.yml",
    },
    {
        name: "TypeScript (base)",
        filename: "tsconfig.json",
        tags: ["typescript"],
        templateFile: "tsconfig.base.json",
    },
    {
        name: "TypeScript (Next.js)",
        filename: "tsconfig.json",
        tags: ["typescript", "nextjs"],
        templateFile: "tsconfig.nextjs.json",
    },
];

// ----- INSTALLER --------------------------------------------------------------

/**
 * Prompt the user to select config files to copy into the current directory.
 * Handles conflicts (overwrite / skip / backup and replace) per file.
 * @async
 */
async function askUser() {
    try {
        const choices = CONFIGS.map((c) => {
            const tagsStr = c.tags.map((tag) => chalk.bgWhite.black(` ${tag} `)).join(" ");
            return { name: `${c.name} ${tagsStr}`, value: c };
        });

        const answer = await inquirer.prompt([{
            choices,
            message: "Select config files to copy:",
            name: "selectedConfigs",
            type: "checkbox",
        }]);

        if (answer.selectedConfigs.length === 0) {
            consola.info("No files selected.");
            return;
        }

        const destDir = process.cwd();

        for (const config of answer.selectedConfigs) {
            const destPath = join(destDir, config.filename);
            const content = readFileSync(join(__dirname, "templates", config.templateFile), "utf8");

            if (existsSync(destPath)) {
                const { action } = await inquirer.prompt([{
                    type: "list",
                    name: "action",
                    message: `${config.filename} already exists. What do you want to do?`,
                    choices: ["overwrite", "skip", "backup and replace"],
                }]);

                if (action === "skip") {
                    consola.info(`Skipped ${config.filename}`);
                    continue;
                }

                if (action === "backup and replace") {
                    renameSync(destPath, `${destPath}.bak`);
                    consola.info(`Backed up existing ${config.filename} → ${config.filename}.bak`);
                }
            }

            writeFileSync(destPath, content, "utf8");
            consola.success(`${config.filename} written`);
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
