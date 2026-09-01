import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { installInstructions, installPrompts } from "../agents/index.js";
import { TOOLS } from "../shared/constants.js";
import { readLockFile, reconcileArtifactAdapters, writeLockFile } from "../shared/lock-file.js";
import { readText, withTemporaryProject } from "./helpers.js";

test("records Claude and Copilot adapters for every generated agent artifact", async () => {
    await withTemporaryProject(async (root) => {
        const lock = readLockFile(root);
        const tools = new Set([TOOLS.claude, TOOLS.copilot]);

        const instructionResult = await installInstructions([{
            filename: "bash.instructions.md",
            version: "1.4.0",
            templateFile: "instructions/bash.instructions.md",
        }], root, tools, lock);
        const promptResult = await installPrompts([{
            filename: "generate-commit.prompt.md",
            commandFilename: "generate-commit.md",
            version: "1.2.0",
            templateFile: "prompts/generate-commit.prompt.md",
        }], root, tools, instructionResult.lock);
        writeLockFile(root, promptResult.lock);

        const persisted = JSON.parse(readFileSync(join(root, "template-lock.json"), "utf8"));
        assert.equal(persisted.version, "2");
        assert.equal(persisted.instructions, undefined);
        assert.equal(persisted.prompts, undefined);
        assert.equal(persisted.skills, undefined);
        assert.equal(persisted.agentLayout, undefined);
        assert.deepEqual(persisted.artifacts[".agents/skills/bash/SKILL.md"].adapters, {
            claude: [{
                path: ".claude/rules/bash.md",
                type: "symlink",
                target: ".agents/skills/bash/SKILL.md",
            }],
            copilot: [{ path: ".github/instructions/bash.instructions.md", type: "file" }],
        });
        assert.deepEqual(persisted.artifacts[".agents/skills/generate-commit/SKILL.md"].adapters, {
            claude: [{
                path: ".claude/skills/generate-commit",
                type: "symlink",
                target: ".agents/skills/generate-commit",
            }],
            copilot: [{ path: ".github/prompts/generate-commit.prompt.md", type: "file" }],
        });
        assert.equal(lstatSync(join(root, ".claude/rules/bash.md")).isSymbolicLink(), true);
        assert.equal(lstatSync(join(root, ".claude/skills/generate-commit")).isSymbolicLink(), true);

        unlinkSync(join(root, ".claude/skills/generate-commit"));
        const reconciled = reconcileArtifactAdapters(promptResult.lock, root, ".agents/skills/generate-commit/SKILL.md");
        assert.equal(reconciled.changed, true);
        assert.deepEqual(reconciled.lock.artifacts[".agents/skills/generate-commit/SKILL.md"].adapters, {
            copilot: [{ path: ".github/prompts/generate-commit.prompt.md", type: "file" }],
        });
    });
});

test("installs JavaScript Rules with its scoped glob in every adapter", async () => {
    await withTemporaryProject(async (root) => {
        const lock = readLockFile(root);

        await installInstructions([{
            filename: "javascript.instructions.md",
            version: "1.0.3",
            templateFile: "instructions/javascript.instructions.md",
        }], root, new Set([TOOLS.claude, TOOLS.copilot]), lock);

        const canonical = join(root, ".agents/skills/javascript/SKILL.md");
        const copilot = join(root, ".github/instructions/javascript.instructions.md");
        const claude = join(root, ".claude/rules/javascript.md");

        assert.equal(existsSync(canonical), true);
        assert.match(readFileSync(canonical, "utf8"), /^---\nname: javascript\n[\s\S]*paths:\n  - "\*\*\/\*\.\{js,mjs,cjs,jsx\}"\n---/);
        assert.equal(readFileSync(copilot, "utf8"), readText("agents/templates/instructions/javascript.instructions.md"));
        assert.equal(lstatSync(claude).isSymbolicLink(), true);
    });
});

test("does not create adapters for an unmanaged asset skipped during conflict resolution", async () => {
    await withTemporaryProject(async (root) => {
        const canonicalPath = ".agents/skills/bash/SKILL.md";
        const canonicalFile = join(root, canonicalPath);
        mkdirSync(join(root, ".agents/skills/bash"), { recursive: true });
        writeFileSync(canonicalFile, "unmanaged content\n");

        const lock = readLockFile(root);
        await installInstructions([{
            filename: "bash.instructions.md",
            version: "1.4.0",
            templateFile: "instructions/bash.instructions.md",
        }], root, new Set([TOOLS.claude, TOOLS.copilot]), lock, { writer: async () => false });

        assert.equal(lock.artifacts[canonicalPath], undefined);
        assert.equal(existsSync(join(root, ".claude/rules/bash.md")), false);
        assert.equal(existsSync(join(root, ".github/instructions/bash.instructions.md")), false);
    });
});
