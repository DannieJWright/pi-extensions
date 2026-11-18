#!/usr/bin/env node
// before-after-capture runner. Reads a capture spec (YAML), pins the conditions,
// runs the steps, asserts before capture, writes the png and the sidecar.
// Exits nonzero if an assert fails or a target is not rendered.
// Needs Playwright in the project (npm install playwright). Run from the repo root.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseYaml } from "./yaml.mjs";

const exec = promisify(execFile);

export const STEP_VERBS = ["goto", "fill", "press", "hover", "click", "scroll_to", "wait_for", "assert", "screenshot"];

export function parseSpec(text) {
	const doc = parseYaml(text);
	for (const field of ["feature", "subphase", "phase", "description"]) {
		if (doc[field] === undefined) throw new Error(`spec is missing ${field}`);
	}
	if (!Array.isArray(doc.steps) || doc.steps.length === 0) throw new Error("spec has no steps");
	const steps = doc.steps.map((step, n) => {
		if (step === null || typeof step !== "object" || Array.isArray(step)) throw new Error(`step ${n + 1}: expected a verb`);
		const verb = Object.keys(step).find((key) => STEP_VERBS.includes(key));
		if (!verb) throw new Error(`step ${n + 1}: expected one of ${STEP_VERBS.join(", ")}, got ${Object.keys(step).join(", ")}`);
		return { verb, target: step[verb], value: step.value };
	});
	return { ...doc, steps };
}

export async function runSteps(driver, spec) {
	const resolved = [];
	for (const step of spec.steps) {
		if (typeof driver[step.verb] !== "function") throw new Error(`driver has no ${step.verb}`);
		const note = await driver[step.verb](step.target, step.value);
		resolved.push({ verb: step.verb, target: step.target, ...(step.value !== undefined ? { value: step.value } : {}), ok: true, ...(note && typeof note === "object" ? note : {}) });
	}
	return resolved;
}

export async function runSpec(spec, driver, { build = "unknown", outDir }) {
	const dir = outDir ?? join("artifacts", String(spec.feature), String(spec.subphase));
	await mkdir(dir, { recursive: true });
	const resolved = await runSteps(driver, spec);
	const sidecar = {
		feature: spec.feature,
		phase: spec.phase,
		subphase: spec.subphase,
		description: spec.description,
		conditions: spec.conditions,
		build,
		steps: resolved,
		resolved: { url: typeof driver.url === "function" ? driver.url() : undefined, ...(driver.resolved ?? {}) },
	};
	await writeFile(join(dir, "sidecar.json"), `${JSON.stringify(sidecar, null, 2)}\n`);
	return sidecar;
}

export function driverFromPage(page, spec) {
	const base = spec.conditions?.base_url ?? "";
	const locator = (target) => page.locator(target);
	return {
		async goto(target) { await page.goto(base + target); return { url: page.url() }; },
		async fill(target, value) { await locator(target).fill(value); },
		async press(key) { await page.keyboard.press(key); },
		async hover(target) { await locator(target).hover(); },
		async click(target) { await locator(target).click(); },
		async scroll_to(target) { await locator(target).scrollIntoViewIfNeeded(); },
		async wait_for(target) { await locator(target).waitFor(); },
		async assert(target) {
			const count = await locator(target).count();
			if (count === 0) throw new Error(`assert failed: ${target} is not rendered`);
			return { matched: count };
		},
		async screenshot(path) { await page.screenshot({ path }); return { wrote: path }; },
		async close() { await page.context().close(); },
		url: () => page.url(),
	};
}

async function playwrightDriver(spec) {
	let playwright;
	try {
		playwright = await import("playwright");
	} catch {
		throw new Error("playwright is required: npm install playwright");
	}
	const conditions = spec.conditions ?? {};
	const browser = await playwright.chromium.launch({ args: ["--no-sandbox"] });
	const viewport = typeof conditions.viewport === "string" && conditions.viewport.includes("x")
		? { width: Number(conditions.viewport.split("x")[0]), height: Number(conditions.viewport.split("x")[1]) }
		: undefined;
	const context = await browser.newContext({ ...(viewport ? { viewport } : {}), ...(conditions.locale ? { locale: conditions.locale } : {}) });
	const page = await context.newPage();
	if (conditions.clock) {
		try { await page.clock.install({ time: new Date(conditions.clock) }); } catch { /* older playwright: pin in the fixture instead */ }
	}
	const driver = driverFromPage(page, spec);
	const close = driver.close;
	driver.close = async () => { await close(); await browser.close(); };
	return driver;
}

async function currentBuild() {
	try {
		const result = await exec("git", ["rev-parse", "--short", "HEAD"]);
		return result.stdout.trim() || "unknown";
	} catch {
		return "unknown";
	}
}

export async function runCli(argv, driverFactory = playwrightDriver) {
	const args = argv.filter((arg) => arg !== "");
	const specPath = args[0];
	if (!specPath) { console.error("usage: node capture.mjs <spec.yaml> [--build <label>]"); return 2; }
	const buildIndex = args.indexOf("--build");
	const build = buildIndex >= 0 ? args[buildIndex + 1] : await currentBuild();
	let spec;
	try {
		spec = parseSpec(await readFile(specPath, "utf8"));
	} catch (error) {
		console.error(`capture: ${error.message}`);
		return 1;
	}
	const driver = await driverFactory(spec);
	try {
		await runSpec(spec, driver, { build, outDir: dirname(resolve(specPath)) });
	} catch (error) {
		console.error(`capture: ${error.message}`);
		return 1;
	} finally {
		if (typeof driver.close === "function") await driver.close();
	}
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
	process.exitCode = await runCli(process.argv.slice(2));
}
