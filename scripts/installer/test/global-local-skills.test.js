import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { installGlobalLocalSkills } from "../skills/local/index.js";
import { readAgentsLock, readJson, withTemporaryHome } from "./helpers.js";

test("installGlobalLocalSkills materializes every skills.global.json key into ~/.agents with a Claude symlink and a scoped lock", async () => {
    await withTemporaryHome(async (home) => {
        await installGlobalLocalSkills();

        const keys = readJson("skills/local/skills.global.json");
        assert.ok(keys.length > 0);
        const lock = readAgentsLock(home);

        for (const key of keys) {
            assert.equal(existsSync(join(home, ".agents/skills", key, "SKILL.md")), true);

            const link = join(home, ".claude/skills", key);
            assert.equal(lstatSync(link).isSymbolicLink(), true);
            assert.equal(readlinkSync(link), join("..", "..", ".agents", "skills", key));

            const artifact = lock.artifacts[`.agents/skills/${key}/SKILL.md`];
            assert.equal(artifact.kind, "skill");
            assert.deepEqual(artifact.adapters.claude, [{
                path: `.claude/skills/${key}`,
                type: "symlink",
                target: `.agents/skills/${key}`,
            }]);
            assert.equal(artifact.adapters.copilot, undefined);
        }

        // Lock lives in ~/.agents, never in the bare home directory.
        assert.equal(existsSync(join(home, "template-lock.json")), false);
    });
});

test("installGlobalLocalSkills is idempotent — a second run leaves the tracked artifacts unchanged", async () => {
    await withTemporaryHome(async (home) => {
        await installGlobalLocalSkills();
        const first = readAgentsLock(home).artifacts;

        await installGlobalLocalSkills();
        assert.deepEqual(readAgentsLock(home).artifacts, first);
    });
});

test("skills/local/skills.global.json only names keys the local skills catalog ships", () => {
    const keys = readJson("skills/local/skills.global.json");
    const catalogKeys = readJson("skills/local/skills.json").map((entry) => entry.key);

    for (const key of keys) assert.ok(catalogKeys.includes(key), `global local skill "${key}" is not in skills/local/skills.json`);
});
