import test from "node:test";
import assert from "node:assert/strict";
import { render } from "@inquirer/testing";
import { pickAssets } from "../shared/pick-assets.js";

const CHOICES = [
    { name: "Frontend Design", value: "frontend-design", annotation: "(installed)", group: "Design & Frontend" },
    { name: "Diagram Design", value: "diagram-design", group: "Design & Frontend" },
    { name: "Grill Me", value: "grill-me", group: "Planning", disabled: "installed globally" },
    { name: "Grill With Docs", value: "grill-with-docs", group: "Planning" },
];

test("shows annotations, global status and category separators", async () => {
    const { getScreen, answer, events } = await render(pickAssets, { message: "Select skills", choices: CHOICES, grouped: true });
    const screen = getScreen();
    events.keypress("enter");
    await answer;
    assert.match(screen, /── Design & Frontend ─/);
    assert.match(screen, /Frontend Design \(installed\)/);
    assert.match(screen, /Grill Me \(installed globally\)/);
});

test("space toggles the active official checkbox", async () => {
    const { answer, events } = await render(pickAssets, { message: "Select", choices: CHOICES, grouped: true });
    events.keypress("space");
    events.keypress("enter");
    assert.deepEqual(await answer, ["frontend-design"]);
});

test("keeps the picker header singular across selection redraws", async () => {
    const { getFullOutput, answer, events } = await render(pickAssets, { message: "Select", choices: CHOICES });
    events.keypress("space");
    events.keypress("down");
    events.keypress("space");
    const screen = await getFullOutput();
    events.keypress("enter");
    await answer;
    assert.equal((screen.match(/◆ Select/g) ?? []).length, 1);
});

test("keeps one visible frame while paging through a long skills list", async () => {
    const choices = Array.from({ length: 20 }, (_, index) => ({
        name: `Skill ${index + 1}`,
        value: `skill-${index + 1}`,
        group: "Skills",
    }));
    const { getFullOutput, answer, events } = await render(pickAssets, { message: "Select skills", choices, grouped: true, pageSize: 5 });
    Array.from({ length: 12 }).forEach(() => events.keypress("down"));
    const screen = await getFullOutput();
    events.keypress("enter");
    await answer;
    assert.equal((screen.match(/◆ Select skills/g) ?? []).length, 1);
    assert.match(screen, /Skill 13/);
});
