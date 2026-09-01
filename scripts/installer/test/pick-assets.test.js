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

test("space toggles the active choice; the list is alphabetical within each group", async () => {
    const { answer, events } = await render(pickAssets, { message: "Select", choices: CHOICES, grouped: true });
    events.keypress("space");
    events.keypress("enter");
    // "Diagram Design" sorts before "Frontend Design" in the first group.
    assert.deepEqual(await answer, ["diagram-design"]);
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

test("orders a flat list alphabetically regardless of caller order", async () => {
    const outOfOrder = [
        { name: "Zeta", value: "z", tags: ["t"] },
        { name: "alpha", value: "a", tags: ["t"] },
        { name: "Mike", value: "m", tags: ["t"] },
    ];
    const { getScreen, answer, events } = await render(pickAssets, { message: "Select", choices: outOfOrder });
    const screen = getScreen();
    events.keypress("enter");
    await answer;
    assert.ok(screen.indexOf("alpha") < screen.indexOf("Mike"));
    assert.ok(screen.indexOf("Mike") < screen.indexOf("Zeta"));
});

test("keeps groups in caller order but sorts entries alphabetically within them", async () => {
    const { getScreen, answer, events } = await render(pickAssets, { message: "Select", choices: CHOICES, grouped: true });
    const screen = getScreen();
    events.keypress("enter");
    await answer;
    assert.ok(screen.indexOf("Design & Frontend") < screen.indexOf("Planning"));
    assert.ok(screen.indexOf("Diagram Design") < screen.indexOf("Frontend Design"));
});

test("hides the tag bar when no choice carries tags", async () => {
    const { getScreen, answer, events } = await render(pickAssets, { message: "Select", choices: CHOICES });
    const screen = getScreen();
    events.keypress("enter");
    await answer;
    assert.doesNotMatch(screen, /filter by tag/);
    assert.doesNotMatch(screen, /\bAll\b/);
});

const TAGGED = [
    { name: "Biome", value: "biome", tags: ["formatting"] },
    { name: "Git Ignore", value: "gitignore", tags: ["git"] },
    { name: "Lefthook", value: "lefthook", tags: ["git"] },
    { name: "TypeScript", value: "tsconfig", tags: ["typescript"] },
];

test("shows an All chip plus every tag, sorted", async () => {
    const { getScreen, answer, events } = await render(pickAssets, { message: "Select config files", choices: TAGGED });
    const screen = getScreen();
    events.keypress("enter");
    await answer;
    assert.match(screen, /filter by tag/);
    assert.match(screen, /All .*formatting .*git .*typescript/s);
});

test("right arrow filters the list to the active tag", async () => {
    const { getScreen, answer, events } = await render(pickAssets, { message: "Select config files", choices: TAGGED });
    events.keypress("right"); // All -> formatting
    events.keypress("right"); // formatting -> git
    const screen = getScreen();
    events.keypress("enter");
    await answer;
    assert.match(screen, /Git Ignore/);
    assert.match(screen, /Lefthook/);
    assert.doesNotMatch(screen, /Biome/);
    assert.doesNotMatch(screen, /TypeScript/);
});

test("shows a match count for an active tag but not for All", async () => {
    const { getScreen, answer, events } = await render(pickAssets, { message: "Select config files", choices: TAGGED });
    assert.doesNotMatch(getScreen(), /· \d/);
    events.keypress("right"); // All -> formatting
    events.keypress("right"); // formatting -> git (2 entries)
    assert.match(getScreen(), /· 2/);
    events.keypress("enter");
    await answer;
});

test("keeps selections made under one tag after switching filters", async () => {
    const { answer, events } = await render(pickAssets, { message: "Select config files", choices: TAGGED });
    events.keypress("right"); // -> formatting
    events.keypress("space"); // check Biome
    events.keypress("left"); // back to All
    events.keypress("enter");
    assert.deepEqual(await answer, ["biome"]);
});

test("the select-all shortcut only toggles the filtered subset", async () => {
    const { answer, events } = await render(pickAssets, { message: "Select config files", choices: TAGGED });
    events.keypress("right"); // All -> formatting
    events.keypress("right"); // formatting -> git
    events.keypress("a"); // select every "git" entry
    events.keypress("enter");
    assert.deepEqual(await answer, ["gitignore", "lefthook"]);
});

const GROUPED_TAGGED = [
    { name: "A1", value: "a1", group: "Alpha", tags: ["x"] },
    { name: "A2", value: "a2", group: "Alpha", tags: ["y"] },
    { name: "B1", value: "b1", group: "Beta", tags: ["y"] },
];

test("drops category separators when the filtered view is one category", async () => {
    const { getScreen, answer, events } = await render(pickAssets, { message: "Select", choices: GROUPED_TAGGED, grouped: true });
    events.keypress("right"); // All -> x (only A1, in Alpha)
    const filtered = getScreen();
    events.keypress("right"); // x -> y (A2 in Alpha, B1 in Beta)
    const spanning = getScreen();
    events.keypress("enter");
    await answer;
    assert.doesNotMatch(filtered, /── Alpha ─/);
    assert.match(spanning, /── Alpha ─/);
    assert.match(spanning, /── Beta ─/);
});
