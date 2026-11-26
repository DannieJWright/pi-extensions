import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm, symlink, readFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parseSpec } from "./spec.ts";
import { artifactDirectory, checkPair, conditionsMatch, ignoredOutputWarning, savePhase, type Sidecar } from "./sidecar.ts";
import type { StepsResult } from "./steps.ts";

const text = `feature: demo\nsubphase: 1\ndescription: test\nserver:\n  start: just run --port {port}\nconditions:\n  entry: /\nsteps:\n  - measure: tab\n    name: row\n    fields: [box]\n  - screenshot: {name: full}\n`;
const spec = parseSpec(text);
const answers = { visible: true, conditions_match: true, only_difference_is_the_feature: true, same_target: true, preserved: ["label"], measurements: ["phases.after.measured.row"], note: "ok" };
const result = (x: number): StepsResult => ({ ok: true, outcomes: spec.steps.map(step => ({ step, ok: true, result: x })), measured: { row: { box: { x, y: 0, width: 10, height: 10 } } }, read: {} });
async function fixture(fn: (dir: string) => Promise<void>) { const dir = await mkdtemp(join(tmpdir(), "capture-test-")); try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } }
async function phase(dir: string, name: "before" | "after", value: number, specText = text) {
	await writeFile(join(dir, `${name}-full.png`), `${name}-${value}`);
	return savePhase({ dir, specText, phase: name, result: result(value), imageNames: [`${name}-full.png`], build: "abc dirty", url: `http://localhost:${value}` });
}
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
// A recorded pair must match what a completed run wrote: the mask bytes on disk and the current phase evidence ids.
async function recordDiff(dir: string, sidecar: Sidecar, data = "mask") {
	const name = "diff-full.png";
	await writeFile(join(dir, name), data);
	sidecar.diff = { conditions_match: true, screenshot: "full", mask: name, sha256: sha256(data), regions: {}, evidence: { before: sidecar.phases.before!.evidence_id, after: sidecar.phases.after!.evidence_id } };
	await writeFile(join(dir, "sidecar.json"), JSON.stringify(sidecar));
	return sidecar;
}
test("phase merge uses unexpanded input identity not runtime outcomes or ports; checks and force", async () => fixture(async dir => {
	await phase(dir, "before", 100); const merged = await phase(dir, "after", 200);
	assert.equal(conditionsMatch(merged.phases.before!, merged.phases.after!), true);
	assert.notDeepEqual(merged.phases.before!.outcomes, merged.phases.after!.outcomes);
	assert.equal(await readFile(join(dir, "capture.yaml"), "utf8"), text);
	await recordDiff(dir, merged);
	const checked = await checkPair(dir, text, answers); assert.equal(checked.pair_check?.evidence.after, merged.phases.after?.evidence_id);
	await assert.rejects(checkPair(dir, text, answers), /already exists/);
	await checkPair(dir, text, { ...answers, note: "replaced" }, true);
	await assert.rejects(checkPair(dir, text, { ...answers, extra: true }, true), /schema/);
	await assert.rejects(checkPair(dir, text, { ...answers, visible: "true" }, true), /boolean/);
	await assert.rejects(checkPair(dir, text, { ...answers, measurements: ["phases.after.measured.unknown"] }, true), /unknown measurement/);
	const stored = JSON.parse(await readFile(join(dir, "sidecar.json"), "utf8")); stored.diff = { old: true };
	await writeFile(join(dir, "sidecar.json"), JSON.stringify(stored));
	// An existing sidecar whose diff has no verifiable mask metadata fails closed instead of approving it.
	await assert.rejects(checkPair(dir, text, answers, true), /saved diff has no mask path/);
	const rerun = await phase(dir, "after", 300); assert.equal(rerun.pair_check, undefined); assert.equal(rerun.diff, undefined);
	await recordDiff(dir, rerun);
	await checkPair(dir, text, answers);
	const failed = { ...result(4), ok: false, outcomes: [{ step: spec.steps[0], ok: false, error: "missing selector" }] };
	const replaced = await savePhase({ dir, specText: text, phase: "before", result: failed, imageNames: [], build: "x", url: "x" });
	assert.equal(replaced.pair_check, undefined); assert.equal(replaced.phases.after?.status, "success");
}));
test("failure, incomplete, changed spec and stale images reject pair checks", async () => fixture(async dir => {
	await phase(dir, "before", 1); await phase(dir, "after", 2);
	await assert.rejects(checkPair(dir, text.replace("description: test", "description: changed"), answers), /spec/);
	await writeFile(join(dir, "after-full.png"), "tampered");
	await assert.rejects(checkPair(dir, text, answers), /stale image/);
	const failed = { ...result(4), ok: false, outcomes: [{ step: spec.steps[0], ok: false, error: "missing selector" }] };
	const sidecar = await savePhase({ dir, specText: text, phase: "after", result: failed, imageNames: [], build: "x", url: "x" });
	assert.equal(sidecar.phases.after?.outcomes[0].error, "missing selector");
	assert.equal(sidecar.phases.after?.status, "failed");
	await assert.rejects(checkPair(dir, text, answers), /two successful complete/);
	await savePhase({ dir, specText: text, phase: "after", result: { ...result(1), outcomes: [] }, imageNames: [], build: "x", url: "x" });
	await assert.rejects(checkPair(dir, text, answers), /two successful complete/);
}));
test("pair approval verifies the recorded diff mask against the files and rejects missing, deleted, replaced, or stale records", async () => fixture(async dir => {
	await phase(dir, "before", 1); const merged = await phase(dir, "after", 2);
	// Nothing was compared for this pair, so the answers cannot be accepted.
	await assert.rejects(checkPair(dir, text, answers), /pair requires a saved diff/);
	await recordDiff(dir, merged);
	const approved = await checkPair(dir, text, answers);
	assert.equal(approved.pair_check!.evidence.after, merged.phases.after!.evidence_id);
	// Forced replacement verifies the same evidence before it replaces an answer.
	await checkPair(dir, text, { ...answers, note: "forced" }, true);
	await rm(join(dir, "diff-full.png"));
	await assert.rejects(checkPair(dir, text, answers, true), /missing diff mask: diff-full\.png/);
	await writeFile(join(dir, "diff-full.png"), "replaced");
	await assert.rejects(checkPair(dir, text, answers, true), /stale diff mask: diff-full\.png/);
	const stored = JSON.parse(await readFile(join(dir, "sidecar.json"), "utf8"));
	stored.diff.evidence.after = "different evidence";
	await writeFile(join(dir, "sidecar.json"), JSON.stringify(stored));
	await assert.rejects(checkPair(dir, text, answers, true), /belongs to different evidence/);
	delete stored.diff.sha256; stored.diff.mask = "../other.png";
	await writeFile(join(dir, "sidecar.json"), JSON.stringify(stored));
	await assert.rejects(checkPair(dir, text, answers, true), /has no content hash/);
	// Re-running either phase invalidates the previous diff and approval; a valid new record can be approved.
	const rerun = await phase(dir, "before", 3);
	assert.equal(rerun.diff, undefined); assert.equal(rerun.pair_check, undefined);
	await assert.rejects(checkPair(dir, text, answers, true), /pair requires a saved diff/);
	await recordDiff(dir, rerun);
	await checkPair(dir, text, answers);
}));
test("pair check publishes safely if the sidecar is replaced after validation", async () => fixture(async dir => {
	await phase(dir, "before", 1);
	// The recorded diff has to be verifiable, so write its mask as a completed run would.
	await recordDiff(dir, await phase(dir, "after", 2));
	const sentinel = join(dir, "sentinel"); await writeFile(sentinel, "untouched");
	let reads = 0;
	const raced = { ...answers, get measurements() {
		if (++reads === 3) { unlinkSync(join(dir, "sidecar.json")); symlinkSync(sentinel, join(dir, "sidecar.json")); }
		return answers.measurements;
	} };
	await checkPair(dir, text, raced);
	assert.ok(reads >= 3);
	assert.equal(await readFile(sentinel, "utf8"), "untouched");
	assert.equal(JSON.parse(await readFile(join(dir, "sidecar.json"), "utf8")).pair_check.note, "ok");
}));
test("ignored output warning distinguishes tracked and ignored paths", async () => {
	assert.match((await ignoredOutputWarning(process.cwd(), ".references/before-after-capture-skill-gaps/"))!, /ignored/);
	assert.equal(await ignoredOutputWarning(process.cwd(), "extensions/ui-capture/spec.ts"), undefined);
});
test("ignored output warning checks evidence files, tracked files, and canonical outside paths", async () => fixture(async dir => {
	const git = promisify(execFile), root = join(await realpath(dir), "project"), output = join(root, "custom", "demo", "1");
	await mkdir(output, { recursive: true });
	await git("git", ["init", "-q", root]);
	await git("git", ["config", "core.excludesFile", "/dev/null"], { cwd: root });
	const files = ["before-full.png", "diff-full.png", "capture.yaml", "sidecar.json"];
	for (const name of files) await writeFile(join(output, name), name);
	await writeFile(join(root, ".gitignore"), "*.png\nsidecar.json\n");
	await git("git", ["add", "-f", "custom/demo/1/before-full.png"], { cwd: root });
	const warning = await ignoredOutputWarning(root, output, files);
	assert.equal(warning, `artifact output is ignored: ${join(output, "diff-full.png")}, ${join(output, "sidecar.json")}`);
	assert.equal(await ignoredOutputWarning(root, output, ["before-full.png", "capture.yaml"]), undefined);
	await writeFile(join(root, ".gitignore"), "custom/\n");
	assert.equal(await ignoredOutputWarning(root, output, ["before-full.png"]), undefined);
	assert.equal(await ignoredOutputWarning(root, output, ["capture.yaml"]), `artifact output is ignored: ${join(output, "capture.yaml")}`);
	const outside = join(await realpath(dir), "outside"); await mkdir(outside);
	assert.equal(await ignoredOutputWarning(root, outside, files), `artifact output is outside the Git repository: ${outside}`);
	const link = join(root, "link"); await symlink(outside, link);
	assert.equal(await ignoredOutputWarning(root, link, files), `artifact output is outside the Git repository: ${outside}`);
}));
test("artifact paths reject escapes including symlinked feature directories", async () => fixture(async root => {
	const path = await artifactDirectory(root, spec); assert.equal(path, join(root, "artifacts", "demo", "1"));
	assert.throws(() => parseSpec(text.replace("feature: demo", "feature: ../elsewhere")), /safe path/);
	await symlink(root, join(root, "artifacts", "escape"));
	await assert.rejects(artifactDirectory(root, parseSpec(text.replace("feature: demo", "feature: escape"))), /escapes/);
}));

test("published capture.yaml has server.url credentials redacted while the phase keeps the original spec hash", async () => fixture(async dir => {
	const secretText = text.replace("start: just run --port {port}", "url: http://user:s3cret@localhost:3000");
	const saved = await phase(dir, "before", 1, secretText);
	const published = await readFile(join(dir, "capture.yaml"), "utf8");
	assert.equal(published, secretText.replace("user:s3cret@", ""));
	assert.doesNotMatch(published, /s3cret/);
	assert.doesNotMatch(await readFile(join(dir, "sidecar.json"), "utf8"), /s3cret/);
	assert.equal(saved.phases.before!.spec_hash, parseSpec(secretText).hash);
}));
