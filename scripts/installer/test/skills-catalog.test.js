import test from "node:test";
import assert from "node:assert/strict";
import { groupByCategory } from "../skills/catalog.js";

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
