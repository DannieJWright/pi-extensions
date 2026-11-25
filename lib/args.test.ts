import test from "node:test";
import assert from "node:assert/strict";
import { normalizeJsonEncoded, preview, wrapperSchema } from "./args.ts";

// Pure module: no files, HOME or ledger paths are touched; the guard's isolated environment is left in place.
const findingSchema = { type: "object", properties: { details: { type: "string" }, required_checks: { type: "array", items: { type: "string" } } }, required: ["details"] };
const schema = {
	type: "object",
	properties: {
		action: { type: "string" },
		note: { type: "string" },
		limitations: { type: "array", items: { type: "string" } },
		new_findings: { type: "array", items: findingSchema },
		options: { type: "object", properties: { tail: { type: "number" } } },
	},
};
const branched = {
	anyOf: [
		{ type: "object", properties: { action: { const: "a" }, list: { type: "array", items: { type: "string" } } } },
		{ type: "object", properties: { action: { const: "b" }, list: { type: "array", items: { type: "number" } }, text: { type: "string" } } },
	],
};

test("decodes JSON text only at properties the schema declares array or object", () => {
	const out = normalizeJsonEncoded(schema, { limitations: '["x","y"]', options: ' {"tail":3}', unknown: "[1]" }) as any;
	assert.deepEqual(out, { limitations: ["x", "y"], options: { tail: 3 }, unknown: "[1]" });
});

test("anyOf branch is chosen by the action const, else every branch is a candidate", () => {
	assert.deepEqual(normalizeJsonEncoded(branched, { action: "a", list: '["1"]' }), { action: "a", list: ["1"] });
	assert.deepEqual(normalizeJsonEncoded(branched, { action: "b", list: "[1]" }), { action: "b", list: [1] });
	assert.deepEqual(normalizeJsonEncoded(branched, { action: "zzz", list: '["q"]' }), { action: "zzz", list: ["q"] });
});

test("nested item schemas are normalized, including required_checks inside a finding", () => {
	const out = normalizeJsonEncoded(schema, { new_findings: [{ details: "d", required_checks: '["c1","c2"]' }] }) as any;
	assert.deepEqual(out.new_findings, [{ details: "d", required_checks: ["c1", "c2"] }]);
	const whole = normalizeJsonEncoded(schema, { new_findings: '[{"details":"d","required_checks":"[\\"c\\"]"}]' }) as any;
	assert.deepEqual(whole.new_findings, [{ details: "d", required_checks: ["c"] }]);
});

test("unparseable text, oversized text and unbracketed text are left alone", () => {
	for (const text of ["[oops", "a, b", "{bad}", `["${"x".repeat(9000)}"]`]) {
		const args = { limitations: text };
		assert.equal(normalizeJsonEncoded(schema, args), args);
	}
});

test("a decode the property schema rejects is left alone", () => {
	const args = { new_findings: "[1]" };
	assert.equal(normalizeJsonEncoded(schema, args), args);
	assert.deepEqual(normalizeJsonEncoded(schema, { options: "[1]" }), { options: "[1]" });
});

test("string fields are never parsed", () => {
	const args = { note: '["looks like json"]' };
	assert.equal(normalizeJsonEncoded(schema, args), args);
	const out = normalizeJsonEncoded(branched, { action: "b", text: '{"a":1}' }) as any;
	assert.equal(out.text, '{"a":1}');
});

test('"[1]" for an array-of-strings property becomes ["1"]', () => {
	assert.deepEqual(normalizeJsonEncoded(schema, { limitations: "[1]" }), { limitations: ["1"] });
});

test("input is not mutated and only changed paths are copied", () => {
	const nested = { details: "d" }, args = { limitations: '["x"]', new_findings: [nested], note: "n" };
	const frozen = structuredClone(args);
	const out = normalizeJsonEncoded(schema, args) as any;
	assert.deepEqual(args, frozen);
	assert.notEqual(out, args);
	assert.equal(out.new_findings, args.new_findings);
	assert.equal(out.new_findings[0], nested);
});

test("returns the same object when nothing applies and non-object args unchanged", () => {
	const args = { limitations: ["x"], new_findings: [{ details: "d", required_checks: ["c"] }], note: "n" };
	assert.equal(normalizeJsonEncoded(schema, args), args);
	const list: unknown[] = [], text = "[1]";
	assert.equal(normalizeJsonEncoded(schema, null), null);
	assert.equal(normalizeJsonEncoded(schema, list), list);
	assert.equal(normalizeJsonEncoded(schema, text), text);
	assert.equal(normalizeJsonEncoded(undefined, args), args);
});

test("depth limit stops the walk without throwing", () => {
	let deep: any = { type: "string" }, value: any = "x";
	for (let i = 0; i < 12; i++) { deep = { type: "object", properties: { a: deep } }; value = { a: value }; }
	assert.equal(normalizeJsonEncoded(deep, value), value);
});

test("wrapper schemas are built once per property schema, not per call", () => {
	const property = schema.properties.limitations;
	const first = wrapperSchema(property);
	normalizeJsonEncoded(schema, { limitations: '["x"]' });
	normalizeJsonEncoded(schema, { limitations: '["y"]' });
	assert.equal(wrapperSchema(property), first);
});

test("preview shortens long text", () => {
	assert.equal(preview("abc", 5), "abc");
	assert.equal(preview("abcdefgh", 5), "abcde…");
	assert.equal(preview(["a"]), '["a"]');
});
