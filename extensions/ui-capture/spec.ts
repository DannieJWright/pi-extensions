import { createHash } from "node:crypto";
import { parseYaml } from "../../lib/yaml.ts";

export const STEP_VERBS = ["goto", "fill", "press", "hover", "click", "scroll_to", "wait_for", "assert", "screenshot", "focus", "read", "measure", "eval"] as const;
export type StepVerb = (typeof STEP_VERBS)[number];
export type Step = { verb: StepVerb; target: unknown; [key: string]: unknown };
export type CaptureSpec = {
	feature: string; subphase: string | number; description: string;
	server: Record<string, unknown>; conditions: Record<string, unknown>; steps: Step[];
	diff?: Record<string, unknown>; hash: string;
};

export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function safeComponent(value: unknown, field: string): string {
	const text = String(value);
	if ((typeof value !== "string" && typeof value !== "number") || !text || text === "." || text === ".." || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(text)) throw new Error(`invalid ${field}: expected a safe path component`);
	return text;
}

export function parseSpec(text: string): CaptureSpec {
	const doc = parseYaml(text);
	for (const field of ["feature", "subphase", "description", "server", "conditions", "steps"]) {
		if (doc[field] === undefined || doc[field] === null || doc[field] === "") throw new Error(`spec is missing ${field}`);
	}
	safeComponent(doc.feature, "feature"); safeComponent(doc.subphase, "subphase");
	if (typeof doc.feature !== "string" || typeof doc.description !== "string") throw new Error("feature and description must be strings");
	if (!record(doc.server)) throw new Error("server must be a mapping");
	const server = doc.server;
	const hasUrl = typeof server.url === "string" && server.url !== "";
	const hasStart = typeof server.start === "string" && server.start !== "";
	if (hasUrl === hasStart) throw new Error("server requires exactly one of url or start");
	if (server.detached === true && (typeof server.stop !== "string" || !server.stop)) throw new Error("detached server requires stop");
	if (!record(doc.conditions)) throw new Error("conditions must be a mapping");
	if (!Array.isArray(doc.steps) || !doc.steps.length) throw new Error("spec has no steps");
	const steps: Step[] = doc.steps.map((value, i) => {
		if (!record(value)) throw new Error(`step ${i + 1}: expected a verb`);
		const verbs = Object.keys(value).filter(key => STEP_VERBS.includes(key as StepVerb));
		if (verbs.length !== 1) throw new Error(`step ${i + 1}: expected one of ${STEP_VERBS.join(", ")}; got ${Object.keys(value).join(", ")}`);
		const [verb] = verbs as StepVerb[];
		const { [verb]: target, ...options } = value;
		if (verb === "screenshot" && record(target) && target.name !== undefined) safeComponent(target.name, `step ${i + 1} screenshot name`);
		return { verb, target, ...options };
	});
	if (doc.diff !== undefined && !record(doc.diff)) throw new Error("diff must be a mapping");
	return { ...doc, feature: doc.feature, subphase: doc.subphase as string | number, description: doc.description, server, conditions: doc.conditions, steps, hash: createHash("sha256").update(canonicalJson(doc)).digest("hex") } as CaptureSpec;
}

export function parseViewport(value: unknown): { width: number; height: number } | undefined {
	if (value === undefined) return undefined;
	const match = typeof value === "string" ? /^(\d+)x(\d+)$/.exec(value) : null;
	if (!match || !Number(match[1]) || !Number(match[2])) throw new Error("conditions.viewport must be WIDTHxHEIGHT");
	return { width: Number(match[1]), height: Number(match[2]) };
}

// Checks condition values without normalizing them; unknown keys are ignored.
export function validateConditions(conditions: Record<string, unknown>): void {
	parseViewport(conditions.viewport);
	if (conditions.theme !== undefined && conditions.theme !== "light" && conditions.theme !== "dark") throw new Error("conditions.theme must be light or dark");
	if (conditions.locale !== undefined && typeof conditions.locale !== "string") throw new Error("conditions.locale must be a string");
	if (conditions.permissions !== undefined && (!Array.isArray(conditions.permissions) || !conditions.permissions.every(p => typeof p === "string"))) throw new Error("conditions.permissions must be an array of strings");
	if (conditions.storage !== undefined) {
		if (!record(conditions.storage)) throw new Error("conditions.storage must be a mapping");
		if (!Object.values(conditions.storage).every(v => typeof v === "string")) throw new Error("conditions.storage values must be strings");
	}
	if (conditions.theme_storage !== undefined) {
		if (!record(conditions.theme_storage)) throw new Error("conditions.theme_storage must be a mapping");
		const name = conditions.theme_storage["key"];
		if (name !== undefined && (typeof name !== "string" || !name || !conditions.theme)) throw new Error("theme_storage.key requires a theme and a non-empty key");
	}
	const clock = conditions.clock;
	if (clock !== undefined) {
		const usable = typeof clock === "string" ? clock !== "" : typeof clock === "number" && Number.isFinite(clock);
		if (!usable || Number.isNaN(new Date(clock as string | number).valueOf())) throw new Error("conditions.clock must be a valid date");
	}
	if (conditions.entry !== undefined && conditions.entry !== null && typeof conditions.entry !== "string") throw new Error("conditions.entry must be a string");
}

// Port expansion returns a new server block; the canonical input remains unchanged.
export function substitutePort(server: Record<string, unknown>, port: number): Record<string, unknown> {
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
	const replace = (value: string) => value.replaceAll("{port}", String(port));
	const result = { ...server };
	if (typeof server.start === "string") result.start = replace(server.start);
	if (record(server.env)) result.env = Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, typeof v === "string" ? replace(v) : v]));
	return result;
}
