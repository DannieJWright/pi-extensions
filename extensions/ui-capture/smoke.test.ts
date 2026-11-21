import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CaptureService } from "./capture.ts";
import { createDriver, gitRoot, resolvePlaywright } from "./driver.ts";
import { withCanvasCodec, type Pixels } from "./diff.ts";
import type { ServerRuntime } from "./server.ts";

// Opt in with UI_CAPTURE_SMOKE=1; Playwright and its Chromium must be installed in the selected project.
// UI_CAPTURE_SMOKE_NO_SANDBOX=1 is only for environments that prohibit nested browser sandboxes.
test("real browser after capture diffs images independently of the application's CSP", async t => {
	if (process.env.UI_CAPTURE_SMOKE !== "1") { t.skip("set UI_CAPTURE_SMOKE=1 to run the real browser smoke test"); return; }
	const root = await gitRoot(process.cwd());
	let playwright: any;
	try { playwright = await resolvePlaywright(root, {}, process.env.UI_CAPTURE_PLAYWRIGHT_DIR); }
	catch (error) { if (/Playwright not found/.test(String(error))) { t.skip("Playwright does not resolve"); return; } throw error; }
	if (process.env.UI_CAPTURE_SMOKE_NO_SANDBOX === "1") {
		const chromium = (playwright.chromium ? playwright : playwright.default).chromium;
		playwright = { chromium: { launch: (options: any) => chromium.launch({ ...options, chromiumSandbox: false, args: ["--no-sandbox"] }) } };
	}
	let color = "red";
	const server = createServer((_req, res) => {
		res.setHeader("content-type", "text/html");
		res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'");
		res.end(`<!doctype html><body><div id="ready">Loading</div><div id="target" style="position:absolute;left:40px;top:40px;width:40px;height:30px;background:${color}"></div><script>setTimeout(() => document.querySelector('#ready').textContent = 'Ready', 50)</script></body>`);
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const address = server.address(); if (!address || typeof address === "string") throw new Error("server did not bind");
	const dir = await mkdtemp(join(tmpdir(), "capture-smoke-"));
	const spec = join(dir, "spec.yaml"), artifacts = join(dir, "artifacts");
	const url = `http://127.0.0.1:${address.port}`;
	const text = `feature: smoke\nsubphase: 1\ndescription: CSP smoke\nserver:\n  url: ${url}\n  ready: {selector: '#ready', not_text: Loading, timeout: 5}\nconditions: {entry: /, viewport: 200x150}\nsteps:\n  - screenshot: {name: target, target: '#target', padding: 5}\ndiff:\n  screenshot: target\n  regions: {target: {target: '#target'}}\n`;
	let mask: Pixels | undefined, pages = 0, pageUrl = "", consoleErrors: string[] = [];
	const runtime = { locked: async (_key: string, fn: () => Promise<unknown>) => fn(), now: () => Date.now(), probe: async () => ({ healthy: true, listener: true }) } as ServerRuntime;
	try {
		await writeFile(spec, text);
		const service = new CaptureService({ runtime, allowedCommands: [], artifacts, createDriver: async options => {
			const driver = await createDriver({ ...options, playwright });
			const close = driver.close.bind(driver);
			driver.close = async () => {
				try {
					if (options.phase === "after") {
						pages = driver.context.pages().length; pageUrl = driver.page.url(); consoleErrors = [...driver.consoleErrors];
						const png = await readFile(join(artifacts, "smoke", "1", "diff-target.png")).catch(() => undefined);
						if (png) mask = await withCanvasCodec(driver.page, codec => codec.decode(png));
					}
				} finally { await close(); }
			};
			return driver;
		} });
		const before = await service.run(root, spec, "before");
		assert.equal(before.ok, true);
		color = "blue";
		const after = await service.run(root, spec, "after");
		assert.equal(after.ok, true);
		const diff = after.diff as any;
		assert.deepEqual(diff.regions.target, { before: { x: 5, y: 5, width: 40, height: 30 }, after: { x: 5, y: 5, width: 40, height: 30 }, moved: false, differing: 1200, total: 1200, percent: 100 });
		assert.deepEqual(after.images.map(image => image.path), ["before-target.png", "after-target.png", "diff-target.png"]);
		assert.ok(mask); assert.equal(mask.width, 50); assert.equal(mask.height, 40);
		assert.deepEqual([...mask.data.slice(0, 4)], [0, 0, 0, 0]);
		assert.deepEqual([...mask.data.slice((5 * mask.width + 5) * 4, (5 * mask.width + 5) * 4 + 4)], [255, 0, 0, 255]);
		assert.equal(mask.data.filter((_, i) => i % 4 === 3 && mask!.data[i] === 255).length, 1200);
		assert.equal(pages, 1); assert.equal(pageUrl, `${url}/`); assert.deepEqual(consoleErrors, []);
		const sidecar = JSON.parse(await readFile(join(artifacts, "smoke", "1", "sidecar.json"), "utf8"));
		assert.equal(sidecar.phases.after.status, "success"); assert.equal(sidecar.diff.regions.target.differing, 1200);
	} finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});
