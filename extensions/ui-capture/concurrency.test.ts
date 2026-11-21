import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const text = `feature: serial\nsubphase: 1\ndescription: test\nserver: {url: 'http://127.0.0.1:1234'}\nconditions: {entry: /}\nsteps:\n  - screenshot: {name: full}\ndiff: {screenshot: full}\n`;
const answers = { visible: true, conditions_match: true, only_difference_is_the_feature: true, same_target: true, preserved: [], measurements: [], note: "reviewed" };
const fixtureScript = fileURLToPath(new URL("./concurrency-fixture.ts", import.meta.url));
const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function waitFor(path: string) {
	const deadline = Date.now() + 10000;
	while (!existsSync(path)) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function start(root: string, spec: string, artifacts: string, action: string, marker = "-", release = "-", value = "A", blockAt = "-") {
	const child = fork(fixtureScript, [root, spec, artifacts, action, marker, release, value, blockAt], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
	let stderr = ""; child.stderr!.on("data", data => { stderr += data; });
	const done = new Promise<{ result?: any; error?: string }>((resolve, reject) => {
		let message: { result?: any; error?: string } | undefined;
		child.on("message", value => { message = value as typeof message; });
		child.on("error", reject);
		child.on("exit", code => code === 0 && message ? resolve(message) : reject(new Error(`fixture exited ${code}: ${stderr}`)));
	});
	return { child, done };
}
async function fixture(fn: (dir: string, spec: string, artifacts: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "capture-concurrency-")), spec = join(dir, "spec.yaml"), artifacts = join(dir, "artifacts");
	try { await writeFile(spec, text); await fn(dir, spec, artifacts); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("cross-process captures and CLI checks cannot mix evidence; other directories proceed", { timeout: 30000 }, async () => fixture(async (dir, spec, artifacts) => {
	const marker = join(dir, "ready"), release = join(dir, "release"), folder = join(artifacts, "serial", "1");
	const first = start(process.cwd(), spec, artifacts, "before", marker, release, "A");
	try {
		await waitFor(marker);
		const second = await start(process.cwd(), spec, artifacts, "before", "-", "-", "B").done;
		assert.match(second.error!, /artifact directory is locked/);
		const answersPath = join(dir, "answers.json"); await writeFile(answersPath, JSON.stringify(answers));
		await assert.rejects(promisify(execFile)(process.execPath, [cli, "check", spec, answersPath], { cwd: process.cwd(), env: { ...process.env, UI_CAPTURE_ARTIFACTS: artifacts } }), /artifact directory is locked/);
		const otherSpec = join(dir, "other.yaml"); await writeFile(otherSpec, text.replace("subphase: 1", "subphase: 2"));
		assert.equal((await start(process.cwd(), otherSpec, artifacts, "before", "-", "-", "C").done).result.ok, true);
	} finally { await writeFile(release, "go"); }
	assert.equal((await first.done).result.ok, true);
	const sidecar = JSON.parse(await readFile(join(folder, "sidecar.json"), "utf8"));
	assert.equal(await readFile(join(folder, "before-full.png"), "utf8"), "A");
	assert.equal(sidecar.phases.before.outcomes[0].result, "A");
	assert.equal(sidecar.phases.before.images[0].sha256, hash("A"));
	assert.equal(sidecar.phases.before.images[0].evidence_id, sidecar.phases.before.evidence_id);
}));

test("a pair check blocks phase invalidation until its approval is published", { timeout: 30000 }, async () => fixture(async (dir, spec, artifacts) => {
	assert.equal((await start(process.cwd(), spec, artifacts, "before", "-", "-", "A").done).result.ok, true);
	assert.equal((await start(process.cwd(), spec, artifacts, "after", "-", "-", "B").done).result.ok, true);
	const marker = join(dir, "ready"), release = join(dir, "release"), folder = join(artifacts, "serial", "1");
	const check = start(process.cwd(), spec, artifacts, "check", marker, release);
	try {
		await waitFor(marker);
		const capture = await start(process.cwd(), spec, artifacts, "after", "-", "-", "C").done;
		assert.match(capture.error!, /artifact directory is locked/);
	} finally { await writeFile(release, "go"); }
	const checked = (await check.done).result;
	const sidecar = JSON.parse(await readFile(join(folder, "sidecar.json"), "utf8"));
	assert.deepEqual(sidecar.pair_check.evidence, checked.pair_check.evidence);
	assert.equal(sidecar.phases.after.images[0].sha256, hash("B"));
	assert.equal(sidecar.pair_check.evidence.after, sidecar.phases.after.evidence_id);
	assert.equal((await start(process.cwd(), spec, artifacts, "after", "-", "-", "C").done).result.ok, true);
	const replaced = JSON.parse(await readFile(join(folder, "sidecar.json"), "utf8"));
	assert.equal(replaced.pair_check, undefined);
	assert.equal(replaced.phases.after.images[0].sha256, hash("C"));
}));

test("foreign or abandoned lock is not removed or followed", { timeout: 30000 }, async () => fixture(async (dir, spec, artifacts) => {
	const folder = join(artifacts, "serial", "1"), lock = join(folder, ".ui-capture.lock"), sentinel = join(dir, "sentinel");
	await mkdir(folder, { recursive: true }); await writeFile(sentinel, "untouched"); await symlink(sentinel, lock);
	assert.match((await start(process.cwd(), spec, artifacts, "before").done).error!, /artifact directory is locked/);
	assert.equal(await readFile(sentinel, "utf8"), "untouched"); await rm(lock);
	await writeFile(lock, "abandoned test lock");
	assert.match((await start(process.cwd(), spec, artifacts, "before").done).error!, /artifact directory is locked/);
	assert.equal(await readFile(lock, "utf8"), "abandoned test lock");
	await rm(lock); // This fixture created the lock without a live owner.
	assert.equal((await start(process.cwd(), spec, artifacts, "before").done).result.ok, true);
}));

// A completed phase is recorded only after browser cleanup succeeds, so an interrupted process cannot leave approvable evidence.
test("a process interrupted during cleanup leaves no approvable evidence until its own run completes", { timeout: 30000 }, async () => fixture(async (dir, spec, artifacts) => {
	const folder = join(artifacts, "serial", "1"), marker = join(dir, "ready"), release = join(dir, "release"), lock = join(folder, ".ui-capture.lock");
	assert.equal((await start(process.cwd(), spec, artifacts, "before", "-", "-", "A").done).result.ok, true);
	const interrupted = start(process.cwd(), spec, artifacts, "after", marker, release, "B", "close");
	await waitFor(marker); // the steps and diff work finished; the child is inside browser cleanup
	const partial = JSON.parse(await readFile(join(folder, "sidecar.json"), "utf8"));
	assert.equal(partial.phases.before.status, "success");
	assert.equal(partial.phases.after.status, "failed"); assert.equal(partial.phases.after.complete, false);
	assert.deepEqual(partial.phases.after.images, []); assert.equal(partial.diff, undefined);
	interrupted.child.kill("SIGKILL");
	await assert.rejects(interrupted.done);
	// The exiting worker releases the lock itself once its host channel disconnects.
	for (let attempt = 0; attempt < 50 && existsSync(lock); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
	assert.equal(existsSync(lock), false);
	const answersPath = join(dir, "answers.json"); await writeFile(answersPath, JSON.stringify(answers));
	const env = { ...process.env, UI_CAPTURE_ARTIFACTS: artifacts };
	// Its worker may still be exiting when we first reach the directory.
	const check = async () => {
		for (let attempt = 0; attempt < 10; attempt++) {
			try { return await promisify(execFile)(process.execPath, [cli, "check", spec, answersPath], { cwd: process.cwd(), env }); }
			catch (error) { const message = error instanceof Error ? error.message : String(error); if (!message.includes("artifact directory is locked")) throw error; await new Promise(resolve => setTimeout(resolve, 200)); }
		}
		throw new Error("the abandoned lock was never released by the exiting worker");
	};
	await assert.rejects(check(), /pair requires two successful complete phases/);
	const completed = (await start(process.cwd(), spec, artifacts, "after", "-", "-", "B").done).result;
	assert.equal(completed.ok, true);
	assert.deepEqual(completed.images.map((image: { path: string }) => image.path), ["before-full.png", "after-full.png", "diff-full.png"]);
	const approved = (await start(process.cwd(), spec, artifacts, "check", "-", "-").done).result;
	assert.ok(approved.diff && approved.pair_check);
	assert.equal(approved.phases.after.images[0].sha256, hash("B"));
	assert.equal(approved.pair_check.evidence.after, approved.phases.after.evidence_id);
}));
