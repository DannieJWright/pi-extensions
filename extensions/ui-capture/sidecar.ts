import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { canonicalJson, parseSpec, safeComponent, type CaptureSpec } from "./spec.ts";
import { redactUrl } from "./redact.ts";
import type { StepsResult } from "./steps.ts";
import type { DiffResult, ShotEvidence } from "./diff.ts";
import { openArtifactDirectory, publishArtifact, readArtifact, type ArtifactLocation } from "./artifacts.ts";

export type PhaseName = "before" | "after";
export type ImageEvidence = { path: string; sha256: string; evidence_id: string };
export type PhaseEvidence = {
	status: "success" | "failed"; complete: boolean; evidence_id: string; spec_hash: string;
	conditions: Record<string, unknown>; input_steps: CaptureSpec["steps"]; outcomes: StepsResult["outcomes"];
	measured: Record<string, unknown>; read: Record<string, unknown>; images: ImageEvidence[];
	build: string; url: string; console_errors: string[]; shots?: ShotEvidence[];
};
export type PairAnswers = { visible: boolean; conditions_match: boolean; only_difference_is_the_feature: boolean; same_target: boolean; preserved: string[]; measurements: string[]; note: string };
// A saved diff records its mask by content hash and names the phase evidence it was computed from.
export type DiffEvidence = DiffResult & { conditions_match: boolean; evidence: Record<PhaseName, string> };
export type Sidecar = { feature: string; subphase: string | number; description: string; phases: Partial<Record<PhaseName, PhaseEvidence>>; diff?: DiffEvidence; pair_check?: PairAnswers & { evidence: Record<PhaseName, string> } };
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const inside = (root: string, child: string) => { const rel = relative(root, child); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); };

// The project override is relative to the Git root unless absolute.
export async function artifactDirectory(gitRoot: string, spec: CaptureSpec, override = "artifacts"): Promise<string> {
	const directory = await openArtifactDirectory(gitRoot, spec, override);
	try { return directory.dir; } finally { await directory.close(); }
}

export async function ignoredOutputWarning(gitRoot: string, path: string, files?: string[]): Promise<string | undefined> {
	const root = await realpath(gitRoot);
	const output = files ? await realpath(resolve(gitRoot, path)) : resolve(gitRoot, path);
	if (!inside(root, output)) return `artifact output is outside the Git repository: ${output}`;
	const ignored: string[] = [];
	for (const file of files ?? [output]) {
		const target = files ? join(output, file) : file;
		try {
			await promisify(execFile)("git", ["check-ignore", "-q", "--", target], { cwd: root });
			ignored.push(target);
		} catch (error) {
			if ((error as { code?: number }).code !== 1) throw error;
		}
	}
	return ignored.length ? `artifact output is ignored: ${ignored.join(", ")}` : undefined;
}

async function existingSidecar(dir: ArtifactLocation, spec: CaptureSpec): Promise<Sidecar> {
	try {
		const data = JSON.parse((await readArtifact(dir, "sidecar.json")).toString("utf8")) as Sidecar;
		if (!data.phases || data.feature !== spec.feature || data.subphase !== spec.subphase) throw new Error("sidecar identity mismatch or unsupported layout");
		return data;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { feature: spec.feature, subphase: spec.subphase, description: spec.description, phases: {} };
		throw error;
	}
}
async function imageDigest(dir: ArtifactLocation, name: string): Promise<string> {
	if (basename(name) !== name || !name.endsWith(".png")) throw new Error(`invalid image path: ${name}`);
	return digest(await readArtifact(dir, name));
}

// The phase record is built without publishing it: a run keeps its start as failed evidence until its steps, required diff work, and browser cleanup have all completed.
export async function buildPhase(options: { dir: ArtifactLocation; specText: string; phase: PhaseName; result: StepsResult; imageNames: string[]; build: string; url: string; consoleErrors?: string[]; shots?: ShotEvidence[] }): Promise<Sidecar> {
	const { dir, specText, phase, result } = options;
	if (phase !== "before" && phase !== "after") throw new Error("invalid phase");
	const spec = parseSpec(specText);
	if (typeof dir === "string") await mkdir(dir, { recursive: true });
	const sidecar = await existingSidecar(dir, spec);
	const id = randomUUID();
	const images: ImageEvidence[] = [];
	for (const name of options.imageNames) {
		if (!name.startsWith(`${phase}.`) && !name.startsWith(`${phase}-`)) throw new Error(`image does not belong to ${phase}: ${name}`);
		images.push({ path: name, sha256: await imageDigest(dir, name), evidence_id: id });
	}
	const screenshotSteps = spec.steps.filter(step => step.verb === "screenshot");
	const expectedImages = screenshotSteps.length ? screenshotSteps.map(step => {
		const target = step.target;
		const name = target && typeof target === "object" && !Array.isArray(target) ? (target as Record<string, unknown>).name : undefined;
		return `${phase}${name === undefined ? "" : `-${safeComponent(name, "screenshot name")}`}.png`;
	}) : [`${phase}.png`];
	const complete = result.ok && result.outcomes.length === spec.steps.length && result.outcomes.every((item, index) => item.ok && canonicalJson(item.step) === canonicalJson(spec.steps[index])) &&
		new Set(expectedImages).size === expectedImages.length && images.length === expectedImages.length && expectedImages.every(name => images.some(image => image.path === name));
	sidecar.description = spec.description;
	sidecar.phases[phase] = { status: result.ok ? "success" : "failed", complete, evidence_id: id, spec_hash: spec.hash, conditions: spec.conditions, input_steps: spec.steps, outcomes: result.outcomes, measured: result.measured, read: result.read, images, build: options.build, url: options.url, console_errors: options.consoleErrors ?? [], ...(options.shots ? { shots: options.shots } : {}) };
	delete sidecar.diff; delete sidecar.pair_check;
	return sidecar;
}

export async function publishSidecar(dir: ArtifactLocation, specText: string, sidecar: Sidecar): Promise<void> {
	await publishArtifact(dir, "capture.yaml", redactUrl(specText));
	await publishArtifact(dir, "sidecar.json", `${JSON.stringify(sidecar, null, 2)}\n`);
}

export async function savePhase(options: { dir: ArtifactLocation; specText: string; phase: PhaseName; result: StepsResult; imageNames: string[]; build: string; url: string; consoleErrors?: string[]; shots?: ShotEvidence[] }): Promise<Sidecar> {
	const sidecar = await buildPhase(options);
	await publishSidecar(options.dir, options.specText, sidecar);
	return sidecar;
}

export function conditionsMatch(before: PhaseEvidence, after: PhaseEvidence): boolean {
	return before.spec_hash === after.spec_hash && canonicalJson(before.conditions) === canonicalJson(after.conditions) && canonicalJson(before.input_steps) === canonicalJson(after.input_steps);
}

function validateAnswers(value: unknown): asserts value is PairAnswers {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("pair_check answers must be an object");
	const input = value as Record<string, unknown>;
	const keys = ["visible", "conditions_match", "only_difference_is_the_feature", "same_target", "preserved", "measurements", "note"];
	if (Object.keys(input).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(input, key))) throw new Error("pair_check answers must match the schema");
	for (const key of keys.slice(0, 4)) if (typeof input[key] !== "boolean") throw new Error(`pair_check ${key} must be boolean`);
	for (const key of ["preserved", "measurements"]) if (!Array.isArray(input[key]) || !(input[key] as unknown[]).every(v => typeof v === "string" && v !== "")) throw new Error(`pair_check ${key} must be an array of strings`);
	if (typeof input.note !== "string") throw new Error("pair_check note must be a string");
}

export async function validateCurrentPair(sidecar: Sidecar, dir: ArtifactLocation, spec: CaptureSpec): Promise<Sidecar> {
	const before = sidecar.phases.before, after = sidecar.phases.after;
	if (!before || !after || before.status !== "success" || after.status !== "success" || !before.complete || !after.complete || !before.images.length || !after.images.length) throw new Error("pair requires two successful complete phases");
	if (before.spec_hash !== spec.hash || after.spec_hash !== spec.hash || !conditionsMatch(before, after)) throw new Error("current spec or phase conditions do not match");
	for (const phase of [before, after]) for (const image of phase.images) {
		if (image.evidence_id !== phase.evidence_id || await imageDigest(dir, image.path) !== image.sha256) throw new Error(`stale image: ${image.path}`);
	}
	return sidecar;
}

// A pair check answers about what differs between two captures, so it approves only a diff that can still be
// verified: its mask must exist with the content hash recorded for the exact phases being approved. A record
// without that metadata fails closed rather than approving unverified evidence.
async function validateCurrentDiff(diff: unknown, dir: ArtifactLocation, before: PhaseEvidence, after: PhaseEvidence): Promise<void> {
	if (!diff || typeof diff !== "object" || Array.isArray(diff)) throw new Error("pair requires a saved diff");
	const record = diff as Record<string, unknown>;
	if (typeof record.mask !== "string") throw new Error("saved diff has no mask path");
	if (typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.sha256)) throw new Error(`saved diff mask ${record.mask} has no content hash`);
	if (!record.evidence || typeof record.evidence !== "object" || Array.isArray(record.evidence)) throw new Error("saved diff has no phase evidence association");
	const associated = record.evidence as Record<string, unknown>;
	if (associated.before !== before.evidence_id || associated.after !== after.evidence_id) throw new Error("saved diff belongs to different evidence");
	let recorded: string;
	try { recorded = await imageDigest(dir, record.mask); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`missing diff mask: ${record.mask}`); throw error; }
	if (recorded !== record.sha256) throw new Error(`stale diff mask: ${record.mask}`);
}

export async function currentPair(dir: ArtifactLocation, specText: string): Promise<Sidecar> {
	const spec = parseSpec(specText);
	return validateCurrentPair(await existingSidecar(dir, spec), dir, spec);
}

export async function checkPair(dir: ArtifactLocation, specText: string, answers: unknown, force = false): Promise<Sidecar> {
	validateAnswers(answers);
	const sidecar = await currentPair(dir, specText);
	const before = sidecar.phases.before!, after = sidecar.phases.after!;
	await validateCurrentDiff(sidecar.diff, dir, before, after);
	for (const path of answers.measurements) {
		const match = /^phases\.(before|after)\.measured\.([^.]+)$/.exec(path);
		if (!match || !Object.hasOwn(sidecar.phases[match[1] as PhaseName]!.measured, match[2])) throw new Error(`unknown measurement: ${path}`);
	}
	if (sidecar.pair_check && !force) throw new Error("pair_check already exists; use force to replace it");
	if (sidecar.pair_check && (sidecar.pair_check.evidence.before !== before.evidence_id || sidecar.pair_check.evidence.after !== after.evidence_id)) throw new Error("pair_check belongs to different evidence");
	sidecar.pair_check = { ...answers, evidence: { before: before.evidence_id, after: after.evidence_id } };
	await publishArtifact(dir, "sidecar.json", `${JSON.stringify(sidecar, null, 2)}\n`);
	return sidecar;
}
