import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseSpec, runCli, runSpec, runSteps, STEP_VERBS } from "./capture.mjs";

const SPEC = `
feature: search-result-labels
subphase: 1
phase: after
description: >
  What the reader should see. Required. Example: result rows show the source label and a
  relative time, and the row the reader is on is marked.
conditions:
  base_url: http://127.0.0.1:<port>
  entry: /agent
  viewport: 1400x1000
  clock: 2026-11-14T10:00:00.000Z      # pinned; relative times are only reproducible with this
  locale: en
  theme: dark
  fixture: <fixture or seed name>
  permissions: [clipboard-write]
steps:
  - scroll_to: '[data-testid=transcript]'
  - wait_for: '[data-testid=search-results]'
  - fill: '[data-testid=search-field]'
    value: atomically
  - press: ArrowDown
  - assert: '[data-testid=search-results] li[data-current]'
  - screenshot: build/after.png
`;

function fakeDriver(log, { failAssert = false, url = "http://127.0.0.1:9000/agent" } = {}) {
	const driver = { url: () => url };
	for (const verb of STEP_VERBS) {
		driver[verb] = async (target, value) => {
			log.push([verb, target, value]);
			if (verb === "assert" && failAssert) throw new Error(`assert failed: ${target} is not rendered`);
			if (verb === "assert") return { matched: 1 };
			if (verb === "screenshot") { await mkdir(dirname(target), { recursive: true }); await writeFile(target, "png-bytes"); }
			return undefined;
		};
	}
	driver.close = async () => log.push(["close"]);
	return driver;
}

test("parseSpec reads the spec fields and normalizes steps", () => {
	const spec = parseSpec(SPEC);
	assert.equal(spec.feature, "search-result-labels");
	assert.equal(spec.subphase, 1);
	assert.equal(spec.phase, "after");
	assert.match(spec.description, /^What the reader should see\. Required\./);
	assert.equal(spec.conditions.viewport, "1400x1000");
	assert.equal(spec.conditions.clock, "2026-11-14T10:00:00.000Z");
	assert.deepEqual(spec.conditions.permissions, ["clipboard-write"]);
	assert.deepEqual(spec.steps.map((step) => step.verb), ["scroll_to", "wait_for", "fill", "press", "assert", "screenshot"]);
	assert.equal(spec.steps[2].value, "atomically");
	assert.equal(spec.steps[4].target, "[data-testid=search-results] li[data-current]");
});

test("parseSpec rejects a missing required field and an unknown verb", () => {
	assert.throws(() => parseSpec("feature: x\nsubphase: 1\nphase: after\nsteps:\n  - screenshot: build/a.png"), /missing description/);
	assert.throws(() => parseSpec("feature: x\nsubphase: 1\nphase: after\ndescription: d\nsteps:\n  - dance: x"), /expected one of/);
});

test("runSteps runs the steps in order", async () => {
	const dir = await mkdtemp(join(tmpdir(), "capture-steps-"));
	try {
		const spec = parseSpec(SPEC);
		spec.steps.at(-1).target = join(dir, "after.png");
		const log = [];
		const resolved = await runSteps(fakeDriver(log), spec);
		assert.deepEqual(log.map((entry) => entry[0]), ["scroll_to", "wait_for", "fill", "press", "assert", "screenshot"]);
		assert.equal(resolved[2].value, "atomically");
		assert.ok(resolved.every((entry) => entry.ok));
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("a failed assert stops the run", async () => {
	const spec = parseSpec(SPEC);
	const log = [];
	await assert.rejects(() => runSteps(fakeDriver(log, { failAssert: true }), spec), /assert failed: \[data-testid=search-results\] li\[data-current\] is not rendered/);
	// The screenshot after the failed assert was not attempted.
	assert.deepEqual(log.map((entry) => entry[0]), ["scroll_to", "wait_for", "fill", "press", "assert"]);
});

test("runSpec writes the png and the sidecar with conditions and resolved state", async () => {
	const dir = await mkdtemp(join(tmpdir(), "capture-sidecar-"));
	try {
		const spec = parseSpec(SPEC);
		spec.steps = [{ verb: "screenshot", target: join(dir, "after.png"), value: undefined }];
		const sidecar = await runSpec(spec, fakeDriver([]), { build: "abc1234", outDir: dir });
		assert.equal(sidecar.feature, "search-result-labels");
		assert.equal(sidecar.build, "abc1234");
		assert.equal(sidecar.conditions.clock, "2026-11-14T10:00:00.000Z");
		assert.ok(sidecar.steps[0].ok);
		assert.equal(sidecar.resolved.url, "http://127.0.0.1:9000/agent");
		const written = JSON.parse(await readFile(join(dir, "sidecar.json"), "utf8"));
		assert.deepEqual(written, sidecar);
		assert.equal(await readFile(join(dir, "after.png"), "utf8"), "png-bytes");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("runCli exits nonzero on a failed assert and zero on a clean run", async () => {
	const dir = await mkdtemp(join(tmpdir(), "capture-cli-"));
	try {
		const specPath = join(dir, "capture.yaml");
		await writeFile(specPath, SPEC.replace("build/after.png", join(dir, "after.png")));
		const failCode = await runCli([specPath], () => fakeDriver([], { failAssert: true }));
		assert.equal(failCode, 1);
		const okCode = await runCli([specPath, "--build", "deadbeef"], () => fakeDriver([]));
		assert.equal(okCode, 0);
		const sidecar = JSON.parse(await readFile(join(dir, "sidecar.json"), "utf8"));
		assert.equal(sidecar.build, "deadbeef");
		assert.equal(await runCli([]), 2);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
