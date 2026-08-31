import test from "node:test";
import assert from "node:assert/strict";
import { installGlobalSkills, loadGlobalSkillsManifest } from "../skills/index.js";
import { readJson, readText } from "./helpers.js";

test("loadGlobalSkillsManifest returns the validated third-party skill list", () => {
    const external = loadGlobalSkillsManifest();

    assert.ok(Array.isArray(external) && external.length > 0);
    for (const entry of external) {
        assert.equal(typeof entry.name, "string");
        assert.match(entry.url, /^https:\/\/github\.com\//);
        assert.ok(entry.skill === undefined || typeof entry.skill === "string");
    }
});

test("the global skills manifest agrees with the interactive catalog on shared sources", () => {
    const external = loadGlobalSkillsManifest();
    const catalogUrlByName = new Map(readJson("skills/skills.json").map((entry) => [entry.skill, entry.url]));

    for (const entry of external) {
        if (!catalogUrlByName.has(entry.name)) continue;
        assert.equal(entry.url, catalogUrlByName.get(entry.name), `external skill "${entry.name}" disagrees with skills.json on its source`);
    }
});

test("installGlobalSkills adds every manifest skill globally, then refreshes the store", () => {
    const calls = [];
    installGlobalSkills({ run: (args) => calls.push(args) });

    const external = loadGlobalSkillsManifest();
    const addCalls = calls.filter((args) => args[1] === "add");
    assert.equal(addCalls.length, external.length);
    external.forEach((entry, index) => {
        assert.deepEqual(addCalls[index], ["skills", "add", entry.url, "-g", "--yes", ...(entry.skill ? ["--skill", entry.skill] : [])]);
    });
    assert.deepEqual(calls.at(-1), ["skills", "update", "-g", "--yes"]);
});

test("installGlobalSkills tolerates a per-skill failure and a failed update", () => {
    const external = loadGlobalSkillsManifest();
    const attempted = [];
    const run = (args) => {
        attempted.push(args);
        if (args[1] === "add" && args[2] === external[0].url) throw new Error("network down");
        if (args[1] === "update") throw new Error("No global skills tracked");
    };

    assert.doesNotThrow(() => installGlobalSkills({ run }));
    // The failed first add did not abort the loop: every remaining skill was still attempted.
    assert.equal(attempted.filter((args) => args[1] === "add").length, external.length);
    assert.ok(attempted.some((args) => args[1] === "update"));
});

test("each installer references its global manifest, so the bootstrap graph walk fetches it", () => {
    // install.sh resolves `new URL("./x.json", import.meta.url)` references in the entry
    // scripts; these are what pull the per-installer global manifests into the download set.
    assert.match(readText("skills/index.js"), /new URL\("\.\/skills\.global\.json"/);
    assert.match(readText("agents/index.js"), /new URL\("\.\/agents\.global\.json"/);
    assert.match(readText("skills/local/index.js"), /new URL\("\.\/skills\.global\.json"/);
});
