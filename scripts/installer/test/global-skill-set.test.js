import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { disableGlobalChoices, readGlobalSkillSet } from "../shared/utils.js";
import { withTemporaryHome } from "./helpers.js";

/**
 * Write a version-2 template lock file into `<home>/.agents/template-lock.json`.
 * @param {string} home - Temporary home directory containing the `.agents` folder.
 * @param {Record<string, object>} artifacts - Artifact map stored under the lock's `artifacts` key.
 * @returns {void}
 */
const writeLock = (home, artifacts) =>
    writeFileSync(join(home, ".agents", "template-lock.json"), JSON.stringify({ version: "2", artifacts }), "utf8");

test("returns an empty map when neither ~/.agents nor ~/.claude exists", () =>
    withTemporaryHome(() => {
        assert.equal(readGlobalSkillSet().size, 0);
    }));

test("reads first-party names and their recorded versions from ~/.agents/template-lock.json", () =>
    withTemporaryHome((home) => {
        mkdirSync(join(home, ".agents"), { recursive: true });
        writeLock(home, {
            ".agents/skills/create-pr/SKILL.md": { kind: "prompt", version: "1.4.0" },
            ".agents/skills/bash/SKILL.md": { kind: "instruction", version: "2.0.0" },
            "biome.json": { kind: "config", version: "9.9.9" },
        });

        const set = readGlobalSkillSet();
        assert.equal(set.get("create-pr"), "1.4.0");
        assert.equal(set.get("bash"), "2.0.0");
        // Non-skill artifact paths are ignored.
        assert.equal(set.has("biome.json"), false);
    }));

test("adds directory entries under ~/.agents/skills and ~/.claude/skills with a null version", () =>
    withTemporaryHome((home) => {
        mkdirSync(join(home, ".agents", "skills", "caveman"), { recursive: true });
        mkdirSync(join(home, ".claude", "skills"), { recursive: true });
        symlinkSync("../../.agents/skills/handoff", join(home, ".claude", "skills", "handoff"));

        const set = readGlobalSkillSet();
        assert.equal(set.has("caveman"), true);
        assert.equal(set.get("caveman"), null);
        // A symlinked global skill under ~/.claude/skills still counts.
        assert.equal(set.has("handoff"), true);
    }));

test("the lock version wins over a bare directory listing for the same name", () =>
    withTemporaryHome((home) => {
        mkdirSync(join(home, ".agents", "skills", "create-pr"), { recursive: true });
        writeLock(home, { ".agents/skills/create-pr/SKILL.md": { kind: "prompt", version: "1.4.0" } });

        assert.equal(readGlobalSkillSet().get("create-pr"), "1.4.0");
    }));

test("ignores dotfiles and plain files, and tolerates an unreadable lock file", () =>
    withTemporaryHome((home) => {
        mkdirSync(join(home, ".agents", "skills"), { recursive: true });
        writeFileSync(join(home, ".agents", "skills", "README.md"), "not a skill", "utf8");
        writeFileSync(join(home, ".agents", "skills", ".keep"), "", "utf8");
        writeFileSync(join(home, ".agents", "template-lock.json"), "{ not json", "utf8");

        const set = readGlobalSkillSet();
        assert.equal(set.has("README.md"), false);
        assert.equal(set.has(".keep"), false);
        assert.equal(set.size, 0);
    }));

test("disableGlobalChoices marks only the choices whose key is global, without mutating input", () => {
    const globalSet = new Map([["create-pr", "1.4.0"], ["caveman", null]]);
    const choices = [
        { name: "Create PR", value: { skill: "create-pr" } },
        { name: "Caveman", value: { skill: "caveman" } },
        { name: "Dataviz", value: { skill: "dataviz" } },
    ];

    const annotated = disableGlobalChoices(choices, (choice) => choice.value.skill, globalSet);

    assert.equal(annotated[0].disabled, "installed globally (v1.4.0)");
    assert.equal(annotated[1].disabled, "installed globally");
    assert.equal(annotated[2].disabled, undefined);
    // Input choices are untouched.
    assert.equal(choices[0].disabled, undefined);
});
