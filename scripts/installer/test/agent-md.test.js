import test from "node:test";
import assert from "node:assert/strict";
import { partitionReferencedSkills } from "../agent-md/index.js";
import { readJson } from "./helpers.js";

const blocks = [
    { key: "component-index", skills: ["index-components"] },
    { key: "base-ui" },
    { key: "documentation-sync", skills: ["documentation-sync"] },
    { key: "vscode-tasks", skills: ["vscode-tasks"] },
];

test("routes each referenced skill to install or skip by the machine-wide set", () => {
    const { toInstall, alreadyGlobal } = partitionReferencedSkills(blocks, new Map([["vscode-tasks", null]]));

    assert.deepEqual(toInstall, ["index-components", "documentation-sync"]);
    assert.deepEqual(alreadyGlobal, ["vscode-tasks"]);
});

test("an empty global set leaves every referenced skill to be installed", () => {
    const { toInstall, alreadyGlobal } = partitionReferencedSkills(blocks, new Map());

    assert.deepEqual(toInstall, ["index-components", "documentation-sync", "vscode-tasks"]);
    assert.deepEqual(alreadyGlobal, []);
});

test("skills referenced by more than one block are de-duplicated, first occurrence wins", () => {
    const { toInstall } = partitionReferencedSkills(
        [{ key: "a", skills: ["x", "y"] }, { key: "b", skills: ["y", "z"] }],
        new Map(),
    );

    assert.deepEqual(toInstall, ["x", "y", "z"]);
});

test("blocks with no skills array contribute nothing and never throw", () => {
    assert.deepEqual(partitionReferencedSkills([{ key: "base-ui" }], new Map()), { toInstall: [], alreadyGlobal: [] });
});

test("every skill any agent-md block references is a real local skill catalog key", () => {
    const catalogKeys = new Set(readJson("skills/local/skills.json").map((entry) => entry.key));
    const referenced = new Set(readJson("agent-md/agent-md.json").flatMap((entry) => entry.skills ?? []));

    for (const key of referenced) {
        assert.ok(catalogKeys.has(key), `agent-md block references "${key}", absent from skills/local/skills.json`);
    }
});
