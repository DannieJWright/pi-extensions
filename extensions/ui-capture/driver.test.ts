import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDriver, gitRoot, resolvePlaywright } from "./driver.ts";
import { redactUrl as redact } from "./redact.ts";
import type { CaptureSpec } from "./spec.ts";

async function pkg(root: string, dir: string, name: string, source: string) {
	const path = join(root, dir, "node_modules", name); await mkdir(path, { recursive: true });
	await writeFile(join(path, "package.json"), JSON.stringify({ main: "index.cjs" })); await writeFile(join(path, "index.cjs"), source);
}
test("Playwright resolution anchors precedence and separates missing from load failure", async () => {
	const root = await mkdtemp(join(tmpdir(), "capture-anchor-"));
	try {
		await pkg(root, "", "playwright", "module.exports = { marker: 'root' }");
		await pkg(root, "app", "@playwright/test", "module.exports = { marker: 'test' }");
		await pkg(root, "explicit", "playwright", "module.exports = { marker: 'explicit' }");
		assert.equal((await resolvePlaywright(root, {})).default.marker, "root");
		// Node's resolution searches ancestors of the chosen anchor for playwright before trying @playwright/test.
		assert.equal((await resolvePlaywright(root, { cwd: "app" })).default.marker, "root");
		assert.equal((await resolvePlaywright(root, { cwd: "app" }, "explicit")).default.marker, "explicit");
		const isolated = await mkdtemp(join(tmpdir(), "capture-isolated-"));
		try {
			await pkg(isolated, "app", "@playwright/test", "module.exports = { marker: 'test' }");
			assert.equal((await resolvePlaywright(isolated, { cwd: "app" })).default.marker, "test");
			await assert.rejects(resolvePlaywright(isolated, {}, "empty"), /Playwright not found.*dev dependency/);
		} finally { await rm(isolated, { recursive: true, force: true }); }
		await pkg(root, "broken", "playwright", "throw new Error('module exploded')");
		await pkg(root, "broken", "@playwright/test", "module.exports = {} ");
		await assert.rejects(resolvePlaywright(root, {}, "broken"), /Resolved playwright.*failed to load.*module exploded/);
	} finally { await rm(root, { recursive: true, force: true }); }
});
test("git root uses the session directory, not the package anchor", async () => {
	assert.equal(await gitRoot(join(process.cwd(), "extensions/ui-capture")), process.cwd());
});
function spec(overrides: Partial<CaptureSpec> = {}): CaptureSpec {
	return { feature: "x", subphase: 1, description: "x", server: { ready: { selector: "#ready", not_text: "Loading", timeout: 2 } }, conditions: { entry: "/app", viewport: "300x200", locale: "en", theme: "dark", theme_storage: { key: "theme" }, storage: { token: "abc" }, permissions: ["clipboard-write"], clock: "2026-01-01T00:00:00Z" }, steps: [], hash: "x", ...overrides };
}
function fake() {
	const calls: any[] = [], events: Record<string, any> = {}, boxes: Record<string, any> = { "#area": { x: 30, y: 40, width: 20, height: 10 }, "#region": { x: 35, y: 42, width: 4, height: 3 } };
	let gotoFailures: Error[] = [], gateError: Error | undefined;
	const page: any = {
		on: (name: string, fn: any) => { events[name] = fn; },
		goto: async (url: string, options: any) => { calls.push(["goto", url, options]); if (gotoFailures.length) throw gotoFailures.shift(); },
		url: () => "http://example/app", waitForFunction: async (_fn: any, text: string, opts: any) => { calls.push(["not_text", text, opts]); if (gateError) throw gateError; },
		locator: (selector: string) => ({ count: async () => boxes[selector] ? 1 : 0, boundingBox: async () => boxes[selector] ?? null, waitFor: async (opts: any) => { calls.push(["wait", selector, opts]); }, fill: async (value: string) => calls.push(["fill", selector, value]), focus: async () => calls.push(["focus", selector]) }),
		evaluate: async () => ({ scrollX: 10, scrollY: 20, width: 600, height: 500 }),
		screenshot: async (options: any) => { calls.push(["screenshot", options]); return Buffer.from("png"); }, clock: { install: async (options: any) => calls.push(["clock", options]) }, keyboard: { press: async (key: string) => calls.push(["press", key]) }, waitForTimeout: async () => {},
	};
	const context = { addInitScript: async (fn: any, input: any) => calls.push(["init", input, fn]), newPage: async () => page, close: async () => calls.push(["context.close"]) };
	const browser = { newContext: async (opts: any) => { calls.push(["context", opts]); return context; }, close: async () => calls.push(["browser.close"]) };
	const failures: Error[] = [];
	const playwright = { chromium: { launch: async (opts: any) => { calls.push(["launch", opts]); if (failures.length) throw failures.shift(); return browser; } } };
	return { calls, events, boxes, page, context, browser, playwright, failures, setGotoFailures: (errors: Error[]) => { gotoFailures = errors; }, setGateError: (error: Error) => { gateError = error; } };
}
const opts = (f: ReturnType<typeof fake>, s = spec()) => ({ root: process.cwd(), spec: s, baseUrl: "http://example", outputDir: "/tmp", phase: "before" as const, playwright: f.playwright });
test("createDriver accepts the CommonJS Playwright default export", async () => {
	const f = fake();
	const driver = await createDriver({ ...opts(f), playwright: { default: f.playwright } });
	assert.equal(f.calls[0][0], "launch");
	await driver.close();
});
test("conditions, EPERM-only sandbox retry, hydration, navigation retry and cleanup", async () => {
	const f = fake(); f.failures.push(new Error("launch EPERM")); f.setGotoFailures([new Error("Execution context was destroyed by navigation")]);
	const d = await createDriver(opts(f));
	assert.deepEqual(f.calls.filter(c => c[0] === "launch").map(c => c[1]), [{ chromiumSandbox: true }, { chromiumSandbox: false, args: ["--no-sandbox"] }]);
	assert.deepEqual(f.calls.find(c => c[0] === "context")[1], { deviceScaleFactor: 1, viewport: { width: 300, height: 200 }, locale: "en", colorScheme: "dark", permissions: ["clipboard-write"] });
	assert.deepEqual(f.calls.find(c => c[0] === "init")[1], { storage: { token: "abc" }, theme: "dark", themeKey: "theme" });
	assert.equal(f.calls.find(c => c[0] === "clock")[1].time.toISOString(), "2026-01-01T00:00:00.000Z");
	assert.equal(f.calls.filter(c => c[0] === "goto").length, 2);
	assert.equal(f.calls.find(c => c[0] === "goto")[1], "http://example/app");
	assert.deepEqual(f.calls.find(c => c[0] === "not_text").slice(1), ["Loading", { timeout: 2000 }]);
	f.events.console({ type: () => "error", text: () => "bad" }); f.events.console({ type: () => "log", text: () => "ok" }); assert.deepEqual(d.consoleErrors, ["bad"]);
	await d.perform("fill", "#field", { verb: "fill", target: "#field", value: "yes" }); await d.perform("focus", "#field", { verb: "focus", target: "#field" });
	await d.close(); assert.deepEqual(f.calls.slice(-2).map(c => c[0]), ["context.close", "browser.close"]);
});
test("theme and storage init script applies the pinned values before the app loads", async () => {
	const f = fake(); const d = await createDriver(opts(f)); const init = f.calls.find(c => c[0] === "init");
	const oldStorage = globalThis.localStorage, oldDocument = globalThis.document; const values: Record<string, string> = {};
	const document = { documentElement: { style: { colorScheme: "" } }, addEventListener: () => {} };
	try {
		(globalThis as any).localStorage = { setItem: (key: string, value: string) => { values[key] = value; } };
		(globalThis as any).document = document;
		init[2](init[1]);
		assert.deepEqual(values, { token: "abc", theme: "dark" }); assert.equal(document.documentElement.style.colorScheme, "dark");
	} finally { (globalThis as any).localStorage = oldStorage; (globalThis as any).document = oldDocument; await d.close(); }
});
test("hydration waits while loading text is present and completes after it disappears", async () => {
	const f = fake(); let polls = 0;
	f.page.waitForFunction = async (predicate: (text: string) => boolean, text: string) => {
		const previous = globalThis.document;
		try {
			(globalThis as any).document = { body: { innerText: "Loading" } };
			assert.equal(predicate(text), false); polls++;
			(globalThis as any).document.body.innerText = "Ready";
			assert.equal(predicate(text), true); polls++;
		} finally { (globalThis as any).document = previous; }
	};
	const d = await createDriver(opts(f)); assert.equal(polls, 2); await d.close();
});
test("relative output paths resolve from the session's git root", async () => {
	const dir = await mkdtemp(join(process.cwd(), "capture-driver-"));
	try {
		const f = fake(); const d = await createDriver({ ...opts(f), root: join(process.cwd(), "extensions/ui-capture"), outputDir: dir.slice(process.cwd().length + 1) });
		await d.screenshot();
		assert.equal(await readFile(join(dir, "before.png"), "utf8"), "png");
		assert.equal(f.calls.find(c => c[0] === "screenshot")[1].path, undefined);
		await d.close();
	} finally { await rm(dir, { recursive: true, force: true }); }
});
test("cancellation during hydration closes browser and context", async () => {
	const f = fake(), controller = new AbortController();
	f.page.waitForFunction = async () => { controller.abort(); throw new Error("browser closed"); };
	await assert.rejects(createDriver({ ...opts(f), signal: controller.signal }), /browser closed/);
	assert.equal(f.calls.filter(c => c[0] === "browser.close").length, 1);
	assert.equal(f.calls.filter(c => c[0] === "context.close").length, 1);
});

test("non EPERM launch failures do not retry and hydration timeout cleans resources", async () => {
	const f = fake(); f.failures.push(new Error("missing browser")); await assert.rejects(createDriver(opts(f)), /missing browser/); assert.equal(f.calls.length, 1);
	const g = fake(); g.setGateError(new Error("Timeout 2000ms exceeded")); await assert.rejects(createDriver(opts(g)), /Timeout 2000ms/); assert.deepEqual(g.calls.slice(-2).map(c => c[0]), ["context.close", "browser.close"]);
});
test("close reports both context and browser failures and attempts both closes", async () => {
	const f = fake(), driver = await createDriver(opts(f));
	f.context.close = async () => { f.calls.push(["context.close"]); throw new Error("context failed"); };
	f.browser.close = async () => { f.calls.push(["browser.close"]); throw new Error("browser failed"); };
	await assert.rejects(driver.close(), /context failed; cleanup failed: browser failed/);
	assert.deepEqual(f.calls.slice(-2).map(c => c[0]), ["context.close", "browser.close"]);
});
test("driver startup retains the capture error and reports both cleanup failures", async () => {
	const f = fake(); f.setGateError(new Error("hydration failed"));
	f.context.close = async () => { f.calls.push(["context.close"]); throw new Error("context failed"); };
	f.browser.close = async () => { f.calls.push(["browser.close"]); throw new Error("browser failed"); };
	await assert.rejects(createDriver(opts(f)), /hydration failed; cleanup failed: context failed; cleanup failed: browser failed/);
	assert.deepEqual(f.calls.slice(-2).map(c => c[0]), ["context.close", "browser.close"]);
});
test("screenshot bounds transform viewport, full page and padded target coordinates", async () => {
	const dir = await mkdtemp(join(tmpdir(), "capture-driver-"));
	try {
	const f = fake(); const s = spec({ diff: { regions: { selected: { target: "#region" }, missing: { target: "#none" }, fixed: [1, 2, 3, 4] } } });
	const d = await createDriver({ ...opts(f, s), outputDir: dir });
	const viewport = await d.screenshot({ name: "viewport" });
	const full = await d.screenshot({ name: "full", full_page: true });
	const target = await d.screenshot({ name: "target", target: "#area", padding: 5 });
	assert.deepEqual(viewport.bounds, { selected: { x: 35, y: 42, width: 4, height: 3 }, missing: null });
	assert.deepEqual(full.bounds.selected, { x: 45, y: 62, width: 4, height: 3 });
	assert.deepEqual(target.bounds.selected, { x: 10, y: 7, width: 4, height: 3 });
	assert.deepEqual(f.calls.filter(c => c[0] === "screenshot")[2][1].clip, { x: 35, y: 55, width: 30, height: 20 });
	await assert.rejects(d.screenshot({ target: "#none" }), /exactly one/); await d.close();
	} finally { await rm(dir, { recursive: true, force: true }); }
});

const launches = (f: ReturnType<typeof fake>) => f.calls.filter(c => c[0] === "launch");
// Guards against over-broad matching: this case passes on the pre-change code too.
test("launch failures without a sandbox signal do not retry: [object Object] and missing executable", async () => {
	for (const failure of [{ detail: "x" }, new Error("Executable doesn't exist at /tmp/chromium")]) {
		const f = fake(); f.failures.push(failure as Error);
		await assert.rejects(createDriver(opts(f)));
		assert.equal(launches(f).length, 1);
	}
});
// Fails before the change: the object's code is EPERM but its text lacks the word.
test("an object error with code EPERM and no EPERM text retries once without the sandbox", async () => {
	const f = fake(); f.failures.push({ code: "EPERM", message: "denied" } as unknown as Error);
	const driver = await createDriver(opts(f));
	assert.equal(launches(f).length, 2);
	assert.deepEqual(launches(f)[1][1], { chromiumSandbox: false, args: ["--no-sandbox"] });
	await driver.close();
});
test("sandbox failure texts retry exactly once", async () => {
	for (const text of ["No usable sandbox!", "Sandboxing failed", "Operation not permitted"]) {
		const f = fake(); f.failures.push(new Error(text));
		const driver = await createDriver(opts(f));
		assert.equal(launches(f).length, 2);
		await driver.close();
	}
});
test("null and undefined launch rejections are rethrown without a retry or TypeError", async () => {
	for (const failure of [null, undefined]) {
		const f = fake(); f.failures.push(failure as unknown as Error);
		await assert.rejects(createDriver(opts(f)), error => error === failure);
		assert.equal(launches(f).length, 1);
	}
});
test("a failed sandbox fallback reports both launch errors with URLs redacted", async () => {
	const f = fake(); f.failures.push(new Error("first EPERM http://user:pw1@a.test/x"), new Error("second http://user:pw2@b.test/y"));
	await assert.rejects(createDriver(opts(f)), (error: Error) => {
		assert.equal(error.message, `${redact("first EPERM http://user:pw1@a.test/x")}; sandbox fallback failed: ${redact("second http://user:pw2@b.test/y")}`);
		assert.doesNotMatch(error.message, /pw1|pw2/);
		return true;
	});
	assert.equal(launches(f).length, 2);
});
test("after a fallback launch, closing the driver closes the context and browser", async () => {
	const f = fake(); f.failures.push(new Error("EPERM"));
	const driver = await createDriver(opts(f));
	await driver.close();
	assert.deepEqual(f.calls.slice(-2).map(c => c[0]), ["context.close", "browser.close"]);
});
test("a numeric clock is passed to the page as the same instant", async () => {
	const f = fake();
	const d = await createDriver(opts(f, spec({ conditions: { clock: 1767225600000 } })));
	assert.equal(f.calls.find(c => c[0] === "clock")[1].time.toISOString(), "2026-01-01T00:00:00.000Z");
	await d.close();
});
