import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { redactUrl } from "./redact.ts";
import { inspectDom } from "./dom.ts";
import { publishArtifact, type ArtifactLocation } from "./artifacts.ts";
import { safeComponent, type CaptureSpec, type Step, type StepVerb } from "./spec.ts";
import type { Box, CaptureDriver, ElementSnapshot } from "./steps.ts";
import type { ShotEvidence } from "./diff.ts";

export async function gitRoot(sessionDirectory: string): Promise<string> {
	const { stdout } = await promisify(execFile)("git", ["rev-parse", "--show-toplevel"], { cwd: sessionDirectory });
	return stdout.trim();
}

// A package directory is an anchor, not a path to the Playwright module itself.
export async function resolvePlaywright(root: string, server: Record<string, unknown>, packageDirectory?: string): Promise<any> {
	const anchor = resolve(root, packageDirectory ?? (typeof server.cwd === "string" ? server.cwd : "."));
	const require = createRequire(join(anchor, "package.json"));
	for (const name of ["playwright", "@playwright/test"]) {
		let path: string;
		try { path = require.resolve(name); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") continue;
			throw new Error(`Could not resolve ${name} from ${anchor}: ${String(error)}`);
		}
		try { return await import(pathToFileURL(path).href); }
		catch (error) { throw new Error(`Resolved ${name} at ${path}, but failed to load: ${String(error)}`); }
	}
	throw new Error(`Playwright not found from ${anchor}; install the playwright or @playwright/test dev dependency`);
}

function viewport(value: unknown): { width: number; height: number } | undefined {
	if (value === undefined) return undefined;
	const match = typeof value === "string" ? /^(\d+)x(\d+)$/.exec(value) : null;
	if (!match || !Number(match[1]) || !Number(match[2])) throw new Error("conditions.viewport must be WIDTHxHEIGHT");
	return { width: Number(match[1]), height: Number(match[2]) };
}
function object(value: unknown, name: string): Record<string, unknown> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be a mapping`);
	return value as Record<string, unknown>;
}
function navigationError(error: unknown): boolean { return /execution context was destroyed|navigation|cannot find context/i.test(String(error)); }
const errorText = (error: unknown) => redactUrl(error instanceof Error ? error.message : String(error));
export function combineCleanupErrors(error: unknown, cleanupError: unknown): Error {
	return new AggregateError([error, cleanupError], `${errorText(error)}; cleanup failed: ${errorText(cleanupError)}`);
}
async function closeResources(context: any, closeBrowser: () => Promise<void>): Promise<void> {
	try { if (context) await context.close(); }
	catch (error) {
		try { await closeBrowser(); } catch (cleanupError) { throw combineCleanupErrors(error, cleanupError); }
		throw error;
	}
	await closeBrowser();
}
function wholeBox(box: Box): Box {
	const x = Math.floor(box.x), y = Math.floor(box.y);
	return { x, y, width: Math.ceil(box.x + box.width) - x, height: Math.ceil(box.y + box.height) - y };
}

export class PlaywrightDriver implements CaptureDriver {
	readonly consoleErrors: string[] = [];
	readonly shots: ShotEvidence[] = [];
	readonly browser: any; readonly context: any; readonly page: any; readonly spec: CaptureSpec; readonly baseUrl: string; readonly outputDir: ArtifactLocation; readonly phase: "before" | "after";
	constructor(browser: any, context: any, page: any, spec: CaptureSpec, baseUrl: string, outputDir: ArtifactLocation, phase: "before" | "after") {
		this.browser = browser; this.context = context; this.page = page; this.spec = spec; this.baseUrl = baseUrl; this.outputDir = outputDir; this.phase = phase;
		page.on("console", (message: any) => { if (message.type() === "error") this.consoleErrors.push(redactUrl(message.text())); });
	}
	async open(): Promise<void> {
		const entry = this.spec.conditions.entry ?? "/";
		if (typeof entry !== "string") throw new Error("conditions.entry must be a string");
		const ready = object(this.spec.server.ready, "server.ready");
		const timeout = (typeof ready.timeout === "number" && ready.timeout > 0 ? ready.timeout : 60) * 1000;
		const navigate = async () => {
			await this.page.goto(new URL(entry, this.baseUrl).href, { waitUntil: "load", timeout });
			if (ready.selector !== undefined) {
				if (typeof ready.selector !== "string" || !ready.selector) throw new Error("server.ready.selector must be a string");
				await this.page.locator(ready.selector).waitFor({ state: "visible", timeout });
			}
			if (ready.not_text !== undefined) {
				if (typeof ready.not_text !== "string") throw new Error("server.ready.not_text must be a string");
				await this.page.waitForFunction((text: string) => !document.body?.innerText.includes(text), ready.not_text, { timeout });
			}
		};
		try { await navigate(); } catch (error) { if (!navigationError(error)) throw error; await navigate(); }
	}
	async inspect(selector: string, fields: string[]): Promise<ElementSnapshot[]> { return this.page.evaluate(inspectDom, { selector, fields }); }
	async wait(ms: number): Promise<void> { await this.page.waitForTimeout(ms); }
	now(): number { return Date.now(); }
	async perform(verb: Exclude<StepVerb, "assert" | "read" | "measure">, target: unknown, options: Step): Promise<unknown> {
		if (verb === "screenshot") return this.screenshot(target);
		if (verb === "eval") {
			if (typeof target !== "string") throw new Error("eval requires an expression");
			return this.page.evaluate(target);
		}
		if (typeof target !== "string" || !target) throw new Error(`${verb} requires a string target`);
		if (verb === "goto") { await this.page.goto(new URL(target, this.baseUrl).href, { waitUntil: "load" }); return { url: redactUrl(this.page.url()) }; }
		if (verb === "press") return this.page.keyboard.press(target);
		const locator = this.page.locator(target);
		switch (verb) {
			case "fill": if (typeof options.value !== "string") throw new Error("fill requires a string value"); return locator.fill(options.value);
			case "hover": return locator.hover();
			case "click": return locator.click();
			case "focus": return locator.focus();
			case "scroll_to": return locator.scrollIntoViewIfNeeded();
			case "wait_for": return locator.waitFor({ state: "visible" });
		}
	}
	// Bounds are integer CSS pixels relative to the screenshot's top-left. Device scale is fixed to 1.
	async screenshot(value: unknown = {}): Promise<ShotEvidence> {
		const shot = object(value, "screenshot");
		const name = shot.name === undefined ? undefined : safeComponent(shot.name, "screenshot name");
		const path = `${this.phase}${name ? `-${name}` : ""}.png`;
		const geometry = await this.page.evaluate(() => ({ scrollX: window.scrollX, scrollY: window.scrollY, width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
		let origin = { x: geometry.scrollX, y: geometry.scrollY };
		let clip: Box | undefined;
		if (shot.target !== undefined) {
			if (typeof shot.target !== "string" || !shot.target) throw new Error("screenshot target must be a selector");
			if (shot.full_page === true) throw new Error("screenshot cannot combine target and full_page");
			const locator = this.page.locator(shot.target);
			if (await locator.count() !== 1) throw new Error(`screenshot target must match exactly one element: ${shot.target}`);
			const b = await locator.boundingBox(); if (!b) throw new Error(`missing screenshot target: ${shot.target}`);
			const padding = shot.padding ?? 0;
			if (typeof padding !== "number" || !Number.isFinite(padding) || padding < 0) throw new Error("screenshot padding must be non-negative");
			clip = wholeBox({ x: b.x + geometry.scrollX - padding, y: b.y + geometry.scrollY - padding, width: b.width + 2 * padding, height: b.height + 2 * padding });
			if (clip.x < 0 || clip.y < 0 || clip.width <= 0 || clip.height <= 0 || clip.x + clip.width > geometry.width || clip.y + clip.height > geometry.height) throw new Error("padded screenshot target is out of page bounds");
			origin = { x: clip.x, y: clip.y };
		} else if (shot.full_page === true) origin = { x: 0, y: 0 };
		const regions = object(this.spec.diff?.regions, "diff.regions");
		const bounds: Record<string, Box | null> = {};
		for (const [region, definition] of Object.entries(regions)) {
			if (Array.isArray(definition)) continue; // Fixed coordinates already use the selected image space.
			const target = object(definition, `diff region ${region}`).target;
			if (typeof target !== "string" || !target) throw new Error(`diff region ${region} requires a selector or coordinates`);
			const locator = this.page.locator(target);
			if (await locator.count() !== 1) { bounds[region] = null; continue; }
			const b = await locator.boundingBox();
			bounds[region] = b ? wholeBox({ x: b.x + geometry.scrollX - origin.x, y: b.y + geometry.scrollY - origin.y, width: b.width, height: b.height }) : null;
		}
		const png = await this.page.screenshot({ type: "png", ...(clip ? { clip } : { fullPage: shot.full_page === true }) });
		await publishArtifact(this.outputDir, path, png);
		const evidence = { name, path, bounds }; this.shots.push(evidence); return evidence;
	}
	async close(): Promise<void> { await closeResources(this.context, () => this.browser.close()); }
}

export async function createDriver(options: { root: string; spec: CaptureSpec; baseUrl: string; outputDir: ArtifactLocation; phase: "before" | "after"; packageDirectory?: string; playwright?: any; signal?: AbortSignal }): Promise<PlaywrightDriver> {
	const { spec } = options;
	const root = await gitRoot(options.root);
	const module = options.playwright ?? await resolvePlaywright(root, spec.server, options.packageDirectory);
	const pw = module.chromium ? module : module.default;
	let browser: any;
	try { browser = await pw.chromium.launch({ chromiumSandbox: true }); }
	catch (error) {
		if (!/\bEPERM\b/i.test(String(error))) throw error;
		browser = await pw.chromium.launch({ chromiumSandbox: false, args: ["--no-sandbox"] });
	}
	let context: any, closing: Promise<void> | undefined;
	const closeBrowser = () => closing ??= browser.close();
	const abort = () => { void closeBrowser().catch(() => {}); };
	options.signal?.addEventListener("abort", abort, { once: true });
	try {
		if (options.signal?.aborted) throw new Error("capture cancelled");
		const conditions = spec.conditions, view = viewport(conditions.viewport);
		if (conditions.theme !== undefined && conditions.theme !== "light" && conditions.theme !== "dark") throw new Error("conditions.theme must be light or dark");
		if (conditions.locale !== undefined && typeof conditions.locale !== "string") throw new Error("conditions.locale must be a string");
		if (conditions.permissions !== undefined && (!Array.isArray(conditions.permissions) || !conditions.permissions.every(p => typeof p === "string"))) throw new Error("conditions.permissions must be an array of strings");
		const storage = object(conditions.storage, "conditions.storage");
		if (!Object.values(storage).every(v => typeof v === "string")) throw new Error("conditions.storage values must be strings");
		const themeStorage = object(conditions.theme_storage, "conditions.theme_storage");
		if (themeStorage.key !== undefined && (typeof themeStorage.key !== "string" || !themeStorage.key || !conditions.theme)) throw new Error("theme_storage.key requires a theme and a non-empty key");
		context = await browser.newContext({ deviceScaleFactor: 1, ...(view ? { viewport: view } : {}), ...(conditions.locale ? { locale: conditions.locale } : {}), ...(conditions.theme ? { colorScheme: conditions.theme } : {}), ...(conditions.permissions ? { permissions: conditions.permissions } : {}) });
		await context.addInitScript(({ storage, theme, themeKey }: any) => {
			for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value as string);
			if (themeKey) localStorage.setItem(themeKey, theme);
			if (theme) { const apply = () => { if (document.documentElement) document.documentElement.style.colorScheme = theme; }; apply(); document.addEventListener("DOMContentLoaded", apply, { once: true }); }
		}, { storage, theme: conditions.theme, themeKey: themeStorage.key });
		const page = await context.newPage();
		if (conditions.clock !== undefined) {
			const time = new Date(conditions.clock as string);
			if (Number.isNaN(time.valueOf())) throw new Error("conditions.clock must be a valid date");
			await page.clock.install({ time });
		}
		const driver = new PlaywrightDriver(browser, context, page, spec, options.baseUrl, typeof options.outputDir === "string" ? resolve(root, options.outputDir) : options.outputDir, options.phase);
		await driver.open();
		if (options.signal?.aborted) throw new Error("capture cancelled");
		return driver;
	} catch (error) {
		try { await closeResources(context, closeBrowser); } catch (cleanupError) { throw combineCleanupErrors(error, cleanupError); }
		throw error;
	} finally { options.signal?.removeEventListener("abort", abort); }
}
