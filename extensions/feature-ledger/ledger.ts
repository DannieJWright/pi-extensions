// Feature ledger core: the ledger file model and the start/submit steps.
// The tools in index.ts call these; the logic is kept here so it is testable
// without a Pi session.

import { lstat, type Stats } from "node:fs/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
	workspace?: string;
	branch?: string;
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

// Pure path helper for the tools: no git and no filesystem access. The caller supplies the session
// root and the four sources; the pointer file (plan/ledger.path in the session root) is read by the
// caller, so this stays testable. Precedence: explicit, then env, then pointer, then default.
// Relative values resolve against the session root; absolute values are used as given. Any extension
// is accepted, so .yml and .yaml both work and nothing checks an extension. The default is required:
// a caller that trusts the result reads it as a file, so an empty result would be a directory.
export function resolveLedgerPath(cwd: string, opts: { explicit?: string; env?: string; pointer?: string; default: string }): string {
	const value = firstNonEmpty(opts.explicit, opts.env, opts.pointer, opts.default);
	if (!value) throw new Error("resolveLedgerPath: every source is empty, so there is no ledger file to read");
	return isAbsolute(value) ? value : resolve(cwd, value);
}

function firstNonEmpty(...values: (string | undefined)[]): string {
	for (const value of values) {
		if (value !== undefined && value !== "") return value;
	}
	return "";
}

// The directory the tools work from for an item: the item value, else the ledger-level
// workspace, else the session root. Relative to the session root; absolute as given.
// No git call and no filesystem check here, so it stays unit-testable.
export function resolveWorkspace(cwd: string, item: LedgerItem, ledgerDefault: string): string {
	const value = firstNonEmpty(item.workspace, ledgerDefault, ".");
	return isAbsolute(value) ? value : resolve(cwd, value);
}

// The repository an item's commit is made in. exec is passed in rather than called here, so the
// helper stays testable. An empty result means the workspace is not inside a git repository, which
// the caller reports with the workspace named.
export async function resolveRepoRoot(workspace: string, exec: Exec): Promise<string> {
	const root = (await exec("git", ["rev-parse", "--show-toplevel"], workspace)).stdout.trim();
	return root;
}

// True when path is inside root. A path above root is not, so a change outside the item's
// own repository is reported as a warning instead of committed. Paths are compared as written;
// symlinks are not resolved.
export function isInside(path: string, root: string): boolean {
	const rel = relative(root, path);
	if (isAbsolute(rel)) return false;
	if (rel === "") return true;
	return rel.split(sep)[0] !== "..";
}

// Prefix a path reported by git so it reads from the session root. Git prints paths relative to the
// repository root even when run from a subdirectory, so each path is first converted to be relative to
// the workspace. A workspace that is the session root needs no prefix. A workspace above the session
// root cannot be expressed as a path from it, so those entries are absolute.
export function prefixFromRoot(cwd: string, workspace: string, repoRoot: string, paths: string[]): string[] {
	const fromWorkspace = (path: string) => relative(workspace, join(repoRoot, path));
	const prefix = relative(cwd, workspace);
	if (!prefix) return paths.map(fromWorkspace);
	// ".." as the first segment means the workspace is above the session root.
	if (!isAbsolute(prefix) && prefix.split(sep)[0] === "..") return paths.map((path) => join(workspace, fromWorkspace(path)));
	return paths.map((path) => join(prefix, fromWorkspace(path)));
}

// Two checks the tool wrapper runs because they need the filesystem or git. The wording follows the
// location line: the fact, then the consequence in parentheses.
export function planReference(goal: string): string | null {
	const match = goal.match(/plan\/[^\s,;:"']+\.md/);
	return match ? match[0] : null;
}

export function missingPlanProblem(at: string, ref: string): string {
	return `${at} names a plan file that does not exist (${ref})`;
}

// The check strings for the workspace, files.in, and plan checks. The tool wrapper runs the
// filesystem and git work and calls these, so the wording is fixed in the core. The field name
// comes from problemTarget, so these lines do not repeat it. A files.in entry is a warning, not a
// problem: an author may name a file an earlier step will create, so the check must not fail on it.
export function missingWorkspaceProblem(at: string, workspace: string): string {
	return `${at} does not exist (${workspace})`;
}

export function outsideRepoProblem(at: string, workspace: string): string {
	return `${at} is not inside a git repository (${workspace})`;
}

export function missingInputWarning(at: string, path: string): string {
	return `${at} names a file that does not exist yet (${path})`;
}

export function trackedPlanProblem(paths: string[]): string {
	return `git ls-files plan/ is not empty: ${paths.join(", ")} (the plan and the ledger are removed before the PR is opened)`;
}

// A field that must be a plain value is shown as it was written, so a flow sequence such as
// [sub-repo-1] reads as a list and not as its joined text.
export function badValueProblem(at: string, value: unknown): string {
	return `${at} must be a non-empty string, got ${JSON.stringify(value)}`;
}

export function problemTarget(n: number, id: string, field: string): string {
	return `features[${n}] (${id}): ${field}`;
}

// git add can record a removal or a rename, so a D or R entry is addable without the path on disk.
// Every other entry needs the path to exist and be a regular file, a symbolic link, or a
// git-directory. The sandbox view shows project-root dotfiles as character devices, so `git add -A`
// fails on them with exit 128; those entries are skipped. The same filter answers whether the working
// tree has changes, so sandbox noise alone does not pass that check.
// Entries are read with `--porcelain -z`: records are NUL-separated and paths are not quoted, so a
// path with a space parses correctly. For a rename or a copy, -z writes the destination path first,
// then the source path, as two records with no arrow; the destination is the path that exists.
// Git 2.2 or later is assumed (this repository runs git 2.53).
export type EntryStat = (path: string) => Promise<Pick<Stats, "isFile" | "isSymbolicLink" | "isDirectory">>;

export function isAddableEntry(info: Pick<Stats, "isFile", "isSymbolicLink", "isDirectory">): boolean {
	return info.isFile() || info.isSymbolicLink() || info.isDirectory();
}

// The status field is the two-letter column of a porcelain record. Either letter being D or R means
// git can record the change. A conflict code (DU, UD, DD) is included: git add on an unmerged path
// records the working-tree version, which resolves the conflict.
export function isAddableStatus(field: string): boolean {
	return field.includes("D") || field.includes("R");
}

export interface PorcelainEntry {
	status: string;
	path: string;
}

export function parsePorcelain(porcelain: string): PorcelainEntry[] {
	const entries: PorcelainEntry[] = [];
	const records = porcelain.split("\0");
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (record.length < 4) continue;
		const status = record.slice(0, 2);
		const path = record.slice(3);
		entries.push({ status, path });
		// A rename or a copy is two records with no arrow: the destination first, then the source.
		// The destination is the entry, the path that exists; the source record is consumed here so
		// it is not read as a record of its own.
		if (status === "R " || status === "C ") i++;
	}
	return entries;
}

export async function addablePaths(porcelain: string, repoRoot: string, stat: EntryStat = lstat): Promise<string[]> {
	const paths: string[] = [];
	for (const entry of parsePorcelain(porcelain)) {
		if (isAddableStatus(entry.status)) { paths.push(entry.path); continue; }
		let info;
		try {
			info = await stat(join(repoRoot, entry.path));
		} catch {
			continue; // the entry is no longer there
		}
		if (isAddableEntry(info)) paths.push(entry.path);
	}
	return paths;
}

export function parseLedger(text: string): { ledger: Ledger | null; problems: string[]; indexes: number[] } {
	const problems: string[] = [];
	const indexes: number[] = [];
	const doc = parseYaml(text) as Record<string, unknown>;
	const raw = doc.ledger;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ledger: null, problems: ["no ledger block"], indexes };
	const ledger = raw as Record<string, unknown>;
	if (!Array.isArray(ledger.features)) problems.push("ledger.features is not a list");
	const features = (Array.isArray(ledger.features) ? ledger.features : []) as Record<string, unknown>[];
	const items: LedgerItem[] = [];
	for (const [n, feature] of features.entries()) {
		if (!feature || typeof feature !== "object" || Array.isArray(feature)) { problems.push(`features[${n}] is not an item`); continue; }
		const item = feature as Record<string, unknown>;
		if (typeof item.id !== "string" || item.id === "") { problems.push(`features[${n}]: missing id`); continue; }
		// One index per parsed item, so indexes[i] is the file position of features[i].
		// An item skipped here is not in the parsed list, so it must not be in indexes.
		indexes.push(n);
		if (!STATUSES.includes(item.status as ItemStatus)) problems.push(`features[${n}] (${item.id}): status must be ${STATUSES.join(", ")}, got ${String(item.status)}`);
		if (typeof item.short_goal !== "string" || item.short_goal === "") problems.push(`features[${n}] (${item.id}): missing short_goal`);
		const at = (field: string) => problemTarget(n, item.id, field);
		// A workspace or branch that is not a plain value is reported, not dropped: a typo would otherwise
		// make the item fall back to the session root with no problem line.
		if (item.workspace !== undefined && (typeof item.workspace !== "string" || item.workspace === "")) problems.push(badValueProblem(at("workspace"), item.workspace));
		if (item.branch !== undefined && (typeof item.branch !== "string" || item.branch === "")) problems.push(badValueProblem(at("branch"), item.branch));
		items.push({
			id: item.id,
			status: (STATUSES.includes(item.status as ItemStatus) ? item.status : "todo") as ItemStatus,
			goal: typeof item.goal === "string" ? item.goal : "",
			short_goal: typeof item.short_goal === "string" ? item.short_goal : "",
			...(typeof item.workspace === "string" && item.workspace !== "" ? { workspace: item.workspace } : {}),
			...(typeof item.branch === "string" && item.branch !== "" ? { branch: item.branch } : {}),
			acceptance_criteria: list(item.acceptance_criteria, at("acceptance_criteria"), problems),
			constraints: list(item.constraints, at("constraints"), problems),
			...(Array.isArray(item.validation_scripts) ? { validation_scripts: list(item.validation_scripts, at("validation_scripts"), problems) } : {}),
			files: { in: list((item.files as Record<string, unknown>)?.in, at("files.in"), problems), out: list((item.files as Record<string, unknown>)?.out, at("files.out"), problems) },
			tests: list(item.tests, at("tests"), problems),
			limitations: list(item.limitations, at("limitations"), problems),
			summary: typeof item.summary === "string" ? item.summary : "",
			// A null or undefined commit is dropped, not kept: serializeLedger writes nothing for it, so a
			// value parse kept would never come back through the round-trip.
			commits: Object.fromEntries(
				Object.entries((item.commits as Record<string, unknown>) ?? {})
					.map(([key, value]) => [key, value === null || value === undefined ? undefined : String(value)])
					.filter(([, value]) => value !== undefined),
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
		indexes,
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
// share this core. Problem lines name the position in the file, taken from the indexes
// parseLedger returns, so a skipped item does not shift the numbering.

export function checkLedger(text: string): string[] {
	return checkParsed(parseLedger(text));
}

// Split so the tool wrapper parses once and can read the items for the checks it runs itself.
export function checkParsed(parsed: { ledger: Ledger | null; problems: string[]; indexes: number[] }): string[] {
	const { ledger, problems, indexes } = parsed;
	if (!ledger) return problems;
	const seen = new Set<string>();
	for (const [i, item] of ledger.features.entries()) {
		if (item.id === "") continue;
		if (seen.has(item.id)) problems.push(`features[${indexes[i]}] (${item.id}): duplicate id`);
		else seen.add(item.id);
	}
	return problems;
}

export interface LedgerListEntry {
	id: string;
	status: ItemStatus;
	short_goal: string;
	workspace: string;
	commits: { start: string | null; end: string | null };
}

// branch is only present when the file has it. It is an author-written label, not a git read.
export interface LedgerListResult {
	branch?: string;
	items: LedgerListEntry[];
}

export type LedgerState = "todo" | "in-progress" | "done";

export interface LedgerNextEntry {
	id: string;
	status: ItemStatus;
	short_goal: string;
	workspace: string;
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

// The workspace as the file states it, relative to the session root. The read tools report
// this without running git, so a delegate can see where the item works.
function itemWorkspace(ledger: Ledger, item: LedgerItem): string {
	return item.workspace || ledger.workspace || ".";
}

export function listItems(ledger: Ledger): LedgerListResult {
	const result: LedgerListResult = {
		items: ledger.features.map((item) => ({
			id: item.id,
			status: item.status,
			short_goal: requireShortGoal(item),
			workspace: itemWorkspace(ledger, item),
			commits: { start: item.commits.start ?? null, end: item.commits.end ?? null },
		})),
	};
	if (ledger.branch) result.branch = ledger.branch;
	return result;
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
		next: item ? { id: item.id, status: item.status, short_goal: requireShortGoal(item), workspace: itemWorkspace(ledger, item) } : null,
		status: state,
	};
}

const ITEM_KEYS = ["id", "status", "goal", "short_goal", "workspace", "branch", "acceptance_criteria", "constraints", "validation_scripts", "files", "tests", "limitations", "summary", "commits"];

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

// Everything a write step needs. The tool resolves the workspace, the repository and the
// actual branch before calling, so the core stays testable with an injected exec.
// The item a write step acts on. Both the tool wrapper and the write steps use this, so the
// message is the same from either side.
export function findItem(ledger: Ledger, id: string, path: string): LedgerItem {
	const item = ledger.features.find((feature) => feature.id === id);
	if (!item) throw new Error(`no item ${id} in ${path}`);
	return item;
}

export interface ItemContext {
	cwd: string;
	ledgerPath: string;
	// The parsed ledger the caller read. The write steps use this object and write it back, so the file
	// is parsed once per call and the item reported is the item written.
	ledger: Ledger;
	workspace: string;
	repoRoot: string;
	branch: string;
	id: string;
	exec: Exec;
}

export interface StartResult {
	item: LedgerItem;
	brief: {
		workspace: string;
		goal: string;
		acceptance_criteria: string[];
		constraints: string[];
		files_in: string[];
		tests: string[];
		validation_scripts: string[];
	};
}

export async function startItem(opts: ItemContext): Promise<StartResult> {
	const path = opts.ledgerPath;
	const ledger = opts.ledger;
	const item = findItem(ledger, opts.id, path);
	if (item.status !== "todo") throw new Error(`item ${opts.id} is already ${item.status}; one writer per item`);
	// A per-item branch is an author-written label. It is checked against the repository the item
	// works in, and a mismatch is an error before any work starts.
	if (item.branch && opts.branch && item.branch !== opts.branch) {
		throw new Error(`item ${opts.id} says branch ${item.branch}, but ${opts.workspace} is on ${opts.branch}`);
	}
	const head = (await opts.exec("git", ["rev-parse", "--short", "HEAD"], opts.repoRoot)).stdout.trim();
	if (!head) throw new Error("cannot read HEAD");
	item.status = "in-progress";
	item.commits = { ...item.commits, start: head };
	await ensureParent(path);
	await writeFile(path, serializeLedger(ledger));
	return {
		item,
		brief: {
			workspace: opts.workspace,
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
	| { rejected: false; commit: string; filesOut: string[]; outOfRepo: string[] };

export async function submitItem(opts: ItemContext & {
	commitMessage: string;
	summary: string;
	limitations: string[];
	logDir?: string;
	stat?: EntryStat;
}): Promise<SubmitResult> {
	const path = opts.ledgerPath;
	const ledger = opts.ledger;
	const item = findItem(ledger, opts.id, path);
	if (item.status !== "in-progress") throw new Error(`item ${opts.id} is ${item.status}; submit requires in-progress`);
	if (!item.commits.start) throw new Error(`item ${opts.id} has no commits.start`);

	const head = (await opts.exec("git", ["rev-parse", "HEAD"], opts.repoRoot)).stdout.trim();
	const startFull = (await opts.exec("git", ["rev-parse", item.commits.start], opts.repoRoot)).stdout.trim();
	if (head !== startFull) throw new Error(`HEAD moved during the work (${item.commits.start} is not HEAD); the item must be one commit`);
	const status = await opts.exec("git", ["status", "--porcelain", "-z"], opts.repoRoot);
	const paths = await addablePaths(status.stdout, opts.repoRoot, opts.stat ?? lstat);
	if (paths.length === 0) throw new Error("the working tree has no changes");

	const scripts = item.validation_scripts ?? ledger.validation_scripts;
	// Validation runs from the item's workspace root. A script that needs another repository cd's
	// into it itself.
	for (const script of scripts) {
		const result = await opts.exec("sh", ["-c", script], opts.workspace);
		if (result.code !== 0) {
			const output = `${result.stdout}${result.stderr}`;
			const logDir = opts.logDir ?? "/tmp";
			const logPath = join(logDir, `ledger-${opts.id}-${Date.now()}.log`);
			await writeFile(logPath, `$ ${script}\n${output}`);
			const lastOutput = output.split("\n").filter((line) => line !== "").slice(-20).join("\n");
			return { rejected: true, script, exit: result.code, logPath, lastOutput };
		}
	}

	// -A so a removal inside the pathspec is recorded, not only the added files.
	const staged = await opts.exec("git", ["add", "-A", "--", ...paths], opts.repoRoot);
	if (staged.code !== 0) throw new Error(`git add failed: ${staged.stderr || staged.stdout}`);
	const commit = await opts.exec("git", ["commit", "-m", opts.commitMessage], opts.repoRoot);
	if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
	const end = (await opts.exec("git", ["rev-parse", "--short", "HEAD"], opts.repoRoot)).stdout.trim();
	const diff = await opts.exec("git", ["diff", "--name-only", item.commits.start, end], opts.repoRoot);
	// Every entry reads from the session root: a path inside the item's workspace is prefixed with it.
	const filesOut = prefixFromRoot(opts.cwd, opts.workspace, opts.repoRoot, diff.stdout.split("\n").filter((line) => line !== ""));
	// Changes outside the item's repository are reported as a warning, never committed. Nothing is
	// claimed when the session root is not a git repository. Porcelain paths read from the repository
	// root, so the containment check and the printed path both use the session root's repository.
	const outOfRepo: string[] = [];
	const sessionRoot = await resolveRepoRoot(opts.cwd, opts.exec);
	if (sessionRoot) {
		const session = await opts.exec("git", ["status", "--porcelain", "-z"], opts.cwd);
		if (session.code === 0) {
			const outside = parsePorcelain(session.stdout).filter((entry) => !isInside(join(sessionRoot, entry.path), opts.repoRoot));
			outOfRepo.push(...prefixFromRoot(opts.cwd, opts.cwd, sessionRoot, outside.map((entry) => entry.path)));
		}
	}

	item.files = { in: item.files.in, out: filesOut };
	item.summary = opts.summary;
	item.limitations = [...item.limitations, ...opts.limitations];
	item.commits = { start: item.commits.start, end };
	item.status = "done";
	await ensureParent(path);
	await writeFile(path, serializeLedger(ledger));
	return { rejected: false, commit: end, filesOut, outOfRepo };
}
