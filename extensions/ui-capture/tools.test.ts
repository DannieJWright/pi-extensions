import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, relative } from "node:path";
import { symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { CaptureService } from "./capture.ts";
import { createDriver } from "./driver.ts";
import type { ImageCodec } from "./diff.ts";
import { CaptureServer, type Identity, type OwnedServer, type ServerRuntime } from "./server.ts";
import extension from "./index.ts";
import { main } from "./cli.ts";
import { fileURLToPath } from "node:url";

const text = `feature: tools\nsubphase: 1\ndescription: test\nserver:\n  url: http://127.0.0.1:1234\n  ready: {path: /ready, selector: '#ready', not_text: Loading, timeout: 1}\nconditions: {entry: /app, viewport: 100x100}\nsteps:\n  - screenshot: {name: full}\ndiff: {screenshot: full}\n`;
const answers = { visible: true, conditions_match: true, only_difference_is_the_feature: true, same_target: true, preserved: [], measurements: [], note: "reviewed" };
const codec: ImageCodec = { async decode(data) { return { width: 1, height: 1, data: Uint8Array.from([data[0], 0, 0, 255]) }; }, async encode(image) { return Buffer.from(image.data); } };

function fake() {
	const calls: string[] = []; let fail = false, color = 1, launches = 0;
	const runtime = { locked: async (_key: string, fn: () => Promise<unknown>) => fn(), now: () => Date.now(), probe: async (url: string) => { calls.push(`probe ${url}`); return { healthy: true, listener: true }; } } as ServerRuntime;
	const page = {
		on() {}, context: () => ({ browser: () => browser }), goto: async (url: string) => { calls.push(`goto ${url}`); },
		locator: (selector: string) => ({ waitFor: async () => { calls.push(`ready ${selector}`); if (fail) throw new Error("hydration failed"); } }),
		waitForFunction: async (_fn: unknown, value: string) => { calls.push(`not_text ${value}`); },
		evaluate: async () => ({ scrollX: 0, scrollY: 0, width: 100, height: 100 }),
		screenshot: async () => { calls.push("screenshot"); return Buffer.from([color]); },
	};
	const context = { addInitScript: async () => {}, newPage: async () => page, close: async () => { calls.push("context close"); } };
	const browser = { newContext: async () => context, close: async () => { calls.push("browser close"); } };
	const playwright = { chromium: { launch: async () => { launches++; return browser; } } };
	return { calls, runtime, playwright, page, browser, context, launches: () => launches, fail: () => { fail = true; }, nextColor: () => { color++; } };
}
async function fixture(fn: (dir: string, spec: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "capture-tools-")); const spec = join(dir, "spec.yaml");
	try { await writeFile(spec, text); await fn(dir, spec); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("registers the three tools and shutdown hook on session start", async () => {
	// Shutdown reads the trust file from the home directory; point HOME at an empty temporary one.
	const home = await mkdtemp(join(tmpdir(), "capture-home-")), previousHome = process.env.HOME;
	process.env.HOME = home;
	try {
	const hooks: Record<string, Function> = {}, tools: Record<string, any> = {};
	extension({ on: (name: string, fn: Function) => { hooks[name] = fn; }, registerTool: (tool: any) => { tools[tool.name] = tool; } } as any);
	await hooks.session_start({}, {});
	assert.deepEqual(Object.keys(tools), ["capture_server", "capture_run", "capture_check"]);
	assert.deepEqual(tools.capture_server.parameters.required, ["action", "spec"]);
	assert.deepEqual(tools.capture_run.parameters.required, ["spec", "phase"]);
	assert.deepEqual(tools.capture_run.parameters.properties.packageDirectory, { type: "string", minLength: 1, description: "Playwright package directory, relative to the Git root or absolute; defaults to server.cwd, then the Git root" });
	assert.deepEqual(tools.capture_check.parameters.required, ["spec", "answers"]);
	await hooks.session_shutdown({}, { ui: { notify: assert.fail } });
	} finally {
		if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
		await rm(home, { recursive: true, force: true });
	}
});

test("capture_run forwards the explicit package directory without changing the session cwd", async () => {
	const hooks: Record<string, Function> = {}, tools: Record<string, any> = {}, calls: unknown[] = [];
	const original = CaptureService.prototype.run;
	CaptureService.prototype.run = async (...args) => { calls.push(args); return { ok: true, images: [] } as any; };
	try {
		extension({ on: (name: string, fn: Function) => { hooks[name] = fn; }, registerTool: (tool: any) => { tools[tool.name] = tool; } } as any);
		await hooks.session_start({}, {});
		const signal = new AbortController().signal;
		const result = await tools.capture_run.execute("id", { spec: "spec.yaml", phase: "before", build: "label", packageDirectory: "packages/web" }, signal, undefined, { cwd: "/work/app" });
		assert.equal(result.isError, false);
		assert.deepEqual(calls, [["/work/app", "spec.yaml", "before", "label", signal, "packages/web"]]);
	} finally { CaptureService.prototype.run = original; }
});

test("service resolves explicit, server and root package anchors and reports load errors separately", async () => fixture(async (dir, spec) => {
	const root = join(dir, "project"), app = join(root, "app"), git = promisify(execFile);
	await mkdir(app, { recursive: true });
	await git("git", ["init", "-q", root]);
	await git("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-qm", "fixture"], { cwd: root });
	const packageSource = (marker: string) => `module.exports = { chromium: { launch: async () => ({ newContext: async () => ({ addInitScript: async () => {}, newPage: async () => ({ on() {}, goto: async () => {}, locator: () => ({ waitFor: async () => {} }), waitForFunction: async () => {}, evaluate: async () => ({ scrollX: 0, scrollY: 0, width: 100, height: 100 }), screenshot: async () => Buffer.from(${JSON.stringify(marker)}) }), close: async () => {} }), close: async () => {} }) } };`;
	async function pkg(directory: string, name: string, source: string) {
		const path = join(root, directory, "node_modules", name);
		await mkdir(path, { recursive: true });
		await writeFile(join(path, "package.json"), JSON.stringify({ main: "index.cjs" }));
		await writeFile(join(path, "index.cjs"), source);
	}
	await pkg("", "playwright", packageSource("root"));
	await pkg("app", "playwright", packageSource("server"));
	await pkg("explicit", "playwright", packageSource("explicit"));
	const f = fake(), service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: join(dir, "artifacts") });
	const configured = text.replace("  url: http://127.0.0.1:1234", "  url: http://127.0.0.1:1234\n  cwd: app");
	await writeFile(spec, configured);
	const capture = async (anchor?: string) => (await service.run(app, spec, "before", undefined, undefined, anchor)).images[0].data;
	assert.equal(Buffer.from(await capture(), "base64").toString(), "server");
	assert.equal(Buffer.from(await capture("explicit"), "base64").toString(), "explicit");
	assert.equal(Buffer.from(await capture(join(root, "explicit")), "base64").toString(), "explicit");
	await writeFile(spec, text);
	assert.equal(Buffer.from(await capture(), "base64").toString(), "root");
	await assert.rejects(service.run(app, spec, "before", undefined, undefined, ""), /packageDirectory must be a non-empty path/);
	await pkg("broken", "playwright", "throw new Error('module exploded')");
	await pkg("broken", "@playwright/test", packageSource("fallback"));
	await assert.rejects(capture("broken"), /Resolved playwright.*failed to load.*module exploded/);
	// Use directories outside the project so Node cannot fall back to the root package.
	await assert.rejects(capture(join(dir, "missing")), /Playwright not found.*dev dependency/);
	const fallback = join(dir, "fallback", "node_modules", "@playwright", "test");
	await mkdir(fallback, { recursive: true });
	await writeFile(join(fallback, "package.json"), JSON.stringify({ main: "index.cjs" }));
	await writeFile(join(fallback, "index.cjs"), packageSource("fallback"));
	assert.equal(Buffer.from(await capture(join(dir, "fallback")), "base64").toString(), "fallback");
}));

test("server readiness, real driver hydration wiring, pair diff and stale rejection", async () => fixture(async (dir, spec) => {
	const f = fake();
	const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: dir, codec: () => codec,
		createDriver: options => createDriver({ ...options, playwright: f.playwright }) });
	const before = await service.run(process.cwd(), spec, "before", "baseline");
	assert.equal(before.ok, true); assert.equal(before.images.length, 1); assert.match(before.build, /^[a-f0-9]+ (dirty|clean) \(baseline\)$/);
	assert.deepEqual(f.calls.slice(0, 4), ["probe http://127.0.0.1:1234/ready", "goto http://127.0.0.1:1234/app", "ready #ready", "not_text Loading"]);
	f.nextColor(); const after = await service.run(process.cwd(), spec, "after");
	assert.equal(after.images.length, 3); assert.equal((after.diff as any).regions.screenshot.differing, 1);
	await service.check(process.cwd(), spec, answers);
	await assert.rejects(service.check(process.cwd(), spec, answers), /already exists/);
	const folder = join(dir, "tools", "1");
	await writeFile(join(folder, "after-full.png"), "tampered");
	await assert.rejects(service.check(process.cwd(), spec, answers, true), /stale image/);
	f.fail(); await assert.rejects(service.run(process.cwd(), spec, "after"), /hydration failed/);
	const sidecar = JSON.parse(await readFile(join(folder, "sidecar.json"), "utf8"));
	assert.equal(sidecar.phases.after.status, "failed"); assert.equal(sidecar.pair_check, undefined); assert.equal(sidecar.diff, undefined);
	assert.ok(f.calls.includes("context close")); assert.ok(f.calls.includes("browser close"));
}));

// The approval is about what differs between two captures, so it can only be accepted while that comparison is still verifiable.
test("pair approval rejects a deleted or replaced diff mask and accepts the regenerated one", async () => fixture(async (dir, spec) => {
	const f = fake(), folder = join(dir, "tools", "1");
	const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: dir, codec: () => codec,
		createDriver: options => createDriver({ ...options, playwright: f.playwright }) });
	await service.run(process.cwd(), spec, "before");
	f.nextColor(); const first = await service.run(process.cwd(), spec, "after");
	// The record describes exactly the bytes the run published for these phases.
	assert.equal((first.diff as any).sha256, createHash("sha256").update(await readFile(join(folder, "diff-full.png"))).digest("hex"));
	await service.check(process.cwd(), spec, answers);
	await rm(join(folder, "diff-full.png"));
	await assert.rejects(service.check(process.cwd(), spec, answers, true), /missing diff mask/);
	await writeFile(join(folder, "diff-full.png"), "replaced");
	await assert.rejects(service.check(process.cwd(), spec, answers, true), /stale diff mask/);
	// Re-running a phase invalidates its evidence, so neither the earlier answer nor its diff remains; the regenerated pair can be approved.
	f.nextColor(); const second = await service.run(process.cwd(), spec, "after");
	const sidecar = JSON.parse(await readFile(join(folder, "sidecar.json"), "utf8"));
	assert.equal(sidecar.pair_check, undefined); assert.equal(sidecar.diff.sha256, (second.diff as any).sha256);
	assert.equal(sidecar.diff.evidence.after, sidecar.phases.after.evidence_id);
	await service.check(process.cwd(), spec, answers);
}));

test("context and browser close failures invalidate an approved pair and reject capture_check", async () => {
	for (const [resource, phase] of [["context", "before"], ["browser", "after"]] as const) await fixture(async (dir, spec) => {
		const f = fake(), folder = join(dir, "tools", "1");
		const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: dir, codec: () => codec,
			createDriver: options => createDriver({ ...options, playwright: f.playwright }) });
		assert.equal((await service.run(process.cwd(), spec, "before")).ok, true);
		f.nextColor(); assert.equal((await service.run(process.cwd(), spec, "after")).ok, true);
		await service.check(process.cwd(), spec, answers);
		const approved = JSON.parse(await readFile(join(folder, "sidecar.json"), "utf8"));
		assert.ok(approved.diff); assert.ok(approved.pair_check);
		const closing = f[resource];
		closing.close = async () => { f.calls.push(`${resource} close`); throw new Error(`${resource} close failed`); };
		await assert.rejects(service.run(process.cwd(), spec, phase), new RegExp(`${resource} close failed`));
		const sidecar = JSON.parse(await readFile(join(folder, "sidecar.json"), "utf8"));
		assert.equal(sidecar.phases[phase].status, "failed"); assert.equal(sidecar.phases[phase].complete, false);
		assert.deepEqual(sidecar.phases[phase].images, []);
		assert.match(sidecar.phases[phase].read.error, new RegExp(`${resource} close failed`));
		assert.equal(sidecar.phases[phase === "before" ? "after" : "before"].status, "success");
		assert.equal(sidecar.diff, undefined); assert.equal(sidecar.pair_check, undefined);
		await assert.rejects(service.check(process.cwd(), spec, answers, true), /pair requires two successful complete phases/);
		assert.equal(f.calls.filter(call => call === "context close").length, 3);
		assert.equal(f.calls.filter(call => call === "browser close").length, 3);
	});
});

test("cleanup failures report earlier step and thrown capture errors", async () => fixture(async (dir, spec) => {
	const f = fake(), folder = join(dir, "tools", "1");
	const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: dir, codec: () => codec,
		createDriver: options => createDriver({ ...options, playwright: f.playwright }) });
	f.page.screenshot = async () => { throw new Error("screenshot failed"); };
	f.context.close = async () => { throw new Error("context close failed"); };
	await assert.rejects(service.run(process.cwd(), spec, "before"), /screenshot failed; cleanup failed: context close failed/);
	let sidecar = JSON.parse(await readFile(join(folder, "sidecar.json"), "utf8"));
	assert.equal(sidecar.phases.before.outcomes[0].error, "screenshot failed");
	assert.match(sidecar.phases.before.read.error, /screenshot failed; cleanup failed: context close failed/);
	assert.ok(f.calls.includes("browser close"));
	f.page.screenshot = async () => Buffer.from([1]);
	await writeFile(spec, text.replace("diff: {screenshot: full}", "diff: {screenshot: missing}"));
	await assert.rejects(service.run(process.cwd(), spec, "after"), /Selected screenshot is not current evidence; cleanup failed: context close failed/);
	sidecar = JSON.parse(await readFile(join(folder, "sidecar.json"), "utf8"));
	assert.equal(sidecar.phases.after.status, "failed");
	assert.match(sidecar.phases.after.read.error, /Selected screenshot is not current evidence; cleanup failed: context close failed/);
}));

test("abort-triggered cleanup failure is reported once and leaves failed evidence", async () => fixture(async (dir, spec) => {
	const f = fake(), controller = new AbortController();
	const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: dir,
		createDriver: options => createDriver({ ...options, playwright: f.playwright }) });
	f.page.screenshot = async () => { controller.abort(); return Buffer.from([1]); };
	f.context.close = async () => { f.calls.push("context close"); throw new Error("context close failed"); };
	await assert.rejects(service.run(process.cwd(), spec, "before", undefined, controller.signal), /capture cancelled; cleanup failed: context close failed/);
	const sidecar = JSON.parse(await readFile(join(dir, "tools", "1", "sidecar.json"), "utf8"));
	assert.equal(sidecar.phases.before.status, "failed"); assert.deepEqual(sidecar.phases.before.images, []);
	assert.equal(f.calls.filter(call => call === "context close").length, 1);
	assert.equal(f.calls.filter(call => call === "browser close").length, 1);
}));

// A completed phase is recorded only after cleanup succeeds, so an interrupted or failed cleanup cannot leave approvable evidence.
test("a browser close failure leaves no successful evidence when the failure record cannot be written", async () => fixture(async (dir, spec) => {
	const f = fake(), folder = join(dir, "tools", "1");
	const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: dir, codec: () => codec,
		createDriver: options => createDriver({ ...options, playwright: f.playwright }) });
	f.browser.close = async () => { await chmod(folder, 0o500); f.calls.push("browser close"); throw new Error("browser close failed"); };
	// The failed cleanup cannot be recorded here, so the last writable record stays the run start.
	await assert.rejects(service.run(process.cwd(), spec, "before")); // its own lock could not be released either, which may replace the reported error
	assert.ok(f.calls.includes("browser close"));
	await chmod(folder, 0o700); await rm(join(folder, ".ui-capture.lock")); // its own worker exited without releasing the lock it held
	const sidecar = JSON.parse(await readFile(join(folder, "sidecar.json"), "utf8"));
	assert.equal(sidecar.phases.before.status, "failed");
	assert.equal(sidecar.phases.before.read.error, "capture started"); // the run start is still the last writable record
	assert.deepEqual(sidecar.phases.before.images, []);
	await assert.rejects(service.check(process.cwd(), spec, answers), /pair requires two successful complete phases/);
}));

test("default codec uses isolated context and a codec failure invalidates the after phase", async () => fixture(async (dir, spec) => {
	const f = fake(); let closed = 0, failDecode = false; const encoded: unknown[] = [];
	const isolated = {
		newPage: async () => ({ evaluate: async (_fn: unknown, argument: any) => {
			if (typeof argument === "string") {
				if (failDecode) throw new Error("decode failed");
				return { width: 1, height: 1, data: [Buffer.from(argument, "base64")[0], 0, 0, 255] };
			}
			encoded.push(argument); return Buffer.from(argument.data).toString("base64");
		} }),
		close: async () => { closed++; },
	};
	let contexts = 0;
	f.browser.newContext = async () => { contexts++; return contexts === 1 || contexts % 2 === 0 ? f.context : isolated as any; };
	const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: dir,
		createDriver: options => createDriver({ ...options, playwright: f.playwright }) });
	await service.run(process.cwd(), spec, "before");
	f.nextColor(); const after = await service.run(process.cwd(), spec, "after");
	assert.equal((after.diff as any).regions.screenshot.differing, 1);
	assert.deepEqual(encoded, [{ width: 1, height: 1, data: [255, 0, 0, 255] }]);
	assert.deepEqual(await readFile(join(dir, "tools", "1", "diff-full.png")), Buffer.from([255, 0, 0, 255]));
	assert.equal(closed, 1);
	failDecode = true;
	await assert.rejects(service.run(process.cwd(), spec, "after"), /decode failed/);
	const sidecar = JSON.parse(await readFile(join(dir, "tools", "1", "sidecar.json"), "utf8"));
	assert.equal(sidecar.phases.after.status, "failed"); assert.deepEqual(sidecar.phases.after.images, []);
	assert.equal(sidecar.diff, undefined); assert.equal(sidecar.pair_check, undefined);
	assert.equal(closed, 2);
}));

// A failing cleanup of the isolated decoding context cannot replace the comparison failure, and one cause is never reported with an invented second one.
test("image comparison and isolated canvas context failures are reported together or alone", async () => {
	const cases = [
		{ decode: "canvas decode failed", close: "isolated context close failed", expected: "canvas decode failed; cleanup failed: isolated context close failed", combined: true },
		{ decode: "canvas decode failed", close: undefined, expected: "canvas decode failed", combined: false },
		{ decode: undefined, close: "isolated context close failed", expected: "isolated context close failed", combined: false },
	];
	for (const c of cases) await fixture(async (dir, spec) => {
		const f = fake(), folder = join(dir, "tools", "1"); let closed = 0;
		const isolated = {
			newPage: async () => ({ evaluate: async (_fn: unknown, argument: any) => {
				if (typeof argument === "string") {
					if (c.decode) throw new Error(c.decode);
					return { width: 1, height: 1, data: [Buffer.from(argument, "base64")[0], 0, 0, 255] };
				}
				return Buffer.from(argument.data).toString("base64");
			} }),
			close: async () => { closed++; if (c.close) throw new Error(c.close); },
		};
		// The capture driver's context takes its conditions arguments; the canvas context is created without any.
		f.browser.newContext = async (...args: unknown[]) => args.length ? f.context : isolated as any;
		const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: dir,
			createDriver: options => createDriver({ ...options, playwright: f.playwright }) });
		await service.run(process.cwd(), spec, "before"); // no complete pair yet, so nothing is compared
		assert.equal(closed, 0);
		f.nextColor();
		const error = await service.run(process.cwd(), spec, "after").catch((error: unknown) => error);
		assert.ok((error instanceof AggregateError) === c.combined);
		assert.equal(error.message, c.expected);
		assert.equal(closed, 1); // the isolated context is closed on successful and failed comparisons alike
		// A failed comparison cannot leave approvable evidence for this phase or its pair.
		const sidecar = JSON.parse(await readFile(join(folder, "sidecar.json"), "utf8"));
		assert.equal(sidecar.phases.after.status, "failed"); assert.deepEqual(sidecar.phases.after.images, []);
		assert.equal(sidecar.diff, undefined); assert.equal(sidecar.pair_check, undefined);
		await assert.rejects(service.check(process.cwd(), spec, answers, true), /pair requires two successful complete phases/);
	});
});

test("capture, screenshot and diff publication replace file symlinks without writing their targets", async () => fixture(async (dir, spec) => {
	const f = fake(), folder = join(dir, "tools", "1"), sentinel = join(dir, "sentinel");
	await mkdir(folder, { recursive: true }); await writeFile(sentinel, "untouched");
	for (const name of ["capture.yaml", "before-full.png", "diff-full.png"]) await symlink(sentinel, join(folder, name));
	const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: dir, codec: () => codec,
		createDriver: options => createDriver({ ...options, playwright: f.playwright }) });
	await service.run(process.cwd(), spec, "before");
	f.nextColor(); await service.run(process.cwd(), spec, "after");
	await service.check(process.cwd(), spec, answers);
	assert.equal(await readFile(sentinel, "utf8"), "untouched");
	assert.equal(await readFile(join(folder, "capture.yaml"), "utf8"), text);
	assert.deepEqual(await readFile(join(folder, "before-full.png")), Buffer.from([1]));
	assert.notEqual((await readFile(join(folder, "diff-full.png"))).toString(), "untouched");
}));

test("sidecar symlink is rejected before capture and on failed retry", async () => fixture(async (dir, spec) => {
	const f = fake(), folder = join(dir, "tools", "1"), sentinel = join(dir, "sentinel");
	await mkdir(folder, { recursive: true }); await writeFile(sentinel, "untouched");
	await symlink(sentinel, join(folder, "sidecar.json"));
	const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: dir, codec: () => codec,
		createDriver: options => createDriver({ ...options, playwright: f.playwright }) });
	await assert.rejects(service.run(process.cwd(), spec, "before"));
	assert.equal(f.calls.length, 0); assert.equal(await readFile(sentinel, "utf8"), "untouched");
	await rm(join(folder, "sidecar.json")); f.fail();
	await service.run(process.cwd(), spec, "before").catch(() => {});
	await rm(join(folder, "sidecar.json")); await symlink(sentinel, join(folder, "sidecar.json"));
	await assert.rejects(service.run(process.cwd(), spec, "before"));
	assert.equal(await readFile(sentinel, "utf8"), "untouched");
}));

test("failure and diff updates do not follow a substituted artifact file", async () => fixture(async (dir, spec) => {
	const f = fake(), folder = join(dir, "tools", "1"), sentinel = join(dir, "sentinel");
	await writeFile(sentinel, "untouched");
	const failing = new CaptureService({ runtime: { ...f.runtime, probe: async () => {
		await rm(join(folder, "capture.yaml")); await symlink(sentinel, join(folder, "capture.yaml"));
		throw new Error("probe failed");
	} }, allowedCommands: [], artifacts: dir });
	await assert.rejects(failing.run(process.cwd(), spec, "before"), /probe failed/);
	assert.equal(await readFile(sentinel, "utf8"), "untouched");
	assert.equal(await readFile(join(folder, "capture.yaml"), "utf8"), text);
	const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: dir,
		createDriver: options => createDriver({ ...options, playwright: f.playwright }), codec: () => ({ ...codec, async encode(image) {
			await rm(join(folder, "sidecar.json")); await symlink(sentinel, join(folder, "sidecar.json"));
			return codec.encode(image);
		} }) });
	await service.run(process.cwd(), spec, "before");
	await service.run(process.cwd(), spec, "after");
	assert.equal(await readFile(sentinel, "utf8"), "untouched");
	assert.ok(JSON.parse(await readFile(join(folder, "sidecar.json"), "utf8")).diff);
}));

test("screenshot, diff mask and pair check resist file symlinks substituted during work", async () => fixture(async (dir, spec) => {
	const f = fake(), folder = join(dir, "tools", "1"), sentinel = join(dir, "sentinel");
	await writeFile(sentinel, "untouched");
	f.page.screenshot = async () => { await symlink(sentinel, join(folder, "before-full.png")); return Buffer.from([1]); };
	let maskRace = false;
	const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: dir,
		createDriver: options => createDriver({ ...options, playwright: f.playwright }), codec: () => ({ ...codec, async encode(image) {
			await symlink(sentinel, join(folder, "diff-full.png")); maskRace = true; return codec.encode(image);
		} }) });
	await service.run(process.cwd(), spec, "before");
	f.page.screenshot = async () => Buffer.from([2]);
	await service.run(process.cwd(), spec, "after");
	let reads = 0;
	const raced = { ...answers, get measurements() {
		if (++reads === 3) { unlinkSync(join(folder, "sidecar.json")); symlinkSync(sentinel, join(folder, "sidecar.json")); }
		return answers.measurements;
	} };
	await service.check(process.cwd(), spec, raced);
	assert.ok(maskRace); assert.ok(reads >= 3);
	assert.equal(await readFile(sentinel, "utf8"), "untouched");
	assert.deepEqual(await readFile(join(folder, "before-full.png")), Buffer.from([1]));
	assert.equal(JSON.parse(await readFile(join(folder, "sidecar.json"), "utf8")).pair_check.note, "reviewed");
}));

test("relative artifact override resolves from the git root", async () => fixture(async (dir, spec) => {
	const f = fake();
	const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: relative(process.cwd(), dir),
		createDriver: options => createDriver({ ...options, playwright: f.playwright }) });
	const result = await service.run(process.cwd(), spec, "before");
	assert.equal(result.dir, join(dir, "tools", "1"));
	assert.deepEqual(await readFile(join(result.dir, "before-full.png")), Buffer.from([1]));
}));

test("capture warns about ignored evidence files under a configured artifact root", async () => fixture(async (dir, spec) => {
	const root = join(dir, "project"), git = promisify(execFile), f = fake();
	await mkdir(root); await git("git", ["init", "-q", root]);
	await git("git", ["config", "core.excludesFile", "/dev/null"], { cwd: root });
	await git("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-qm", "fixture"], { cwd: root });
	await writeFile(spec, text.replace("  - screenshot: {name: full}", "  - screenshot: {name: other}\n  - screenshot: {name: full}"));
	await writeFile(join(root, ".gitignore"), "*.png\n");
	const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: "evidence", codec: () => codec,
		createDriver: options => createDriver({ ...options, playwright: f.playwright }) });
	const before = await service.run(root, spec, "before");
	assert.match(before.warning!, /before-other\.png/); assert.match(before.warning!, /before-full\.png/);
	await git("git", ["add", "-f", "evidence/tools/1/before-full.png"], { cwd: root });
	const repeat = await service.run(root, spec, "before");
	assert.match(repeat.warning!, /before-other\.png/); assert.doesNotMatch(repeat.warning!, /before-full\.png/);
	f.nextColor(); const after = await service.run(root, spec, "after");
	assert.match(after.warning!, /after-other\.png/); assert.match(after.warning!, /after-full\.png/); assert.match(after.warning!, /diff-full\.png/);
	assert.doesNotMatch(after.warning!, /before-full\.png/);
	await writeFile(join(root, ".gitignore"), "diff-full.png\ncapture.yaml\n");
	const metadata = await service.run(root, spec, "after");
	assert.match(metadata.warning!, /diff-full\.png/); assert.match(metadata.warning!, /capture\.yaml/);
	assert.doesNotMatch(metadata.warning!, /after-full\.png|sidecar\.json/);
	await writeFile(join(root, ".gitignore"), "evidence/\n");
	const directory = await service.run(root, spec, "after");
	assert.match(directory.warning!, /sidecar\.json/); assert.match(directory.warning!, /after-full\.png/);
	assert.doesNotMatch(directory.warning!, /before-full\.png/);
}));

// A capture holds its own artifact lock for the whole operation, so that file cannot count as a project change. Each case reads git status in a real temporary repository.
test("build state excludes only the active capture's own artifact lock", async () => fixture(async (dir, spec) => {
	const git = promisify(execFile), f = fake(); let plainStatus = "";
	const observe = async (options: Parameters<typeof createDriver>[0]) => {
		plainStatus = (await git("git", ["status", "--porcelain"], { cwd: options.root })).stdout; // the unexcluded view while the lock is still held
		return createDriver({ ...options, playwright: f.playwright });
	};
	async function repository(name: string, entries: Record<string, string>): Promise<[string, string]> {
		const root = join(dir, name), artifacts = join(root, "artifacts");
		await mkdir(join(artifacts, "tools", "1"), { recursive: true });
		for (const [path, data] of Object.entries(entries)) await writeFile(join(root, path), data);
		await git("git", ["init", "-q", root]);
		await git("git", ["config", "core.excludesFile", "/dev/null"], { cwd: root });
		await git("git", ["add", "."], { cwd: root });
		await git("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-qm", "fixture"], { cwd: root });
		return [root, artifacts];
	}
	const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], codec: () => codec, artifacts: "artifacts", createDriver: observe });
	// Tracked artifacts with no ignore rule for the lock: git sees the live lock, but it is not a project change.
	const [trackedRoot] = await repository("tracked-artifacts", { "artifacts/tools/1/tracked.png": "committed" });
	assert.match((await service.run(trackedRoot, spec, "before")).build, /^[a-f0-9]+ clean$/);
	assert.match(plainStatus, /\?\? artifacts\/tools\/1\/\.ui-capture\.lock/);
	// A genuine tracked change inside the artifact directory is still a project change.
	const [changedRoot] = await repository("tracked-change", { "artifacts/tools/1/tracked.png": "committed" });
	await writeFile(join(changedRoot, "artifacts", "tools", "1", "tracked.png"), "modified");
	assert.match((await service.run(changedRoot, spec, "before")).build, /^[a-f0-9]+ dirty$/);
	assert.match(plainStatus, / M artifacts\/tools\/1\/tracked\.png/);
	// Unrelated files outside the artifact directory are still reported.
	const [unrelatedRoot] = await repository("unrelated-files", { ".gitignore": "*.png\ncaptured.yaml\nsidecar.json\n" });
	await writeFile(join(unrelatedRoot, "notes.md"), "unrelated");
	assert.match((await service.run(unrelatedRoot, spec, "before")).build, /^[a-f0-9]+ dirty$/);
	assert.match(plainStatus, /\?\? notes\.md/);
	// An ignored artifact directory keeps its own reporting unchanged.
	const [ignoredRoot] = await repository("ignored-artifacts", { ".gitignore": "artifacts/\n" });
	const ignored = await service.run(ignoredRoot, spec, "before");
	assert.match(ignored.build, /^[a-f0-9]+ clean$/); assert.match(ignored.warning!, /sidecar\.json/);
	// An artifact directory outside the repository is never part of its status, so nothing is excluded for it.
	const [externalRoot] = await repository("external-artifacts", {});
	const externalService = new CaptureService({ runtime: f.runtime, allowedCommands: [], codec: () => codec, artifacts: join(dir, "outside"), createDriver: observe });
	const external = await externalService.run(externalRoot, spec, "before");
	assert.match(external.build, /^[a-f0-9]+ clean$/); assert.match(external.warning!, /outside the Git repository/);
}));

test("directory replacement during capture cannot redirect later writes", async () => fixture(async (dir, spec) => {
	const f = fake(), folder = join(dir, "tools", "1"), moved = join(dir, "original"), outside = join(dir, "outside");
	await mkdir(outside); await writeFile(join(outside, "before-full.png"), "untouched");
	const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: dir, codec: () => codec,
		createDriver: async options => {
			const driver = await createDriver({ ...options, playwright: f.playwright });
			await rename(folder, moved); await symlink(outside, folder);
			return driver;
		} });
	await service.run(process.cwd(), spec, "before");
	assert.equal(await readFile(join(outside, "before-full.png"), "utf8"), "untouched");
	assert.deepEqual(await readFile(join(moved, "before-full.png")), Buffer.from([1]));
	await assert.rejects(service.run(process.cwd(), spec, "before"), /escapes/);
}));

test("removing and replacing the open capture directory cannot redirect later writes", async () => fixture(async (dir, spec) => {
	const f = fake(), root = join(dir, "artifacts"), folder = join(root, "tools", "1"), outside = join(dir, "outside");
	await mkdir(outside); await writeFile(join(outside, "before-full.png"), "untouched");
	const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: root, codec: () => codec,
		createDriver: async options => {
			const driver = await createDriver({ ...options, playwright: f.playwright });
			await rm(folder, { recursive: true }); await symlink(outside, folder);
			return driver;
		} });
	await assert.rejects(service.run(process.cwd(), spec, "before"));
	assert.equal(await readFile(join(outside, "before-full.png"), "utf8"), "untouched");
}));

test("multiple screenshots require selection and stale opposite images are not returned", async () => fixture(async (dir, spec) => {
	const f = fake();
	const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: dir, codec: () => codec,
		createDriver: options => createDriver({ ...options, playwright: f.playwright }) });
	const multiple = text.replace("  - screenshot: {name: full}", "  - screenshot: {name: other}\n  - screenshot: {name: full}");
	await writeFile(spec, multiple.replace("diff: {screenshot: full}", "diff: {}"));
	await assert.rejects(service.run(process.cwd(), spec, "before"), /diff.screenshot is required/);
	await writeFile(spec, multiple);
	const before = await service.run(process.cwd(), spec, "before");
	assert.deepEqual(before.images.map(image => image.path), ["before-full.png"]);
	await writeFile(join(dir, "tools", "1", "before-full.png"), "stale");
	const after = await service.run(process.cwd(), spec, "after");
	assert.deepEqual(after.images.map(image => image.path), ["after-full.png"]); assert.equal(after.diff, undefined);
	await assert.rejects(service.check(process.cwd(), spec, answers), /stale image/);
}));

test("cancelled runs invalidate prior evidence and do not produce images", async () => fixture(async (dir, spec) => {
	const f = fake(), controller = new AbortController(); controller.abort();
	const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: dir });
	await assert.rejects(service.run(process.cwd(), spec, "before", undefined, controller.signal), /cancelled/);
	const sidecar = JSON.parse(await readFile(join(dir, "tools", "1", "sidecar.json"), "utf8"));
	assert.equal(sidecar.phases.before.status, "failed"); assert.deepEqual(sidecar.phases.before.images, []);
}));

test("session shutdown stops only its own identity and respects keep and replacements", async () => fixture(async (dir, spec) => {
	const records = new Map<string, OwnedServer>(), stopped: Identity[] = [];
	let serial = 0;
	const runtime = {
		locked: async (_key: string, fn: () => Promise<unknown>) => fn(), now: () => 1, pickPort: async () => 4321,
		assertLaunchSupported: () => {},
		probe: async (_url: string, identity?: Identity) => identity ? { listener: true, healthy: true, owned: true } : { listener: false, healthy: false },
		launch: async () => ({ identity: { pid: ++serial + 10, start: String(serial), boot: "boot" }, logPath: "/log" }),
		verify: async () => true, stop: async (identity: Identity) => { stopped.push(identity); }, logs: async () => "",
		load: async (key: string) => records.get(key) ?? null, save: async (record: OwnedServer) => { records.set(record.key, record); }, remove: async (key: string) => { records.delete(key); },
	} as ServerRuntime;
	const configured = (keep = false) => `feature: tools\nsubphase: 1\ndescription: test\nserver: {start: 'just serve', port: 4321, keep: ${keep}}\nconditions: {entry: /}\nsteps:\n  - screenshot: {name: full}\n`;
	await writeFile(spec, configured());
	const prior = new CaptureServer(runtime, []), server = { start: "just serve", port: 4321, keep: false };
	await prior.start(process.cwd(), spec, server);
	const service = new CaptureService({ runtime, allowedCommands: [], artifacts: dir });
	await service.server(process.cwd(), "start", spec); await service.shutdown(); assert.equal(stopped.length, 0);
	await prior.stop(process.cwd(), spec, server); stopped.length = 0;
	await service.server(process.cwd(), "start", spec);
	const key = JSON.stringify([process.cwd(), spec]), record = records.get(key)!;
	record.identity = { pid: 999, start: "replacement", boot: "boot" };
	await service.shutdown(); assert.equal(stopped.length, 0);
	await prior.stop(process.cwd(), spec, server);
	await writeFile(spec, configured(true)); stopped.length = 0;
	await service.server(process.cwd(), "start", spec); await service.shutdown(); assert.equal(stopped.length, 0);
	await prior.stop(process.cwd(), spec, { ...server, keep: true }); stopped.length = 0;
	await writeFile(spec, configured()); await service.server(process.cwd(), "start", spec); await service.shutdown();
	assert.equal(stopped.length, 1); assert.equal(records.size, 0);
}));

test("URL-mode stop reports no stop and retains the session-owned server for shutdown", async () => fixture(async (dir, spec) => {
	const records = new Map<string, OwnedServer>(), stopped: Identity[] = [], probed: string[] = [];
	let verified = true, serial = 0;
	const runtime = {
		locked: async (_key: string, fn: () => Promise<unknown>) => fn(), now: () => 1, pickPort: async () => 4321,
		assertLaunchSupported: () => {},
		probe: async (url: string, identity?: Identity) => {
			probed.push(url);
			return identity ? { listener: true, healthy: true, owned: true } : { listener: url.startsWith("http://external.example"), healthy: url.startsWith("http://external.example") };
		},
		launch: async () => ({ identity: { pid: ++serial + 10, start: String(serial), boot: "boot" }, logPath: "/log" }),
		verify: async () => verified, stop: async (identity: Identity) => { stopped.push(identity); }, logs: async () => "",
		load: async (key: string) => records.get(key) ?? null, save: async (record: OwnedServer) => { records.set(record.key, record); }, remove: async (key: string) => { records.delete(key); },
	} as ServerRuntime;
	const configured = (keep: boolean) => text.replace("  url: http://127.0.0.1:1234", `  start: just serve\n  port: 4321\n  keep: ${keep}`);
	const external = text.replace("http://127.0.0.1:1234", "http://external.example:3000");
	const service = new CaptureService({ runtime, allowedCommands: [], artifacts: dir });
	for (const keep of [false, true]) {
		await writeFile(spec, configured(keep));
		await service.server(process.cwd(), "start", spec);
		const record = [...records.values()][0];
		await writeFile(spec, external);
		assert.deepEqual(await service.server(process.cwd(), "start", spec), { url: "http://external.example:3000", alive: true, uptime: null, logs: null });
		assert.deepEqual(await service.server(process.cwd(), "stop", spec), { stopped: false });
		assert.equal(stopped.length, 0); assert.equal(records.size, 1);
		await service.shutdown();
		assert.deepEqual(stopped, keep ? [] : [record.identity]);
		assert.equal(records.size, keep ? 1 : 0);
		records.clear(); stopped.length = 0;
	}
	await writeFile(spec, configured(false)); await service.server(process.cwd(), "start", spec);
	await writeFile(spec, external); verified = false;
	assert.deepEqual(await service.server(process.cwd(), "stop", spec), { stopped: false });
	await assert.rejects(service.shutdown(), /ownership cannot be verified/);
	assert.equal(stopped.length, 0); assert.equal(records.size, 1);
	assert.ok(probed.includes("http://external.example:3000/ready"));
}));

// An external URL has no ownership record, so its health check and capture run take no ownership lock.
// A managed server keeps its record operations under that lock and fails closed while another run holds it.
test("URL-mode health check and capture run work without the ownership lock while managed records keep using it", async () => fixture(async (dir, spec) => {
	const f = fake(), events: string[] = [], records = new Map<string, OwnedServer>(), key = JSON.stringify([process.cwd(), spec]); let held = true;
	const runtime = {
		locked: async (lockKey: string, fn: () => Promise<unknown>) => {
			events.push(`lock ${lockKey}`);
			if (held) throw new Error(`Server record is locked: ${lockKey}; inspect the stale lock before removing it`);
			return fn();
		},
		now: () => Date.now(), sleep: async () => {}, pickPort: async () => 4321, assertLaunchSupported: () => {},
		probe: async (url: string, identity?: Identity) => identity ? { listener: true, healthy: true, owned: true } : { listener: url.startsWith("http://127.0.0.1:1234"), healthy: url.startsWith("http://127.0.0.1:1234") },
		verify: async () => true, stop: async (_identity: Identity) => {}, logs: async () => "",
		launch: async () => ({ identity: { pid: 11, start: "run", boot: "boot" }, logPath: "/log" }),
		load: async (loadKey: string) => { events.push(`load ${loadKey}`); return records.get(loadKey) ?? null; },
		save: async (record: OwnedServer) => { events.push(`save ${record.key}`); records.set(record.key, record); },
		remove: async (removeKey: string) => { events.push(`remove ${removeKey}`); },
	} as ServerRuntime;
	const service = new CaptureService({ runtime, allowedCommands: [], codec: () => codec, artifacts: dir, createDriver: options => createDriver({ ...options, playwright: f.playwright }) });
	await writeFile(spec, text); // an external URL: nothing to record or lock
	assert.equal((await service.server(process.cwd(), "start", spec)).alive, true);
	assert.match((await service.run(process.cwd(), spec, "before")).url, /127\.0\.0\.1:1234/);
	assert.deepEqual(events, []); // a stale lock left by another run does not stop it
	// The same contention still stops a managed server, whose record work must stay under the lock.
	await writeFile(spec, text.replace("  url: http://127.0.0.1:1234", "  start: just serve\n  port: 4321"));
	await assert.rejects(service.server(process.cwd(), "start", spec), /Server record is locked/);
	assert.deepEqual(events, [`lock ${key}`]); // the managed path still asks for the ownership lock
	held = false; // this fixture releases only the contention it created itself
	await service.server(process.cwd(), "start", spec);
	assert.deepEqual(events, [`lock ${key}`, `lock ${key}`, `load ${key}`, `save ${key}`]);
	await service.shutdown(); // session cleanup keeps its record operations on the lock too
	assert.deepEqual(events, [`lock ${key}`, `lock ${key}`, `load ${key}`, `save ${key}`, `lock ${key}`, `load ${key}`, `remove ${key}`]);
}));

test("CLI refuses automatic server startup without invoking the launcher", { timeout: 30000 }, async () => fixture(async (dir, spec) => {
	const bin = join(dir, "bin"), marker = join(dir, "launcher-ran");
	await mkdir(bin);
	await writeFile(join(bin, "just"), `#!/bin/sh\nprintf invoked > '${marker}'\n`); await chmod(join(bin, "just"), 0o755);
	await writeFile(spec, `feature: tools\nsubphase: 1\ndescription: test\nserver: {start: 'just serve', port: auto}\nconditions: {entry: /}\nsteps:\n  - screenshot: {name: full}\n`);
	const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
	const run = async (action: string) => promisify(execFile)(process.execPath, [cli, "server", action, spec], { cwd: process.cwd(), env: { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}` }, timeout: 10000 });
	await assert.rejects(run("start"), /Automatic server launch is unavailable/);
	await assert.rejects(readFile(marker), { code: "ENOENT" });
	await assert.rejects(run("status"), /No ownership record/);
}));

test("CLI delegates arguments to the shared service and rejects bad actions", async () => {
	const calls: unknown[] = [];
	const service = { server: async (...args: unknown[]) => { calls.push(args); return { alive: true }; } } as unknown as CaptureService;
	assert.deepEqual(await main(["server", "status", "spec.yaml", "8"], "/work", service), { alive: true });
	assert.deepEqual(calls, [["/work", "status", "spec.yaml", 8]]);
	await assert.rejects(main(["server", "bad", "x"], "/work", service), /Usage/);
});

test("CLI run forwards optional package directory and preserves existing invocations", async () => {
	const calls: unknown[] = [];
	const service = { run: async (...args: unknown[]) => { calls.push(args); return { ok: true, images: [] }; } } as unknown as CaptureService;
	await main(["run", "before", "spec.yaml"], "/work", service);
	await main(["run", "after", "spec.yaml", "label", "--package-directory", "packages/web"], "/work", service);
	await main(["run", "before", "spec.yaml", "--package-directory", "/absolute"], "/work", service);
	assert.deepEqual(calls, [["/work", "spec.yaml", "before", undefined, undefined, undefined], ["/work", "spec.yaml", "after", "label", undefined, "packages/web"], ["/work", "spec.yaml", "before", undefined, undefined, "/absolute"]]);
	await assert.rejects(main(["run", "before", "spec.yaml", "--package-directory"], "/work", service), /Usage.*--package-directory/);
	await assert.rejects(main(["run", "before", "spec.yaml", "--package-directory", "a", "--package-directory", "b"], "/work", service), /Usage/);
});

test("capture_run keeps credentials out of the sidecar and response url but gives the driver the configured url", async () => fixture(async (dir, spec) => {
	await writeFile(spec, text.replace("http://127.0.0.1:1234", "http://user:p@ss@127.0.0.1:1234"));
	const f = fake(); const baseUrls: string[] = [];
	const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: dir, codec: () => codec,
		createDriver: options => { baseUrls.push(options.baseUrl); return createDriver({ ...options, playwright: f.playwright }); } });
	const result = await service.run(process.cwd(), spec, "before");
	assert.deepEqual(baseUrls, ["http://user:p@ss@127.0.0.1:1234"]);
	assert.equal(result.url, "http://127.0.0.1:1234");
	const sidecar = await readFile(join(dir, "tools", "1", "sidecar.json"), "utf8");
	assert.equal(JSON.parse(sidecar).phases.before.url, "http://127.0.0.1:1234");
	assert.doesNotMatch(sidecar + JSON.stringify(result), /user|p@ss/);
}));

test("a screenshot error embedding a credentialed URL is redacted in the outcome and sidecar", async () => fixture(async (dir, spec) => {
	const f = fake(), folder = join(dir, "tools", "1");
	const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: dir, codec: () => codec,
		createDriver: options => createDriver({ ...options, playwright: f.playwright }) });
	f.page.screenshot = async () => { throw new Error("failed at http://user:s3cret@localhost:3000/page"); };
	const outcome = await service.run(process.cwd(), spec, "before").then(value => JSON.stringify(value), (e: unknown) => String((e as Error).message));
	assert.match(outcome, /http:\/\/localhost:3000\/page/);
	assert.doesNotMatch(outcome, /s3cret/);
	const raw = await readFile(join(folder, "sidecar.json"), "utf8");
	assert.doesNotMatch(raw, /s3cret/);
	assert.equal(JSON.parse(raw).phases.before.outcomes[0].error, "failed at http://localhost:3000/page");
}));

async function exists(path: string) { try { await readFile(path); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EISDIR"; } }
const badSpec = (conditions: string) => text.replace("conditions: {entry: /app, viewport: 100x100}", `conditions: ${conditions}`);
test("an invalid condition rejects capture_run before, after and capture_check identically with no launch or artifacts", async () => fixture(async (dir, spec) => {
	await writeFile(spec, badSpec("{theme: default}"));
	const f = fake();
	const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: dir, codec: () => codec, createDriver: options => createDriver({ ...options, playwright: f.playwright }) });
	const attempts: Array<() => Promise<unknown>> = [() => service.run(process.cwd(), spec, "before"), () => service.run(process.cwd(), spec, "after"), () => service.check(process.cwd(), spec, answers)];
	const messages: string[] = [];
	for (const attempt of attempts) await attempt().then(() => assert.fail("expected rejection"), (error: Error) => messages.push(error.message));
	assert.deepEqual(messages, Array(3).fill("conditions.theme must be light or dark"));
	assert.equal(f.launches(), 0); assert.deepEqual(f.calls, []);
	assert.equal(await exists(join(dir, "tools")), false);
}));
test("a valid earlier phase survives a later run rejected for a bad condition", async () => fixture(async (dir, spec) => {
	const f = fake();
	const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: dir, codec: () => codec, createDriver: options => createDriver({ ...options, playwright: f.playwright }) });
	assert.equal((await service.run(process.cwd(), spec, "before")).ok, true);
	const sidecarPath = join(dir, "tools", "1", "sidecar.json"), before = await readFile(sidecarPath, "utf8");
	await writeFile(spec, badSpec("{entry: /app, viewport: 100x100, clock: nope}"));
	await assert.rejects(service.run(process.cwd(), spec, "after"), /^Error: conditions\.clock must be a valid date$/);
	assert.equal(await readFile(sidecarPath, "utf8"), before);
	assert.equal(f.launches(), 1);
	assert.equal(await exists(join(dir, "tools", "1", "after-full.png")), false);
}));
test("capture_server start, stop, status and logs ignore an invalid condition", async () => fixture(async (dir, spec) => {
	await writeFile(spec, badSpec("{theme: default}"));
	const f = fake();
	const service = new CaptureService({ runtime: f.runtime, allowedCommands: [], artifacts: dir, codec: () => codec, createDriver: options => createDriver({ ...options, playwright: f.playwright }) });
	// An external url has no ownership record, so none of these four actions can reject on a condition.
	assert.equal(((await service.server(process.cwd(), "start", spec)) as { alive: boolean }).alive, true);
	assert.equal(((await service.server(process.cwd(), "status", spec)) as { alive: boolean }).alive, true);
	assert.deepEqual(await service.server(process.cwd(), "stop", spec), { stopped: false });
	assert.deepEqual(await service.server(process.cwd(), "logs", spec), { logs: null });
	assert.equal(f.launches(), 0);
	await assert.rejects(service.run(process.cwd(), spec, "before"), /conditions\.theme must be light or dark/);
}));
