import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArtifactDirectory, publishArtifact, readArtifact } from "./artifacts.ts";
import { parseSpec } from "./spec.ts";

const spec = parseSpec(`feature: demo\nsubphase: 1\ndescription: test\nserver: {url: 'http://localhost:3000'}\nconditions: {entry: /}\nsteps:\n  - screenshot: {}\n`);
async function fixture(fn: (dir: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "capture-artifacts-"));
	try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("shared Linux and macOS artifact backend pins cwd and safely publishes", async () => fixture(async root => {
	// Exercise the macOS platform gate with the same backend on Linux too; actual
	// macOS kernel behavior requires running this test on a macOS host.
	const original = Object.getOwnPropertyDescriptor(process, "platform")!;
	for (const platform of ["linux", "darwin"]) {
		Object.defineProperty(process, "platform", { value: platform });
		try {
			const dir = await openArtifactDirectory(root, spec, platform);
			try {
				const sentinel = join(root, `sentinel-${platform}`);
				await writeFile(sentinel, "untouched"); await symlink(sentinel, join(dir.dir, "capture.yaml"));
				await publishArtifact(dir, "capture.yaml", "new");
				assert.equal((await readArtifact(dir, "capture.yaml")).toString(), "new");
				assert.equal(await readFile(sentinel, "utf8"), "untouched");
				await assert.rejects(publishArtifact(dir, "../escape", "bad"), /invalid artifact name/);
			} finally { await dir.close(); }
		} finally { Object.defineProperty(process, "platform", original); }
	}
}));

test("feature and subphase symlinks are rejected", async () => fixture(async root => {
	const outside = join(root, "outside"), artifacts = join(root, "artifacts");
	await mkdir(outside); await mkdir(artifacts);
	await symlink(outside, join(artifacts, "demo"));
	await assert.rejects(openArtifactDirectory(root, spec), /escapes/);
	await rm(join(artifacts, "demo")); await mkdir(join(artifacts, "demo"));
	await symlink(outside, join(artifacts, "demo", "1"));
	await assert.rejects(openArtifactDirectory(root, spec), /escapes/);
	assert.deepEqual(await readdir(outside), []);
}));

test("artifact worker releases its lock when the host channel disconnects", async () => fixture(async root => {
	const { fork } = await import("node:child_process");
	const { stat } = await import("node:fs/promises");
	const { existsSync } = await import("node:fs");
	const { fileURLToPath } = await import("node:url");
	const child = fork(fileURLToPath(new URL("./artifact-worker.cjs", import.meta.url)), [], { cwd: root, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
	const rootStat = await stat(root);
	await new Promise<void>((resolve, reject) => {
		child.once("message", (reply: { error?: { message: string } }) => reply.error ? reject(new Error(reply.error.message)) : resolve());
		child.send({ id: 1, op: "init", root: { dev: rootStat.dev, ino: rootStat.ino }, feature: "demo", subphase: "1" });
	});
	const lockPath = join(root, "demo", "1", ".ui-capture.lock");
	assert.ok(existsSync(lockPath));
	const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
	child.disconnect(); await exited;
	assert.equal(existsSync(lockPath), false);
}));
