import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYaml, serializeYaml } from "../../lib/yaml.ts";

test("YAML retains booleans, numeric strings, floats, quotes and nested flow collections", () => {
	const input = `"a,b": { selector: 'button[data-label="a,b"]', nested: [[1, 2], { "x:y": [true, false] }], text: 'it''s good' }\nfloat: 1.5\nstring: '1.5'\n`;
	const parsed = parseYaml(input);
	assert.deepEqual(parsed, { "a,b": { selector: 'button[data-label="a,b"]', nested: [[1, 2], { "x:y": [true, false] }], text: "it's good" }, float: 1.5, string: "1.5" });
	assert.deepEqual(parseYaml(serializeYaml(parsed)), parsed);
});
test("plain scalar quotes do not hide comments or flow delimiters", () => {
	const doc = parseYaml(`
plain: Preserve the user's selection # comment
embedded: Say "hello" to the user's choice # another comment
comma: Keep, 'the user's selection # comment
bracket: Keep [the user's choice # comment
hash: user's#fragment # comment
list: [Preserve the user's selection, don't stop, 'it''s quoted, # yes', "escaped \\\"quote\\\", # yes", {note: user's choice, nested: ['a,b', "c:d"]}]
compact: {"key":["quoted, value", {"inner":"quoted: value"}]}
`);
	assert.deepEqual(doc, {
		plain: "Preserve the user's selection",
		embedded: 'Say "hello" to the user\'s choice',
		comma: "Keep, 'the user's selection",
		bracket: "Keep [the user's choice",
		hash: "user's#fragment",
		list: ["Preserve the user's selection", "don't stop", "it's quoted, # yes", 'escaped "quote", # yes', { note: "user's choice", nested: ["a,b", "c:d"] }],
		compact: { key: ["quoted, value", { inner: "quoted: value" }] },
	});
	assert.deepEqual(parseYaml(serializeYaml(doc)), doc);
});

test("quoted flow scalars still detect unterminated quotes", () => {
	assert.throws(() => parseYaml("value: ['unterminated, next]\n"), /bad flow collection/);
	assert.throws(() => parseYaml("value: [one], two]\n"), /bad flow collection/);
});

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

test("nested objects, scalar types, escaping, and whitespace round-trip exactly", () => {
	const doc = { ledger: { enabled: true, disabled: false, count: 0, text: "true", numeric: "123", padded: "  detail  ", findings: [
		{ details: "A 'quote', a \\ slash,\n\n  indented\n", rationale: "two  spaces\n", checks: ["1", "a, b", "'quoted'", "false"] },
		{ checks: ["one", "two"], details: "second" },
	] } };
	assert.deepEqual(parseYaml(serializeYaml(doc)), doc);
	assert.deepEqual(parseYaml("values: ['a, b', true, false, 0, '123', null]\n").values, ["a, b", true, false, 0, "123", null]);
	assert.equal(parseYaml("value: 'It''s a test'\n").value, "It's a test");
});

test("rejects duplicate keys and unconsumed nested content instead of discarding it", () => {
	assert.throws(() => parseYaml("review: true\nreview: false\n"), /duplicate key review/);
	assert.throws(() => parseYaml("review: true\n  ignored: value\n"), /bad line 2/);
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
test("YAML rejects __proto__ keys in block and flow maps", () => {
	assert.throws(() => parseYaml("__proto__: 1\n"), /__proto__/);
	assert.throws(() => parseYaml("a: { __proto__: 1 }\n"), /__proto__/);
	assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
