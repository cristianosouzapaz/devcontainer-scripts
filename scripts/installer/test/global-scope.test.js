import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { installGlobal } from "../agents/index.js";
import { readAgentsLock, readJson, withTemporaryHome } from "./helpers.js";

test("installGlobal materializes the agents.global.json prompts into ~/.agents with Claude symlinks and a scoped lock", async () => {
    await withTemporaryHome(async (home) => {
        await installGlobal();

        const { prompts } = readJson("agents/agents.global.json");
        assert.ok(prompts.length > 0);
        for (const name of prompts) {
            assert.equal(existsSync(join(home, ".agents/skills", name, "SKILL.md")), true);

            const link = join(home, ".claude/skills", name);
            assert.equal(lstatSync(link).isSymbolicLink(), true);
            assert.equal(readlinkSync(link), join("..", "..", ".agents", "skills", name));
        }

        // Lock lives in ~/.agents, never in the bare home directory.
        assert.equal(existsSync(join(home, ".agents/template-lock.json")), true);
        assert.equal(existsSync(join(home, "template-lock.json")), false);

        const lock = readAgentsLock(home);
        const sample = lock.artifacts[`.agents/skills/${prompts[0]}/SKILL.md`];
        assert.equal(sample.kind, "prompt");
        assert.deepEqual(sample.adapters.claude, [{
            path: `.claude/skills/${prompts[0]}`,
            type: "symlink",
            target: `.agents/skills/${prompts[0]}`,
        }]);
        // Global scope never materializes a Copilot adapter.
        assert.equal(sample.adapters.copilot, undefined);
    });
});

test("installGlobal is idempotent — a second run leaves the tracked artifacts unchanged", async () => {
    await withTemporaryHome(async (home) => {
        await installGlobal();
        const first = readAgentsLock(home).artifacts;

        await installGlobal();
        assert.deepEqual(readAgentsLock(home).artifacts, first);
    });
});

test("agents.global.json only names instruction and prompt skills the installer actually ships", () => {
    const { instructions, prompts } = readJson("agents/agents.global.json");

    const instructionKeys = readJson("agents/instructions.json").map((entry) => entry.filename.replace(/\.instructions\.md$/, ""));
    const promptKeys = readJson("agents/prompts.json").map((entry) => entry.commandFilename.replace(/\.md$/, ""));

    for (const name of instructions) assert.ok(instructionKeys.includes(name), `instruction "${name}" is not in instructions.json`);
    for (const name of prompts) assert.ok(promptKeys.includes(name), `prompt "${name}" is not in prompts.json`);
});
