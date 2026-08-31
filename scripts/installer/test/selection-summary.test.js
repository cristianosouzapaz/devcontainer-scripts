import test from "node:test";
import assert from "node:assert/strict";
import { formatSelectionSummary } from "../shared/prompts.js";

test("formats a compact summary with counted sections", () => {
    const summary = formatSelectionSummary([
        { title: "Skills", items: ["Brainstorming", "Grill Me"] },
        { title: "Automatically included", items: ["grilling (required by Grill Me)"] },
    ]);

    assert.match(summary, /^┌─ Selection summary ─+┐$/m);
    assert.match(summary, /│ Skills \(2\).*│/);
    assert.match(summary, /│   • Brainstorming.*│/);
    assert.match(summary, /│   • Grill Me.*│/);
    assert.match(summary, /│ Automatically included \(1\).*│/);
    assert.match(summary, /│   • grilling \(required by Grill Me\).*│/);
    assert.match(summary, /└─+┘$/m);
    const lines = summary.split("\n");
    assert.equal(lines[0].length, lines[1].length);
    assert.equal(lines.at(-1).length, lines[1].length);
});

test("omits empty sections", () => {
    const summary = formatSelectionSummary([
        { title: "Config files", items: ["Biome"] },
        { title: "Required packages (run separately)", items: [] },
    ]);

    assert.match(summary, /│ Config files \(1\).*│/);
    assert.match(summary, /│   • Biome.*│/);
    assert.doesNotMatch(summary, /Required packages/);
});
