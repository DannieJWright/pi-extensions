// Feature ledger core: the ledger file model and the start/submit steps.
// The tools in index.ts call these; the logic is kept here so it is testable
// without a Pi session.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseYaml, serializeYaml } from "../../lib/yaml.ts";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (command: string, args: string[], cwd: string) => Promise<ExecResult>;

export const STATUSES = ["todo", "in-progress", "done"] as const;
export type ItemStatus = (typeof STATUSES)[number];

export interface LedgerItem {
	id: string;
	status: ItemStatus;
	goal: string;
	short_goal: string;
	acceptance_criteria: string[];
	constraints: string[];
	validation_scripts?: string[];
	files: { in: string[]; out: string[] };
	tests: string[];
	limitations: string[];
	summary: string;
	commits: { start?: string; end?: string };
}

export interface Ledger {
	description: string;
	workspace: string;
	branch: string;
	validation_scripts: string[];
	features: LedgerItem[];
}

export function ensureParent(path: string): Promise<void> {
	return mkdir(dirname(path), { recursive: true });
}

export function ledgerPath(repoRoot: string, branch: string): string {
	return join(repoRoot, "plan", branch, "ledger.yaml");
}

// Pure wiring helpers for the check: no git and no filesystem access, the caller supplies
// the repo root, the branch, and the file read. The CLI and the tool share them.

export function resolveCheckTarget(cwd: string, path?: string, defaultTarget?: string): string {
	if (!path) return defaultTarget ?? cwd;
	return isAbsolute(path) ? path : resolve(cwd, path);
}

export function locationProblem(path: string, repoRoot: string, branch: string): string | null {
	if (!branch || path === ledgerPath(repoRoot, branch)) return null;
	return `path is not plan/${branch}/ledger.yaml for branch ${branch} (ledger_list will not find it)`;
}

export function parseLedger(text: string): { ledger: Ledger | null; problems: string[] } {
	const problems: string[] = [];
	const doc = parseYaml(text) as Record<string, unknown>;
	const raw = doc.ledger;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ledger: null, problems: ["no ledger block"] };
	const ledger = raw as Record<string, unknown>;
	if (!Array.isArray(ledger.features)) problems.push("ledger.features is not a list");
	const features = (Array.isArray(ledger.features) ? ledger.features : []) as Record<string, unknown>[];
	const items: LedgerItem[] = [];
	for (const [n, feature] of features.entries()) {
		if (!feature || typeof feature !== "object" || Array.isArray(feature)) { problems.push(`features[${n}] is not an item`); continue; }
		const item = feature as Record<string, unknown>;
		if (typeof item.id !== "string" || item.id === "") { problems.push(`features[${n}]: missing id`); continue; }
		if (!STATUSES.includes(item.status as ItemStatus)) problems.push(`features[${n}] (${item.id}): status must be ${STATUSES.join(", ")}, got ${String(item.status)}`);
		if (typeof item.short_goal !== "string" || item.short_goal === "") problems.push(`features[${n}] (${item.id}): missing short_goal`);
		const at = (field: string) => `features[${n}] (${item.id}): ${field}`;
		items.push({
			id: item.id,
			status: (STATUSES.includes(item.status as ItemStatus) ? item.status : "todo") as ItemStatus,
			goal: typeof item.goal === "string" ? item.goal : "",
			short_goal: typeof item.short_goal === "string" ? item.short_goal : "",
			acceptance_criteria: list(item.acceptance_criteria, at("acceptance_criteria"), problems),
			constraints: list(item.constraints, at("constraints"), problems),
			...(Array.isArray(item.validation_scripts) ? { validation_scripts: list(item.validation_scripts, at("validation_scripts"), problems) } : {}),
			files: { in: list((item.files as Record<string, unknown>)?.in, at("files.in"), problems), out: list((item.files as Record<string, unknown>)?.out, at("files.out"), problems) },
			tests: list(item.tests, at("tests"), problems),
			limitations: list(item.limitations, at("limitations"), problems),
			summary: typeof item.summary === "string" ? item.summary : "",
			commits: Object.fromEntries(
				Object.entries((item.commits as Record<string, unknown>) ?? {}).map(([key, value]) => [key, value === null || value === undefined ? value : String(value)]),
			) as LedgerItem["commits"],
		});
	}
	return {
		ledger: {
			description: typeof ledger.description === "string" ? ledger.description : "",
			workspace: typeof ledger.workspace === "string" ? ledger.workspace : "",
			branch: typeof ledger.branch === "string" ? ledger.branch : "",
			validation_scripts: list(ledger.validation_scripts, "ledger.validation_scripts", problems),
			features: items,
		},
		problems,
	};
}

function list(value: unknown, field: string, problems: string[]): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((entry, index) => {
		if (typeof entry === "string") return entry;
		// A bullet such as "- Read-only: the tool never writes the ledger." parses as a mapping,
		// so it reaches a reader as [object Object]. Writers must quote such a line.
		problems.push(`${field}[${index}] is not a string (a bullet that starts with "key: value" reads as a mapping)`);
		return String(entry);
	});
}

// The check: parseLedger problems plus duplicate id detection. One flat problem list,
// no severity levels. parseLedger itself is unchanged: read tools do not error on
// duplicate ids, so a duplicate is a check-time finding only.
// The location line is added by the caller (the CLI or the tool), not here, so both
// share this core. Indices name the feature position in the file, matching the lines
// parseLedger reports.

export function checkLedger(text: string): string[] {
	const { ledger, problems } = parseLedger(text);
	if (!ledger) return problems;
	const doc = parseYaml(text) as Record<string, unknown>;
	const features = (doc.ledger as Record<string, unknown>)?.features;
	if (!Array.isArray(features)) return problems;
	const seen = new Set<string>();
	for (const [n, feature] of features.entries()) {
		if (!feature || typeof feature !== "object" || Array.isArray(feature)) continue;
		const id = (feature as Record<string, unknown>).id;
		if (typeof id !== "string" || id === "") continue;
		if (seen.has(id)) problems.push(`features[${n}] (${id}): duplicate id`);
		else seen.add(id);
	}
	return problems;
}

export interface LedgerListEntry {
	id: string;
	status: ItemStatus;
	short_goal: string;
	commits: { start: string | null; end: string | null };
}

export interface LedgerListResult {
	branch: string;
	items: LedgerListEntry[];
}

export type LedgerState = "todo" | "in-progress" | "done";

export interface LedgerNextEntry {
	id: string;
	status: ItemStatus;
	short_goal: string;
}

export interface LedgerNextResult {
	next: LedgerNextEntry | null;
	status: LedgerState;
}

// Read-only views. Order is file order; nothing here writes the ledger.
// commits.start is null for a todo item, commits.end is null for an in-progress item.
// An item with no short_goal value is an error here: parseLedger reports it as a problem but
// still parses the item, so a read view must not hand a reader an empty overview.

function requireShortGoal(item: LedgerItem): string {
	if (item.short_goal === "") throw new Error(`item ${item.id} has no short_goal`);
	return item.short_goal;
}

export function listItems(ledger: Ledger): LedgerListResult {
	return {
		branch: ledger.branch,
		items: ledger.features.map((item) => ({
			id: item.id,
			status: item.status,
			short_goal: requireShortGoal(item),
			commits: { start: item.commits.start ?? null, end: item.commits.end ?? null },
		})),
	};
}

// The next item is the first in-progress one, else the first todo.
// Root status: todo when nothing is started, done when everything is done,
// otherwise in-progress (at least one item is in-progress or done).

export function nextItem(ledger: Ledger): LedgerNextResult {
	const statuses = ledger.features.map((item) => item.status);
	const state: LedgerState = statuses.length === 0 || statuses.every((status) => status === "todo")
		? "todo"
		: statuses.every((status) => status === "done")
			? "done"
			: "in-progress";
	const item = ledger.features.find((feature) => feature.status === "in-progress") ?? ledger.features.find((feature) => feature.status === "todo") ?? null;
	return {
		next: item ? { id: item.id, status: item.status, short_goal: requireShortGoal(item) } : null,
		status: state,
	};
}

const ITEM_KEYS = ["id", "status", "goal", "short_goal", "acceptance_criteria", "constraints", "validation_scripts", "files", "tests", "limitations", "summary", "commits"];

export function serializeLedger(ledger: Ledger): string {
	const ordered: Record<string, unknown> = {
		description: ledger.description,
		workspace: ledger.workspace,
		branch: ledger.branch,
		validation_scripts: ledger.validation_scripts,
		features: ledger.features.map((item) => {
			const record: Record<string, unknown> = {};
			for (const key of ITEM_KEYS) {
				const value = (item as Record<string, unknown>)[key];
				if (value === undefined) continue;
				record[key] = value;
			}
			return record;
		}),
	};
	return serializeYaml({ ledger: ordered });
}

export interface StartResult {
	item: LedgerItem;
	brief: {
		goal: string;
		acceptance_criteria: string[];
		constraints: string[];
		files_in: string[];
		tests: string[];
		validation_scripts: string[];
	};
}

export async function startItem(opts: { repoRoot: string; branch: string; id: string; exec: Exec }): Promise<StartResult> {
	const path = ledgerPath(opts.repoRoot, opts.branch);
	const { ledger, problems } = parseLedger(await readFile(path, "utf8"));
	if (!ledger) throw new Error(`cannot read the ledger: ${problems.join("; ")}`);
	const item = ledger.features.find((feature) => feature.id === opts.id);
	if (!item) throw new Error(`no item ${opts.id} in ${path}`);
	if (item.status !== "todo") throw new Error(`item ${opts.id} is already ${item.status}; one writer per item`);
	const head = (await opts.exec("git", ["rev-parse", "--short", "HEAD"], opts.repoRoot)).stdout.trim();
	if (!head) throw new Error("cannot read HEAD");
	item.status = "in-progress";
	item.commits = { ...item.commits, start: head };
	await ensureParent(path);
	await writeFile(path, serializeLedger(ledger));
	return {
		item,
		brief: {
			goal: item.goal,
			acceptance_criteria: item.acceptance_criteria,
			constraints: item.constraints,
			files_in: item.files.in,
			tests: item.tests,
			validation_scripts: item.validation_scripts ?? ledger.validation_scripts,
		},
	};
}

export type SubmitResult =
	| { rejected: true; script: string; exit: number; logPath: string; lastOutput: string }
	| { rejected: false; commit: string; filesOut: string[] };

export async function submitItem(opts: {
	repoRoot: string;
	branch: string;
	id: string;
	commitMessage: string;
	summary: string;
	limitations: string[];
	exec: Exec;
	logDir?: string;
}): Promise<SubmitResult> {
	const path = ledgerPath(opts.repoRoot, opts.branch);
	const { ledger, problems } = parseLedger(await readFile(path, "utf8"));
	if (!ledger) throw new Error(`cannot read the ledger: ${problems.join("; ")}`);
	const item = ledger.features.find((feature) => feature.id === opts.id);
	if (!item) throw new Error(`no item ${opts.id} in ${path}`);
	if (item.status !== "in-progress") throw new Error(`item ${opts.id} is ${item.status}; submit requires in-progress`);
	if (!item.commits.start) throw new Error(`item ${opts.id} has no commits.start`);

	const head = (await opts.exec("git", ["rev-parse", "HEAD"], opts.repoRoot)).stdout.trim();
	const startFull = (await opts.exec("git", ["rev-parse", item.commits.start], opts.repoRoot)).stdout.trim();
	if (head !== startFull) throw new Error(`HEAD moved during the work (${item.commits.start} is not HEAD); the item must be one commit`);
	const dirty = (await opts.exec("git", ["status", "--porcelain"], opts.repoRoot)).stdout.trim();
	if (!dirty) throw new Error("the working tree has no changes");

	const scripts = item.validation_scripts ?? ledger.validation_scripts;
	for (const script of scripts) {
		const result = await opts.exec("sh", ["-c", script], opts.repoRoot);
		if (result.code !== 0) {
			const output = `${result.stdout}${result.stderr}`;
			const logDir = opts.logDir ?? "/tmp";
			const logPath = join(logDir, `ledger-${opts.id}-${Date.now()}.log`);
			await writeFile(logPath, `$ ${script}\n${output}`);
			const lastOutput = output.split("\n").filter((line) => line !== "").slice(-20).join("\n");
			return { rejected: true, script, exit: result.code, logPath, lastOutput };
		}
	}

	const staged = await opts.exec("git", ["add", "-A"], opts.repoRoot);
	if (staged.code !== 0) throw new Error(`git add failed: ${staged.stderr || staged.stdout}`);
	const commit = await opts.exec("git", ["commit", "-m", opts.commitMessage], opts.repoRoot);
	if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
	const end = (await opts.exec("git", ["rev-parse", "--short", "HEAD"], opts.repoRoot)).stdout.trim();
	const diff = await opts.exec("git", ["diff", "--name-only", item.commits.start, end], opts.repoRoot);
	const filesOut = diff.stdout.split("\n").filter((line) => line !== "");

	item.files = { in: item.files.in, out: filesOut };
	item.summary = opts.summary;
	item.limitations = [...item.limitations, ...opts.limitations];
	item.commits = { start: item.commits.start, end };
	item.status = "done";
	await ensureParent(path);
	await writeFile(path, serializeLedger(ledger));
	return { rejected: false, commit: end, filesOut };
}
