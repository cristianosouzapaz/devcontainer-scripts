import test from "node:test";
import assert from "node:assert/strict";
import { formatSelectionSummary } from "../shared/prompts.js";

test("renders a section rule, titles with counts, and indented items", () => {
    const summary = formatSelectionSummary([
        { title: "Skills", items: ["Brainstorming", "Grill Me"] },
        { title: "Automatically included", items: ["grilling (required by Grill Me)"] },
    ]);

    assert.match(summary, /^── Selection ─+$/m);
    assert.match(summary, /^Skills · 2$/m);
    assert.match(summary, /^ {2}Brainstorming$/m);
    assert.match(summary, /^ {2}Grill Me$/m);
    assert.match(summary, /^Automatically included · 1$/m);
    assert.match(summary, /^ {2}grilling \(required by Grill Me\)$/m);
});

test("puts a blank line after the rule and between sections, with no trailing blank", () => {
    const summary = formatSelectionSummary([
        { title: "A", items: ["a1"] },
        { title: "B", items: ["b1"] },
    ]);
    const lines = summary.split("\n");

    assert.match(lines[0], /^── Selection /);
    assert.equal(lines[1].trim(), "");
    assert.equal(lines[2], "A · 1");
    assert.notEqual(lines.at(-1).trim(), "");
    assert.equal(lines.filter((line) => line.trim() === "").length, 2);
});

test("a note section still shows its title, count and items", () => {
    const summary = formatSelectionSummary([
        { title: "Skills", items: ["A"] },
        { title: "Already installed globally", items: ["X", "Y"], note: true },
    ]);

    assert.match(summary, /^Already installed globally · 2$/m);
    assert.match(summary, /^ {2}X$/m);
    assert.match(summary, /^ {2}Y$/m);
});

test("omits empty sections", () => {
    const summary = formatSelectionSummary([
        { title: "Config files", items: ["Biome"] },
        { title: "Required packages (run separately)", items: [], note: true },
    ]);

    assert.match(summary, /^Config files · 1$/m);
    assert.match(summary, /^ {2}Biome$/m);
    assert.doesNotMatch(summary, /Required packages/);
});
