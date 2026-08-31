import test from "node:test";
import assert from "node:assert/strict";
import { buildSkillChoices, groupByCategory, readProjectSkillSet } from "../skills/catalog.js";
import { readText, withTemporaryProject } from "./helpers.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

test("groups known categories in the picker order and retains catalog order within each category", () => {
    const planningFirst = { name: "Plan first", category: "Planning & Workflow" };
    const planningSecond = { name: "Plan second", category: "Planning & Workflow" };
    const design = { name: "Design", category: "Design & Frontend" };

    const groups = groupByCategory([design, planningFirst, planningSecond]);

    assert.deepEqual([...groups.keys()], ["Planning & Workflow", "Design & Frontend"]);
    assert.deepEqual(groups.get("Planning & Workflow"), [planningFirst, planningSecond]);
});

test("places uncategorized additions after known categories in their first-seen order", () => {
    const experimental = { name: "Experimental", category: "Experimental" };
    const planning = { name: "Plan", category: "Planning & Workflow" };
    const platform = { name: "Platform", category: "Platform" };

    const groups = groupByCategory([experimental, planning, platform]);

    assert.deepEqual([...groups.keys()], ["Planning & Workflow", "Experimental", "Platform"]);
});

test("the skills picker imports the catalog helper, so the bootstrap graph walk fetches it", () => {
    // install.sh discovers files by resolving the entry scripts' imports; this reference
    // is what pulls skills/catalog.js into the download set.
    assert.match(readText("skills/index.js"), /from "\.\/catalog\.js"/);
});

test("marks project skills as installed without reading a version", () => withTemporaryProject((projectRoot) => {
    writeFileSync(join(projectRoot, "skills-lock.json"), JSON.stringify({
        version: 1,
        skills: { "diagram-design": { computedHash: "abc" } },
    }));

    const [global, installed] = buildSkillChoices([
        { name: "Diagram Design", skill: "diagram-design", category: "Design & Frontend", description: "", tags: [] },
        { name: "Global Skill", skill: "global-skill", category: "Planning & Workflow", description: "", tags: [] },
    ], new Map([["global-skill", null]]), readProjectSkillSet(projectRoot));

    assert.equal(installed.annotation, "(installed)");
    assert.equal(installed.disabled, false);
    assert.equal(global.annotation, undefined);
    assert.equal(global.disabled, "installed globally");
}));
