import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYaml, serializeYaml } from "../../../lib/yaml.ts";

test("parses mappings, folded blocks, flow arrays, and integers", () => {
	const doc = parseYaml(`
feature: copy-block-actions
subphase: 2
phase: before
description: >
  The row shows no source label.
conditions:
  clock: 2026-11-14T10:00:00.000Z # pinned
  permissions: [clipboard-write]
steps:
  - fill: '[data-testid=search-field]'
    value: atomically
`);
	assert.equal(doc.feature, "copy-block-actions");
	assert.equal(doc.subphase, 2);
	assert.equal(doc.description, "The row shows no source label.");
	assert.equal(doc.conditions.clock, "2026-11-14T10:00:00.000Z");
	assert.deepEqual(doc.conditions.permissions, ["clipboard-write"]);
	assert.deepEqual(doc.steps, [{ fill: "[data-testid=search-field]", value: "atomically" }]);
});

test("parses a list of objects with nested lists (the ledger shape)", () => {
	const doc = parseYaml(`
ledger:
  validation_scripts:
    - just_test all
  features:
    - id: search-result-labels
      status: done
      goal: >
        Live search with readable result rows.
      acceptance_criteria:
        - The field searches as the reader types.
      files:
        in:
          - src/Search.tsx
        out:
          - src/Search.tsx
      commits:
        start: 6be88a3
        end: 7d02b8e
`);
	assert.deepEqual(doc.ledger.validation_scripts, ["just_test all"]);
	const item = doc.ledger.features[0];
	assert.equal(item.id, "search-result-labels");
	assert.equal(item.status, "done");
	assert.equal(item.goal, "Live search with readable result rows.");
	assert.deepEqual(item.acceptance_criteria, ["The field searches as the reader types."]);
	assert.deepEqual(item.files, { in: ["src/Search.tsx"], out: ["src/Search.tsx"] });
	assert.deepEqual(item.commits, { start: "6be88a3", end: "7d02b8e" });
});

test("round-trips: serialize then parse gives the same data", () => {
	const doc = parseYaml(`
ledger:
  description: >
    Three agent workflows for feature work: capture, test hooks, and the ledger.
  features:
    - id: copy-block-actions
      status: todo
      summary: >
        Line one of the summary.
        Line two of the summary.
      limitations:
        - Search is fixture-only; there is no real API search route.
`);
	const text = serializeYaml(doc);
	assert.deepEqual(parseYaml(text), doc);
});

test("values that need quoting survive the round trip", () => {
	const doc = { conditions: { base_url: "http://127.0.0.1:<port>", entry: "/agent", clock: "2026-11-14T10:00:00.000Z" } };
	assert.deepEqual(parseYaml(serializeYaml(doc)), doc);
});

test("a wrapped list item is joined back into one value", () => {
	const doc = parseYaml(`
acceptance_criteria:
  - The field searches as the reader types, matching the fixture rows exactly
    without waiting for the debounce timer to fire.
`);
	assert.deepEqual(doc.acceptance_criteria, [
		"The field searches as the reader types, matching the fixture rows exactly without waiting for the debounce timer to fire.",
	]);
});

test("empty flow arrays and empty flow maps parse and round-trip", () => {
	const doc = parseYaml(`
conditions: []
commits: {}
permissions: [clipboard-write]
`);
	assert.deepEqual(doc.conditions, []);
	assert.deepEqual(doc.commits, {});
	assert.deepEqual(doc.permissions, ["clipboard-write"]);
	assert.deepEqual(parseYaml(serializeYaml(doc)), doc);
});
