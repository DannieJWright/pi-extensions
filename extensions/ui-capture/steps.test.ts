import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectDom } from "./dom.ts";
import { runSteps, type CaptureDriver, type ElementSnapshot } from "./steps.ts";
import type { Step } from "./spec.ts";

const b = (x: number, y: number, width: number, height = 10) => ({ x, y, width, height });
class FakeDriver implements CaptureDriver {
	clock = 0; calls: string[] = []; inspections: { selector: string; fields: string[] }[] = []; nodes: Record<string, ElementSnapshot[]> = {}; onPerform?: (verb: string) => unknown; onInspect?: (selector: string) => void;
	async perform(verb: any, target: unknown): Promise<unknown> { this.calls.push(`${verb}:${target}`); return this.onPerform?.(verb) ?? (verb === "eval" ? { answer: 42 } : undefined); }
	async inspect(selector: string, fields: string[]): Promise<ElementSnapshot[]> { this.inspections.push({ selector, fields }); this.onInspect?.(selector); return structuredClone(this.nodes[selector] ?? []); }
	async wait(ms: number) { this.clock += ms; }
	now() { return this.clock; }
}
const run = (driver: FakeDriver, ...steps: Step[]) => runSteps(driver, { steps });
test("DOM snapshot adapter records viewport boxes, attributes, computed and custom properties in document order", () => {
	const oldDocument = globalThis.document, oldStyle = globalThis.getComputedStyle;
	try {
		const node = (x: number) => ({ textContent: `item${x}`, getAttribute: (name: string) => name === "role" ? "tab" : null, getBoundingClientRect: () => b(x, 2, 20) });
		(globalThis as any).document = { querySelectorAll: () => [node(3), node(4)] };
		(globalThis as any).getComputedStyle = () => ({ paddingLeft: "2px", getPropertyValue: (key: string) => key === "--fit" ? "12px" : "" });
		assert.deepEqual(inspectDom({ selector: "tab", fields: ["box", "attribute:role", "computed:paddingLeft", "computed:--fit", "text"] }), [3, 4].map(x => ({ box: b(x, 2, 20), attributes: { role: "tab" }, computed: { paddingLeft: "2px", "--fit": "12px" }, text: `item${x}` })));
	} finally { (globalThis as any).document = oldDocument; (globalThis as any).getComputedStyle = oldStyle; }
});
test("new verbs and repeat capture results", async () => {
	const d = new FakeDriver(); d.nodes.tab = [{ box: b(0, 0, 10), attributes: { role: "tab" }, computed: { color: "red" }, text: "hello" }];
	const r = await run(d, { verb: "focus", target: "tab" }, { verb: "press", target: "Right", repeat: 3 }, { verb: "read", target: "tab", attribute: "role", name: "role" }, { verb: "measure", target: "tab", fields: ["box"], name: "tab" }, { verb: "eval", target: "x", name: "expr" });
	assert.equal(r.ok, true); assert.deepEqual(r.read, { role: "tab", expr: { answer: 42 } }); assert.deepEqual(r.measured.tab, d.nodes.tab[0]);
	assert.equal(d.calls.filter(x => x === "press:Right").length, 3);
});
test("measurement multiplicity, missing properties, exact equals and 0.5px geometry", async () => {
	const d = new FakeDriver(); d.nodes.items = [{ box: b(0, 10, 20), attributes: { n: "10", s: " 10" } }, { box: b(23, 10.5, 20) }];
	d.nodes.container = [{ box: b(0, 9.5, 43, 11) }];
	assert.equal((await run(d, { verb: "measure", target: "items", name: "m" })).ok, false);
	const pass = await run(d, { verb: "measure", target: "items", name: "m", each: true, fields: ["box"], derive: ["distinct_tops"] }, { verb: "assert", target: "items", same_top: true, inside: "container" });
	assert.equal(pass.ok, true); assert.deepEqual(pass.measured.m, d.nodes.items);
	d.nodes.single = [d.nodes.items[0]];
	assert.equal((await run(d, { verb: "assert", target: "single", attribute: "n", equals: 10 })).ok, true);
	const mismatch = await run(d, { verb: "assert", target: "single", attribute: "s", equals: "10" });
	assert.equal(mismatch.ok, false); assert.equal(mismatch.outcomes[0].actual, " 10"); assert.equal(mismatch.outcomes[0].expected, "10");
	assert.equal((await run(d, { verb: "read", target: "single", attribute: "missing", name: "m" })).ok, false);
	assert.equal((await run(d, { verb: "read", target: "absent", text: true, name: "m" })).ok, false);
	d.nodes.items[1].box!.y = 10.51;
	assert.equal((await run(d, { verb: "assert", target: "items", same_top: true })).ok, false);
	d.nodes.items[1].box!.y = 11.01;
	assert.equal((await run(d, { verb: "assert", target: "items", inside: "container" })).ok, false);
});
test("natural row uses rendered widths, selected controls, gap and padding", async () => {
	const d = new FakeDriver(); d.nodes.controls = [{ box: b(0, 0, 30) }, { box: b(33, 0, 40) }];
	d.nodes.row = [{ box: b(0, 0, 79.5), computed: { columnGap: "3px", columnCount: "auto", columnWidth: "auto", borderLeftWidth: "0px", borderRightWidth: "0px", paddingLeft: "3px", paddingRight: "4px" } }];
	const step: Step = { verb: "measure", target: "controls", each: true, fields: ["box"], derive: ["natural_row_width"], container: "row", name: "row" };
	const fit = await run(d, step);
	assert.equal(fit.ok, true);
	assert.deepEqual((fit.outcomes[0].result as any).checks.natural_row_width, { total: 80, width: 79.5, widths: [30, 40], gap: 3, padding: 7 });
	d.nodes.row[0].box!.width = 79.49;
	const failure = await run(d, step); assert.equal(failure.ok, false); assert.deepEqual((failure.outcomes[0].actual as any).total, 80);
	delete d.nodes.row[0].computed!.columnGap; assert.match((await run(d, step)).outcomes[0].error!, /missing or non-numeric/);
	assert.match((await run(d, { ...step, container: undefined })).outcomes[0].error!, /requires container/);
	d.nodes.row[0].computed!.columnGap = "3px";
	d.nodes.controls.push({ box: b(76, 0, 10) });
	d.nodes.row[0].box!.width = 93;
	const three = await run(d, step);
	assert.equal(three.ok, true);
	assert.deepEqual((three.outcomes[0].result as any).checks.natural_row_width, { total: 93, width: 93, widths: [30, 40, 10], gap: 3, padding: 7 });
});
const context = (gap: string) => ({ columnGap: gap, columnCount: "auto", columnWidth: "auto", borderLeftWidth: "0px", borderRightWidth: "0px", paddingLeft: "3px", paddingRight: "4px" });
test("flex and grid rows keep normal column gap at zero, including overflow and padding", async () => {
	const d = new FakeDriver(); d.nodes.controls = [{ box: b(0, 0, 30) }, { box: b(30, 0, 40) }];
	d.nodes.row = [{ box: b(0, 0, 76.5), computed: context("normal") }];
	const step: Step = { verb: "measure", target: "controls", each: true, derive: ["natural_row_width"], container: "row", name: "row" };
	const fit = await run(d, step);
	assert.equal(fit.ok, true);
	assert.deepEqual((fit.outcomes[0].result as any).checks.natural_row_width, { total: 77, width: 76.5, widths: [30, 40], gap: 0, padding: 7 });
	d.nodes.row[0].box!.width = 76.49;
	const overflow = await run(d, step);
	assert.equal(overflow.ok, false);
	assert.equal(overflow.outcomes[0].expected, "<= 76.99");
	assert.deepEqual(overflow.outcomes[0].actual, { total: 77, width: 76.49, widths: [30, 40], gap: 0, padding: 7 });
	// A single-column flow container has no columns, so a normal gap still contributes nothing.
	d.nodes.row[0].box!.width = 76.5;
	d.nodes.row[0].computed!.columnCount = "1";
	assert.equal(((await run(d, step)).outcomes[0].result as any).checks.natural_row_width.gap, 0);
});
test("percentage column gap resolves against the container content box", async () => {
	const d = new FakeDriver(); d.nodes.controls = [{ box: b(20, 0, 30) }, { box: b(70, 0, 40) }];
	// getComputedStyle reports percentages unresolved, so they resolve against the measured content box.
	const rowBox = (gap: string) => ({ ...context(gap), paddingLeft: "20px", paddingRight: "20px" });
	d.nodes.row = [{ box: b(0, 0, 240), computed: rowBox("10%") }];
	const step: Step = { verb: "measure", target: "controls", each: true, derive: ["natural_row_width"], container: "row", name: "row" };
	const fit = await run(d, step);
	assert.equal(fit.ok, true);
	assert.deepEqual((fit.outcomes[0].result as any).checks.natural_row_width, { total: 130, width: 240, widths: [30, 40], gap: 20, padding: 40 });
	// Padding and border shrink the content box a percentage resolves against.
	d.nodes.row[0].computed!.borderLeftWidth = "4px"; d.nodes.row[0].computed!.borderRightWidth = "4px";
	d.nodes.row[0].computed!.columnGap = "25%";
	assert.equal(((await run(d, step)).outcomes[0].result as any).checks.natural_row_width.gap, 48);
	// Overflow is reported with the resolved gap, not with an assumed zero.
	const narrow = new FakeDriver(); narrow.nodes.controls = d.nodes.controls; narrow.nodes.row = [{ box: b(0, 0, 100), computed: rowBox("10%") }];
	const overflow = await run(narrow, step);
	assert.equal(overflow.ok, false);
	assert.match(overflow.outcomes[0].error!, /natural_row_width failed/);
	assert.equal(overflow.outcomes[0].expected, "<= 100.5");
	assert.deepEqual(overflow.outcomes[0].actual, { total: 116, width: 100, widths: [30, 40], gap: 6, padding: 40 });
});
test("a multi-column normal gap fails instead of passing as zero", async () => {
	const d = new FakeDriver(); d.nodes.controls = [{ box: b(0, 0, 30) }, { box: b(46, 0, 40) }];
	const step: Step = { verb: "measure", target: "controls", each: true, derive: ["natural_row_width"], container: "row", name: "row" };
	for (const columns of [{ columnCount: "2", columnWidth: "auto" }, { columnCount: "auto", columnWidth: "100px" }]) {
		d.nodes.row = [{ box: b(0, 0, 200), computed: { ...context("normal"), ...columns } }];
		const result = await run(d, step);
		assert.equal(result.ok, false, JSON.stringify(columns));
		assert.match(result.outcomes[0].error!, /cannot establish the used value of normal column gap for a multi-column container/);
	}
	// A pixel-length gap on the same multi-column container is still resolvable.
	d.nodes.row[0].computed!.columnGap = "16px";
	assert.equal(((await run(d, step)).outcomes[0].result as any).checks.natural_row_width.gap, 16);
});
test("unresolvable gap values fail clearly instead of passing", async () => {
	const d = new FakeDriver(); d.nodes.controls = [{ box: b(0, 0, 30) }, { box: b(70, 0, 40) }];
	const step: Step = { verb: "measure", target: "controls", each: true, derive: ["natural_row_width"], container: "row", name: "row" };
	d.nodes.row = [{ box: b(0, 0, 240), computed: context("10%") }];
	// A percentage resolves against the content box, so its borders have to be present.
	delete d.nodes.row[0].computed!.borderRightWidth;
	assert.match((await run(d, step)).outcomes[0].error!, /missing or non-numeric computed property borderRightWidth/);
	d.nodes.row[0].computed!.borderRightWidth = "0px";
	d.nodes.row[0].box!.width = 7; // padding leaves no content box
	assert.match((await run(d, step)).outcomes[0].error!, /definite positive content width/);
	d.nodes.row[0].box!.width = 240;
	for (const invalid of ["-5%", "-3px"]) {
		d.nodes.row[0].computed!.columnGap = invalid;
		assert.match((await run(d, step)).outcomes[0].error!, /must not be negative/);
	}
	// Column values decide whether a normal gap can be established at all.
	d.nodes.row[0].computed!.columnGap = "normal";
	d.nodes.row[0].computed!.columnCount = "bad";
	assert.match((await run(d, step)).outcomes[0].error!, /cannot resolve computed property columnCount/);
	d.nodes.row[0].computed!.columnCount = "auto";
	d.nodes.row[0].computed!.columnWidth = "bad";
	assert.match((await run(d, step)).outcomes[0].error!, /cannot resolve computed property columnWidth/);
});
test("natural row reads the normal gap from a flex row DOM snapshot", async () => {
	const oldDocument = globalThis.document, oldStyle = globalThis.getComputedStyle;
	try {
		const control = (width: number) => ({ getBoundingClientRect: () => b(0, 0, width) });
		const row = { getBoundingClientRect: () => b(0, 0, 77) };
		(globalThis as any).document = { querySelectorAll: (selector: string) => selector === "controls" ? [control(30), control(40)] : [row] };
		(globalThis as any).getComputedStyle = () => ({ display: "flex", columnGap: "normal", columnCount: "auto", columnWidth: "auto", borderLeftWidth: "0px", borderRightWidth: "0px", paddingLeft: "3px", paddingRight: "4px" });
		const d = new FakeDriver();
		d.nodes.controls = inspectDom({ selector: "controls", fields: ["box"] });
		d.nodes.row = inspectDom({ selector: "row", fields: ["box", "computed:columnGap", "computed:columnCount", "computed:columnWidth", "computed:borderLeftWidth", "computed:borderRightWidth", "computed:paddingLeft", "computed:paddingRight"] });
		assert.equal(d.nodes.row[0].computed!.columnGap, "normal");
		const result = await run(d, { verb: "measure", target: "controls", each: true, derive: ["natural_row_width"], container: "row", name: "row" });
		assert.equal(result.ok, true);
		assert.equal((result.outcomes[0].result as any).checks.natural_row_width.total, 77);
	} finally { (globalThis as any).document = oldDocument; (globalThis as any).getComputedStyle = oldStyle; }
});
test("a real multi-column snapshot reports normal and cannot establish the used gap", async () => {
	const oldDocument = globalThis.document, oldStyle = globalThis.getComputedStyle;
	try {
		// Chromium keeps getComputedStyle at the computed value for a container that renders multiple columns.
		const control = (width: number) => ({ getBoundingClientRect: () => b(0, 0, width) }), row = { getBoundingClientRect: () => b(0, 0, 200) };
		(globalThis as any).document = { querySelectorAll: (selector: string) => selector === "controls" ? [control(92), control(92)] : [row] };
		(globalThis as any).getComputedStyle = () => ({ display: "block", columnGap: "normal", columnCount: "2", columnWidth: "auto", borderLeftWidth: "0px", borderRightWidth: "0px", paddingLeft: "10px", paddingRight: "10px" });
		const d = new FakeDriver();
		d.nodes.controls = inspectDom({ selector: "controls", fields: ["box"] });
		d.nodes.row = inspectDom({ selector: "row", fields: ["box", "computed:columnGap", "computed:columnCount", "computed:columnWidth", "computed:borderLeftWidth", "computed:borderRightWidth", "computed:paddingLeft", "computed:paddingRight"] });
		assert.equal(d.nodes.row[0].computed!.columnGap, "normal"); assert.equal(d.nodes.row[0].computed!.columnCount, "2");
		const result = await run(d, { verb: "measure", target: "controls", each: true, derive: ["natural_row_width"], container: "row", name: "row" });
		assert.equal(result.ok, false); assert.match(result.outcomes[0].error!, /cannot establish the used value of normal column gap/);
	} finally { (globalThis as any).document = oldDocument; (globalThis as any).getComputedStyle = oldStyle; }
});
test("natural row does not require column gap for a single item", async () => {
	const d = new FakeDriver(); d.nodes.controls = [{ box: b(0, 0, 30) }];
	d.nodes.row = [{ box: b(0, 0, 37), computed: { columnGap: "normal", paddingLeft: "3px", paddingRight: "4px" } }];
	const step: Step = { verb: "measure", target: "controls", derive: ["natural_row_width"], container: "row", name: "row" };
	for (const gap of ["normal", "bad", undefined]) {
		if (gap === undefined) delete d.nodes.row[0].computed!.columnGap;
		else d.nodes.row[0].computed!.columnGap = gap;
		const result = await run(d, step);
		assert.equal(result.ok, true, `gap ${gap}`);
		assert.deepEqual((result.outcomes[0].result as any).checks.natural_row_width, { total: 37, width: 37, widths: [30], gap: 0, padding: 7 });
		assert.equal(d.inspections.at(-1)!.fields.includes("computed:columnGap"), false);
	}
	d.nodes.row[0].box!.width = 36.49;
	assert.match((await run(d, step)).outcomes[0].error!, /natural_row_width failed/);
});
test("natural row rejects invalid or missing properties used by the calculation", async () => {
	const d = new FakeDriver(); d.nodes.controls = [{ box: b(0, 0, 30) }, { box: b(30, 0, 40) }];
	const computed: Record<string, string | null> = { columnGap: "3px", columnCount: "auto", columnWidth: "auto", borderLeftWidth: "0px", borderRightWidth: "0px", paddingLeft: "3px", paddingRight: "4px" };
	d.nodes.row = [{ box: b(0, 0, 100), computed }];
	const step: Step = { verb: "measure", target: "controls", each: true, derive: ["natural_row_width"], container: "row", name: "row" };
	for (const property of ["columnGap", "paddingLeft", "paddingRight"]) {
		const original = computed[property];
		for (const invalid of [null, "", "bad", "2em"]) {
			computed[property] = invalid;
			assert.match((await run(d, step)).outcomes[0].error!, new RegExp(`missing or non-numeric computed property ${property}`));
		}
		delete computed[property];
		assert.match((await run(d, step)).outcomes[0].error!, new RegExp(`missing or non-numeric computed property ${property}`));
		computed[property] = original;
	}
	d.nodes.controls.pop();
	delete computed.paddingLeft;
	assert.match((await run(d, step)).outcomes[0].error!, /missing or non-numeric computed property paddingLeft/);
	// With more than one control the properties that classify the gap are required as well.
	d.nodes.controls.push({ box: b(30, 0, 40) });
	// The column values are required when a normal gap has to be classified.
	computed.columnGap = "normal";
	for (const property of ["columnCount", "columnWidth"]) {
		const original = computed[property];
		delete computed[property];
		assert.match((await run(d, step)).outcomes[0].error!, new RegExp(`missing computed property ${property}`));
		computed[property] = original;
	}
});
test("until_stable reads before each press, uses fake 50ms clock, fails maximum and timeout", async () => {
	const d = new FakeDriver(); let n = 0; d.nodes.tab = [{ attributes: { n: "0" } }];
	d.onPerform = () => { n++; d.nodes.tab[0].attributes!.n = String(Math.min(n, 2)); };
	const step: Step = { verb: "press", target: "Right", until_stable: { target: "tab", attribute: "n", max: 4 } };
	const r = await run(d, step); assert.deepEqual(r.outcomes[0].result, { presses: 3, values: ["0", "1", "2", "2"] }); assert.equal(d.clock, 150);
	const change = new FakeDriver(); change.nodes.tab = [{ attributes: { n: "0" } }]; change.onPerform = () => { change.nodes.tab[0].attributes!.n += "1"; };
	assert.match((await run(change, { ...step, until_stable: { target: "tab", attribute: "n", max: 2 } })).outcomes[0].error!, /still changes/);
	const unstable = new FakeDriver(); unstable.nodes.tab = [{ attributes: { n: "0" } }]; unstable.onInspect = () => { unstable.nodes.tab[0].attributes!.n += "1"; };
	assert.match((await run(unstable, step)).outcomes[0].error!, /2 seconds/); assert.equal(unstable.clock, 2000);
});
test("navigation retries observation once but never duplicates an uncertain mutation without opt-in", async () => {
	const d = new FakeDriver(); let tries = 0; d.nodes.tab = [{ text: "ok" }]; d.onInspect = () => { if (!tries++) throw new Error("Execution context was destroyed"); };
	assert.equal((await run(d, { verb: "read", target: "tab", text: true, name: "r" })).ok, true); assert.equal(tries, 2);
	const m = new FakeDriver(); m.onPerform = () => { throw new Error("Execution context was destroyed by navigation"); };
	const failed = await run(m, { verb: "click", target: "tab" }); assert.match(failed.outcomes[0].error!, /uncertain outcome/); assert.equal(m.calls.length, 1);
	const opt = new FakeDriver(); let count = 0; opt.onPerform = () => { if (!count++) throw new Error("navigation"); };
	assert.equal((await run(opt, { verb: "click", target: "tab", replay: true })).ok, true); assert.equal(opt.calls.length, 2);
});

test("step error that embeds a credentialed URL is redacted in the outcome", async () => {
	const d = new FakeDriver(); d.onPerform = () => { throw new Error("page.goto: net::ERR_FAILED at http://user:p@ss@localhost:3000/x"); };
	const out = await run(d, { verb: "click", target: "#a" } as Step);
	assert.equal(out.ok, false);
	assert.equal(out.outcomes[0].error, "page.goto: net::ERR_FAILED at http://localhost:3000/x");
});
