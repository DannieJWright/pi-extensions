import { redactUrl } from "./redact.ts";
import type { CaptureSpec, Step, StepVerb } from "./spec.ts";

export type Box = { x: number; y: number; width: number; height: number };
export type ElementSnapshot = { box?: Box; attributes?: Record<string, string | null>; computed?: Record<string, string | null>; text?: string | null };
export interface CaptureDriver {
	perform(verb: Exclude<StepVerb, "assert" | "read" | "measure">, target: unknown, options: Step): Promise<unknown>;
	// Snapshots are in document order; boxes use viewport-relative CSS pixels.
	inspect(selector: string, fields: string[]): Promise<ElementSnapshot[]>;
	wait(ms: number): Promise<void>;
	now(): number;
}
export type StepOutcome = { step: Step; ok: boolean; result?: unknown; error?: string; expected?: unknown; actual?: unknown };
export type StepsResult = { outcomes: StepOutcome[]; measured: Record<string, unknown>; read: Record<string, unknown>; ok: boolean };

class CheckFailure extends Error {
	expected: unknown;
	actual: unknown;
	constructor(message: string, expected: unknown, actual: unknown) { super(message); this.expected = expected; this.actual = actual; }
}
const tolerance = 0.5;
const observational = new Set<StepVerb>(["read", "measure", "assert", "wait_for", "goto"]);
const navigationError = (error: unknown) => /execution context was destroyed|navigation|cannot find context/i.test(String(error));
function selector(value: unknown): string {
	if (typeof value !== "string" || !value) throw new Error("selector must be a non-empty string");
	return value;
}
async function elements(driver: CaptureDriver, target: unknown, fields: string[]): Promise<ElementSnapshot[]> {
	const name = selector(target); const found = await driver.inspect(name, fields);
	if (!found.length) throw new Error(`missing selector: ${name}`);
	return found;
}
function one(found: ElementSnapshot[], target: unknown): ElementSnapshot {
	if (found.length !== 1) throw new Error(`expected exactly one element for ${String(target)}, got ${found.length}`);
	return found[0];
}
function box(item: ElementSnapshot): Box {
	if (!item.box || ![item.box.x, item.box.y, item.box.width, item.box.height].every(Number.isFinite)) throw new Error("missing box");
	return item.box;
}
function value(item: ElementSnapshot, step: Step): string {
	let result: string | null | undefined;
	if (typeof step.attribute === "string") result = item.attributes?.[step.attribute];
	else if (typeof step.computed === "string") result = item.computed?.[step.computed];
	else if (step.text === true) result = item.text;
	else throw new Error("read or equals requires attribute, computed, or text");
	if (result === null || result === undefined) throw new Error(`missing ${step.attribute ? `attribute ${step.attribute}` : step.computed ? `computed property ${step.computed}` : "text"}`);
	return result;
}
function requiredFields(step: Step): string[] {
	return [typeof step.attribute === "string" ? `attribute:${step.attribute}` : "", typeof step.computed === "string" ? `computed:${step.computed}` : "", step.text === true ? "text" : ""].filter(Boolean);
}
function positions(items: ElementSnapshot[]): number[] { return items.map(item => box(item).y); }
function sameTop(items: ElementSnapshot[]): number[] {
	const tops = positions(items);
	if (Math.max(...tops) - Math.min(...tops) > tolerance) throw new CheckFailure("top positions differ", `span <= ${tolerance}`, tops);
	return tops;
}
// Column gaps resolve at used-value time, so a value that is not already a pixel length needs context.
// A percentage resolves against the container's content box, which requires its padding and borders.
// `normal` is zero where gap does not apply (flex, grid, single-column flow); a multi-column container uses the
// font's natural gap, which getComputedStyle reports only as `normal`, so it cannot be established here and must
// fail instead of passing as zero.
const lengthPattern = /^\s*-?(?:\d+(?:\.\d*)?|\.\d+)(?:px)?\s*$/;
const percentagePattern = /^\s*(-?(?:\d+(?:\.\d*)?|\.\d+))%\s*$/;
function numericStyle(item: ElementSnapshot, name: string): number {
	const raw = item.computed?.[name];
	if (raw === null || raw === undefined || !lengthPattern.test(raw)) throw new Error(`missing or non-numeric computed property ${name}`);
	return Number.parseFloat(raw);
}
// Column values are classified as strings, not measured as numbers.
function textProperty(item: ElementSnapshot, name: string): string {
	const raw = item.computed?.[name];
	if (raw === null || raw === undefined) throw new Error(`missing computed property ${name}`);
	return String(raw).trim();
}
function positiveContentWidth(container: ElementSnapshot): number {
	const inner = box(container).width - numericStyle(container, "paddingLeft") - numericStyle(container, "paddingRight") - numericStyle(container, "borderLeftWidth") - numericStyle(container, "borderRightWidth");
	if (!(inner > 0)) throw new Error("percentage column gap requires a definite positive content width");
	return inner;
}
function resolveColumnGap(container: ElementSnapshot): number {
	const raw = String(container.computed?.columnGap ?? "").trim();
	let resolved: number;
	if (raw === "normal") {
		const count = textProperty(container, "columnCount"), width = textProperty(container, "columnWidth");
		if (!/^(?:[1-9]\d*|auto)$/.test(count)) throw new Error(`cannot resolve computed property columnCount: ${count}`);
		if (width !== "auto" && !lengthPattern.test(width)) throw new Error(`cannot resolve computed property columnWidth: ${width}`);
		// Only an explicit column count or column width can create multiple columns; there is then no way to read
		// the used gap from the snapshot, because getComputedStyle leaves it as `normal`.
		if (Number(count) >= 2 || width !== "auto") throw new Error(`cannot establish the used value of normal column gap for a multi-column container (${count}, ${width})`);
		// flex, grid and single-column flow containers resolve a normal gap to zero.
		resolved = 0;
	} else if (percentagePattern.test(raw)) {
		resolved = Number(percentagePattern.exec(raw)![1]) / 100 * positiveContentWidth(container);
	} else {
		// A pixel length is already resolved, including an absent or malformed value, which fails here.
		resolved = numericStyle(container, "columnGap");
	}
	if (!(resolved >= 0)) throw new Error(`column gap must not be negative: ${raw}`);
	return resolved;
}
async function execute(driver: CaptureDriver, step: Step): Promise<unknown> {
	if (step.verb === "read") return value(one(await elements(driver, step.target, requiredFields(step)), step.target), step);
	if (step.verb === "assert") {
		const items = await elements(driver, step.target, [...requiredFields(step), "box"]);
		const result: Record<string, unknown> = { matched: items.length };
		if (Object.hasOwn(step, "equals")) {
			const actual = value(one(items, step.target), step);
			const expected = step.equals;
			const numeric = typeof expected === "number";
			if (numeric && typeof step.attribute !== "string" && typeof step.computed !== "string") throw new Error("numeric equals requires an attribute or computed property");
			const converted = numeric && actual.trim() !== "" ? Number(actual) : NaN;
			if (numeric ? !Number.isFinite(converted) || converted !== expected : typeof expected !== "string" || actual !== expected) throw new CheckFailure("equals failed", expected, actual);
			result.equals = { expected, actual };
		}
		if (step.same_top === true) result.tops = sameTop(items);
		if (step.inside !== undefined) {
			const container = box(one(await elements(driver, step.inside, ["box"]), step.inside));
			const boxes = items.map(box);
			if (boxes.some(b => b.x < container.x - tolerance || b.y < container.y - tolerance || b.x + b.width > container.x + container.width + tolerance || b.y + b.height > container.y + container.height + tolerance)) throw new CheckFailure("inside failed", container, boxes);
			result.inside = { container, boxes };
		}
		return result;
	}
	if (step.verb === "measure") {
		const fields = Array.isArray(step.fields) ? step.fields.map(String) : ["box"];
		const derive = Array.isArray(step.derive) ? step.derive.map(String) : [];
		if (derive.length && !fields.includes("box")) fields.push("box");
		const items = await elements(driver, step.target, fields);
		if (step.each !== true) one(items, step.target);
		// Validate requested fields rather than recording absent data as evidence.
		for (const item of items) for (const field of fields) {
			if (field === "box") box(item);
			else if (field === "text") { if (item.text == null) throw new Error("missing text"); }
			else if (field.startsWith("computed:")) { if (item.computed?.[field.slice(9)] == null) throw new Error(`missing computed property ${field.slice(9)}`); }
			else { const name = field.startsWith("attribute:") ? field.slice(10) : field; if (item.attributes?.[name] == null) throw new Error(`missing attribute ${name}`); }
		}
		const checks: Record<string, unknown> = {};
		for (const name of derive) {
			if (name === "distinct_tops") checks.distinct_tops = sameTop(items);
			else if (name === "natural_row_width") {
				if (!step.container) throw new Error("natural_row_width requires container");
				const hasGap = items.length > 1;
				// Resolving a gap value needs the value itself plus its context: the columns it applies to and the
				// content box a percentage resolves against. A single control has no gap, so none of these are read.
				const fields = ["box", ...(hasGap ? ["computed:columnGap", "computed:columnCount", "computed:columnWidth", "computed:borderLeftWidth", "computed:borderRightWidth"] : []), "computed:paddingLeft", "computed:paddingRight"];
				const container = one(await elements(driver, step.container, fields), step.container);
				const widths = items.map(item => box(item).width), gap = hasGap ? resolveColumnGap(container) : 0, padding = numericStyle(container, "paddingLeft") + numericStyle(container, "paddingRight");
				const total = widths.reduce((a, b) => a + b, 0) + gap * (items.length - 1) + padding;
				const width = box(container).width;
				if (total > width + tolerance) throw new CheckFailure("natural_row_width failed", `<= ${width + tolerance}`, { total, width, widths, gap, padding });
				checks.natural_row_width = { total, width, widths, gap, padding };
			} else throw new Error(`unknown measure derive: ${name}`);
		}
		return { value: step.each === true ? items : items[0], checks };
	}
	if (step.verb === "press" && step.until_stable !== undefined) {
		const options = step.until_stable as Record<string, unknown>;
		if (!options || typeof options !== "object" || typeof options.attribute !== "string" || !Number.isInteger(options.max) || Number(options.max) < 1) throw new Error("until_stable requires target, attribute and positive max");
		const read = async () => value(one(await elements(driver, options.target, [`attribute:${options.attribute}`]), options.target), { ...step, attribute: options.attribute });
		let before = await read(); const values = [before];
		for (let i = 0; i < Number(options.max); i++) {
			await driver.perform("press", step.target, step);
			const start = driver.now(); let previous = await read(), settled = false;
			while (driver.now() - start < 2000) {
				await driver.wait(50); if (driver.now() - start > 2000) break;
				const current = await read();
				if (current === previous) { settled = true; break; }
				previous = current;
			}
			if (!settled) throw new CheckFailure("until_stable did not settle within 2 seconds", "two matching samples", previous);
			values.push(previous);
			if (previous === before) return { presses: i + 1, values };
			before = previous;
		}
		throw new CheckFailure("until_stable still changes after max presses", "unchanged value", values);
	}
	if (step.verb === "press" && step.repeat !== undefined) {
		if (!Number.isInteger(step.repeat) || Number(step.repeat) < 1) throw new Error("repeat must be a positive integer");
		for (let i = 0; i < Number(step.repeat); i++) await driver.perform("press", step.target, step);
		return { presses: step.repeat };
	}
	return driver.perform(step.verb as Exclude<StepVerb, "assert" | "read" | "measure">, step.target, step);
}

export async function runSteps(driver: CaptureDriver, spec: Pick<CaptureSpec, "steps">): Promise<StepsResult> {
	const result: StepsResult = { outcomes: [], measured: {}, read: {}, ok: true };
	for (const step of spec.steps) {
		try {
			if ((step.verb === "measure" || step.verb === "read" || step.verb === "eval") && (typeof step.name !== "string" || !step.name)) throw new Error(`${step.verb} requires name`);
			let output: unknown;
			try { output = await execute(driver, step); }
			catch (error) {
				if (!navigationError(error)) throw error;
				if (!observational.has(step.verb) && step.replay !== true) throw new Error(`navigation during ${step.verb}: uncertain outcome; replay not authorized`);
				output = await execute(driver, step);
			}
			if (step.verb === "measure" || step.verb === "read" || step.verb === "eval") {
				const name = step.name as string;
				if (step.verb === "measure") result.measured[name] = (output as { value: unknown }).value;
				else result.read[name] = output;
			}
			result.outcomes.push({ step, ok: true, ...(output === undefined ? {} : { result: output }) });
		} catch (error) {
			result.ok = false;
			result.outcomes.push({ step, ok: false, error: redactUrl(error instanceof Error ? error.message : String(error)), ...(error instanceof CheckFailure ? { expected: error.expected, actual: error.actual } : step.verb === "assert" || step.verb === "measure" ? { expected: step, actual: null } : {}) });
			break;
		}
	}
	return result;
}
