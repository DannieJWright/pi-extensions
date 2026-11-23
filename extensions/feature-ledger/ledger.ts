// Feature ledger core: the ledger file model and the start/submit steps.
// The tools in index.ts call these; the logic is kept here so it is testable
// without a Pi session.

import { randomUUID } from "node:crypto";
import { lstat, type Stats } from "node:fs/promises";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseYaml, serializeYaml } from "../../lib/yaml.ts";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (command: string, args: string[], cwd: string) => Promise<ExecResult>;

export const STATUSES = ["todo", "in-progress", "review", "done"] as const;
export type ItemStatus = (typeof STATUSES)[number];
export const FINDING_STATUSES = ["open", "closed"] as const;
export const FINDING_SEVERITIES = ["blocker", "major", "minor", "nit"] as const;
export const ASSIGNMENT_ROLES = ["worker", "reviewer"] as const;
export const DEFAULT_MAX_FAILED_REVIEWS = 5;

export interface Finding {
	id: string;
	status: (typeof FINDING_STATUSES)[number];
	details: string;
	rationale: string;
	severity: (typeof FINDING_SEVERITIES)[number];
	first_found_iteration: number;
	required_checks: string[];
}

export interface Assignment {
	id: string;
	role: (typeof ASSIGNMENT_ROLES)[number];
	agent_id: string;
	claim_token: string;
}

export interface LedgerItem {
	id: string;
	status: ItemStatus;
	goal: string;
	short_goal: string;
	workspace?: string;
	branch?: string;
	review?: boolean;
	max_failed_reviews?: number;
	failed_reviews?: number;
	assignment?: Assignment;
	findings?: Finding[];
	acceptance_criteria: string[];
	constraints: string[];
	validation_scripts?: string[];
	files: { in: string[]; out: string[] };
	tests: string[];
	limitations: string[];
	summary: string;
	commits: { start?: string; end?: string; expected?: string; submissions?: string[] };
}

export interface Ledger {
	description: string;
	workspace: string;
	branch: string;
	max_failed_reviews?: number;
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
	return `${at} names a path that does not exist yet (${path})`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonnegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function effectiveReviewConfig(ledger: Ledger, item: LedgerItem): { enabled: boolean; max_failed_reviews: number } {
	if (item.review !== undefined && typeof item.review !== "boolean") throw new Error("review must be a boolean");
	for (const value of [ledger.max_failed_reviews, item.max_failed_reviews]) {
		if (value !== undefined && !nonnegativeInteger(value)) throw new Error("max_failed_reviews must be a nonnegative integer");
	}
	return { enabled: item.review ?? false, max_failed_reviews: item.max_failed_reviews ?? ledger.max_failed_reviews ?? DEFAULT_MAX_FAILED_REVIEWS };
}

// Validate the raw document before projecting it into typed model values. Invalid review data is
// retained for diagnostics, never normalized into an apparently valid default.
function validateReviewFields(ledger: Record<string, unknown>, problems: string[]): void {
	const numberField = (record: Record<string, unknown>, key: string, at: string) => {
		if (key in record && !nonnegativeInteger(record[key])) problems.push(`${at} must be a nonnegative integer`);
	};
	numberField(ledger, "max_failed_reviews", "ledger.max_failed_reviews");
	if (!Array.isArray(ledger.features)) return;
	for (const [index, raw] of ledger.features.entries()) {
		if (!isRecord(raw)) continue;
		const at = (field: string) => problemTarget(index, String(raw.id ?? ""), field);
		if ("review" in raw && typeof raw.review !== "boolean") problems.push(`${at("review")} must be a boolean`);
		numberField(raw, "max_failed_reviews", at("max_failed_reviews"));
		numberField(raw, "failed_reviews", at("failed_reviews"));
		const iteration = nonnegativeInteger(raw.failed_reviews) ? raw.failed_reviews : 0;
		if (raw.status === "review" && raw.review !== true) problems.push(`${at("status")} review requires review enabled`);
		if (raw.status === "todo" && iteration > 0) problems.push(`${at("failed_reviews")} must be zero for todo`);
		if ("assignment" in raw) {
			if (!isRecord(raw.assignment)) problems.push(`${at("assignment")} must be a mapping`);
			else {
				const assignment = raw.assignment;
				for (const key of ["id", "agent_id", "claim_token"]) {
					if (typeof assignment[key] !== "string" || assignment[key].trim() === "") problems.push(`${at(`assignment.${key}`)} must be a non-empty string`);
				}
				if (!ASSIGNMENT_ROLES.includes(assignment.role as Assignment["role"])) problems.push(`${at("assignment.role")} must be worker or reviewer`);
				else {
					if (assignment.id !== `${raw.id}-${iteration}-${assignment.role}`) problems.push(`${at("assignment.id")} does not match the feature, iteration, and role`);
					if ((assignment.role === "worker" && raw.status !== "in-progress") || (assignment.role === "reviewer" && raw.status !== "review")) problems.push(`${at("assignment.role")} is incompatible with status ${String(raw.status)}`);
				}
			}
		}
		if ("findings" in raw) {
			if (!Array.isArray(raw.findings)) problems.push(`${at("findings")} must be a list`);
			else {
				const ids = new Set<string>();
				if (raw.status === "todo" && raw.findings.length > 0) problems.push(`${at("findings")} must be empty for todo`);
				for (const [i, finding] of raw.findings.entries()) {
					const location = `findings[${i}]`;
					if (!isRecord(finding)) { problems.push(`${at(location)} must be a mapping`); continue; }
					for (const key of ["id", "details", "rationale"]) {
						if (typeof finding[key] !== "string" || finding[key].trim() === "") problems.push(`${at(`${location}.${key}`)} must be a non-empty string`);
					}
					if (typeof finding.id === "string" && finding.id !== "") {
						if (ids.has(finding.id)) problems.push(`${at(`${location}.id`)} is a duplicate`);
						ids.add(finding.id);
					}
					if (!FINDING_STATUSES.includes(finding.status as Finding["status"])) problems.push(`${at(`${location}.status`)} must be open or closed`);
					if (!FINDING_SEVERITIES.includes(finding.severity as Finding["severity"])) problems.push(`${at(`${location}.severity`)} must be blocker, major, minor, or nit`);
					if (!nonnegativeInteger(finding.first_found_iteration)) problems.push(`${at(`${location}.first_found_iteration`)} must be a nonnegative integer`);
					else if (finding.first_found_iteration > iteration) problems.push(`${at(`${location}.first_found_iteration`)} exceeds failed_reviews`);
					if (!Array.isArray(finding.required_checks) || finding.required_checks.some((check: unknown) => typeof check !== "string" || check.trim() === "")) problems.push(`${at(`${location}.required_checks`)} must be a list of non-empty strings`);
					if (raw.status === "done" && finding.status === "open") problems.push(`${at(location)} cannot be open when done`);
				}
			}
		}
		if (isRecord(raw.commits) && "submissions" in raw.commits && (!Array.isArray(raw.commits.submissions) || raw.commits.submissions.some((commit: unknown) => typeof commit !== "string" || commit.trim() === ""))) problems.push(`${at("commits.submissions")} must be a list of non-empty strings`);
	}
}

function assertReviewFields(ledger: Ledger): void {
	const problems: string[] = [];
	validateReviewFields(ledger as unknown as Record<string, unknown>, problems);
	if (problems.length) throw new Error(`invalid ledger: ${problems.join("; ")}`);
}

export function parseLedger(text: string): { ledger: Ledger | null; problems: string[]; indexes: number[] } {
	const problems: string[] = [];
	const indexes: number[] = [];
	const doc = parseYaml(text) as Record<string, unknown>;
	const raw = doc.ledger;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ledger: null, problems: ["no ledger block"], indexes };
	const ledger = raw as Record<string, unknown>;
	validateReviewFields(ledger, problems);
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
			...Object.fromEntries(["review", "max_failed_reviews", "failed_reviews", "assignment", "findings"].filter((key) => key in item).map((key) => [key, item[key]])),
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
					.map(([key, value]) => [key, value === null || value === undefined ? undefined : key === "submissions" ? value : String(value)])
					.filter(([, value]) => value !== undefined),
			) as LedgerItem["commits"],
		});
	}
	return {
		ledger: {
			description: typeof ledger.description === "string" ? ledger.description : "",
			workspace: typeof ledger.workspace === "string" ? ledger.workspace : "",
			branch: typeof ledger.branch === "string" ? ledger.branch : "",
			...("max_failed_reviews" in ledger ? { max_failed_reviews: ledger.max_failed_reviews as number } : {}),
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

export type LedgerState = "todo" | "in-progress" | "done";

// Orchestration reads are read-only. Order is file order; nothing here writes the ledger.
// branch is only present when the file has it. It is an author-written label, not a git read.
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

// Claims block new todo work but not other eligible retries.
// Selection priority: review first, then an eligible unassigned in-progress item, then a todo
// item only when nothing is in flight. Root status stays todo when nothing is started and done
// when everything is done; otherwise in-progress (at least one item is in-progress or done).
export function orchestrateList(ledger: Ledger) {
	return {
		...(ledger.branch ? { branch: ledger.branch } : {}),
		items: ledger.features.map((item) => ({
			id: item.id, status: item.status, short_goal: requireShortGoal(item),
			workspace: itemWorkspace(ledger, item), commits: item.commits,
			assignment: item.assignment ?? null,
			failed_reviews: item.failed_reviews ?? 0,
			config: effectiveReviewConfig(ledger, item),
			capped: isReviewCapped(ledger, item),
		})),
	};
}

function isReviewCapped(ledger: Ledger, item: LedgerItem): boolean {
	const { max_failed_reviews } = effectiveReviewConfig(ledger, item);
	return item.status === "in-progress" && max_failed_reviews > 0 && (item.failed_reviews ?? 0) >= max_failed_reviews;
}

export function orchestrateNext(ledger: Ledger) {
	const { items } = orchestrateList(ledger);
	const assigned = items.filter((item) => item.assignment !== null);
	const capped = items.filter((item) => item.capped);
	const inFlight = items.some((item) => item.status === "review" || item.status === "in-progress" || item.assignment !== null);
	const next = items.find((item) => item.status === "review" && !item.assignment)
		?? items.find((item) => item.status === "in-progress" && !item.assignment && !item.capped)
		?? (!inFlight ? items.find((item) => item.status === "todo" && !item.assignment) : undefined)
		?? null;
	const status: LedgerState = items.length === 0 || items.every((item) => item.status === "todo") ? "todo"
		: items.every((item) => item.status === "done") ? "done" : "in-progress";
	return { next, status, assigned, capped };
}

export async function releaseClaim(ledger: Ledger, path: string, id: string, agentId: string, claimToken: string): Promise<LedgerItem> {
	assertReviewFields(ledger);
	const item = findItem(ledger, id, path);
	if (!agentId?.trim() || !claimToken?.trim() || !item.assignment || item.assignment.agent_id !== agentId || item.assignment.claim_token !== claimToken) {
		throw new Error(`item ${id} has no matching claim (agent_id and claim_token required)`);
	}
	delete item.assignment;
	try {
		await writeFile(path, serializeLedger(ledger));
	} catch (error) {
		throw new Error(`release could not write the ledger; ${path} may be partially written. Inspect before retrying: ${String(error)}`);
	}
	return item;
}

const ITEM_KEYS = ["id", "status", "goal", "short_goal", "workspace", "branch", "review", "max_failed_reviews", "failed_reviews", "assignment", "findings", "acceptance_criteria", "constraints", "validation_scripts", "files", "tests", "limitations", "summary", "commits"];

export function serializeLedger(ledger: Ledger): string {
	assertReviewFields(ledger);
	const ordered: Record<string, unknown> = {
		description: ledger.description,
		workspace: ledger.workspace,
		branch: ledger.branch,
		...(ledger.max_failed_reviews !== undefined ? { max_failed_reviews: ledger.max_failed_reviews } : {}),
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

export type SubmitResult =
	| { rejected: true; script: string; exit: number; logPath: string; lastOutput: string }
	| { rejected: false; commit: string; filesOut: string[]; outOfRepo: string[] };

export interface PatchView {
	files: string[];
	stat: string;
	patch: string;
	truncated: boolean;
	full_patch_path?: string;
}

export interface DiffView {
	from: string;
	to: string;
	implementation: PatchView;
	ledger_metadata: PatchView;
}

// A start response may contain four patches; keep their combined previews bounded.
const PATCH_LIMIT_BYTES = 4 * 1024;

async function gitResult(opts: ItemContext, args: string[]): Promise<string> {
	const result = await opts.exec("git", args, opts.repoRoot);
	if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout}`);
	return result.stdout;
}

function ledgerRepoPath(opts: ItemContext): string | undefined {
	return isInside(opts.ledgerPath, opts.repoRoot) ? relative(opts.repoRoot, opts.ledgerPath) : undefined;
}

async function patchView(opts: ItemContext, from: string, to: string, pathspec: string[], artifactDir: string): Promise<PatchView> {
	const args = [from, to, "--", ...pathspec];
	const files = (await gitResult(opts, ["diff", "--name-only", "-z", ...args])).split("\0").filter(Boolean);
	const stat = await gitResult(opts, ["diff", "--stat", ...args]);
	const fullPatch = await gitResult(opts, ["diff", "--binary", ...args]);
	const bytes = Buffer.from(fullPatch);
	if (bytes.length <= PATCH_LIMIT_BYTES) return { files, stat, patch: fullPatch, truncated: false };
	const dir = await mkdtemp(join(artifactDir, "ledger-patch-"));
	const fullPatchPath = join(dir, "full.patch");
	await writeFile(fullPatchPath, fullPatch);
	return { files, stat, patch: `${bytes.subarray(0, PATCH_LIMIT_BYTES).toString("utf8")}\n[Patch truncated; full patch: ${fullPatchPath}]`, truncated: true, full_patch_path: fullPatchPath };
}

export async function workDiff(opts: ItemContext, from: string, to: string, artifactDir = tmpdir()): Promise<DiffView> {
	const ledgerPath = ledgerRepoPath(opts);
	const implementation = await patchView(opts, from, to, ledgerPath ? [".", `:(exclude,literal)${ledgerPath}`] : ["."], artifactDir);
	const ledger_metadata = ledgerPath
		? await patchView(opts, from, to, [`:(literal)${ledgerPath}`], artifactDir)
		: { files: [], stat: "", patch: "", truncated: false };
	return { from, to, implementation, ledger_metadata };
}

function requireWorkerBranch(opts: ItemContext, item: LedgerItem): void {
	if (item.branch && item.branch !== opts.branch) throw new Error(`item ${opts.id} says branch ${item.branch}, but ${opts.workspace} is on ${opts.branch}`);
}

function requireWorkerEligibility(ledger: Ledger, item: LedgerItem): void {
	const config = effectiveReviewConfig(ledger, item);
	if (config.max_failed_reviews > 0 && (item.failed_reviews ?? 0) >= config.max_failed_reviews) {
		throw new Error(`item ${item.id} reached the failed-review limit ${config.max_failed_reviews}; change the limit or resolve the item before starting or submitting`);
	}
}

export async function startWork(opts: ItemContext & { agentId: string; artifactDir?: string }): Promise<{
	item: LedgerItem;
	config: { enabled: boolean; max_failed_reviews: number; validation_scripts: string[] };
	pending_findings: Finding[];
	workspace: string;
	cumulative_diff: DiffView;
	latest_diff: DiffView | null;
}> {
	assertReviewFields(opts.ledger);
	const item = findItem(opts.ledger, opts.id, opts.ledgerPath);
	if (!opts.agentId?.trim()) throw new Error("agent_id: must be a non-empty string");
	if (item.status !== "todo" && item.status !== "in-progress") throw new Error(`item ${item.id} is ${item.status}; worker start requires todo or in-progress`);
	if (item.assignment) throw new Error(`item ${item.id} is already assigned to ${item.assignment.agent_id}`);
	requireWorkerEligibility(opts.ledger, item);
	requireWorkerBranch(opts, item);
	const head = (await gitResult(opts, ["rev-parse", "HEAD"])).trim();
	if (!head) throw new Error("cannot read HEAD");
	if (!item.commits.start && ((item.failed_reviews ?? 0) > 0 || (item.commits.submissions?.length ?? 0) > 0)) throw new Error(`item ${item.id} has no feature base commit`);
	const base = item.commits.start ?? head;
	const cumulative_diff = await workDiff(opts, base, head, opts.artifactDir);
	const latest = item.commits.submissions?.at(-1);
	const latest_diff = latest ? await workDiff(opts, `${latest}^`, latest, opts.artifactDir) : null;
	item.status = "in-progress";
	item.commits = { ...item.commits, start: base, expected: head };
	item.assignment = { id: `${item.id}-${item.failed_reviews ?? 0}-worker`, role: "worker", agent_id: opts.agentId, claim_token: randomUUID() };
	try {
		await ensureParent(opts.ledgerPath);
		await writeFile(opts.ledgerPath, serializeLedger(opts.ledger));
	} catch (error) {
		throw new Error(`worker start could not write the claim; ledger write may be partial, inspect ${opts.ledgerPath} before retrying: ${String(error)}`);
	}
	return { item, config: { ...effectiveReviewConfig(opts.ledger, item), validation_scripts: item.validation_scripts ?? opts.ledger.validation_scripts }, pending_findings: (item.findings ?? []).filter((finding) => finding.status === "open"), workspace: opts.workspace, cumulative_diff, latest_diff };
}

export async function submitWork(opts: ItemContext & {
	agentId: string;
	claimToken: string;
	commitMessage: string;
	summary: string;
	limitations: string[];
	emptyCommit?: boolean;
	logDir?: string;
	stat?: EntryStat;
}): Promise<SubmitResult> {
	assertReviewFields(opts.ledger);
	const item = findItem(opts.ledger, opts.id, opts.ledgerPath);
	if (item.status !== "in-progress") throw new Error(`item ${item.id} is ${item.status}; worker submit requires in-progress`);
	if (!opts.agentId?.trim() || !opts.claimToken?.trim() || !item.assignment || item.assignment.role !== "worker" || item.assignment.agent_id !== opts.agentId || item.assignment.claim_token !== opts.claimToken) throw new Error(`item ${item.id} has no matching worker claim (agent_id and claim_token required)`);
	if (!opts.commitMessage?.trim() || !opts.summary?.trim()) throw new Error("commit_message and summary must be non-empty strings");
	if (opts.emptyCommit && (item.failed_reviews ?? 0) === 0) throw new Error("an empty commit is allowed only for a review-fix iteration");
	requireWorkerEligibility(opts.ledger, item);
	requireWorkerBranch(opts, item);
	if (!item.commits.start || !item.commits.expected) throw new Error(`item ${item.id} lacks the feature base or expected HEAD`);
	const checkHead = async () => {
		const head = (await gitResult(opts, ["rev-parse", "HEAD"])).trim();
		const expected = (await gitResult(opts, ["rev-parse", item.commits.expected!])).trim();
		if (head !== expected) throw new Error(`HEAD moved since worker start (${item.commits.expected} is not HEAD); inspect before recovery`);
	};
	await checkHead();
	const workPaths = async () => {
		const status = await gitResult(opts, ["status", "--porcelain", "-z", "--untracked-files=all", "--no-renames"]);
		const ledgerPath = ledgerRepoPath(opts);
		const entries = parsePorcelain(status);
		const paths = [...new Set((await addablePaths(status, opts.repoRoot, opts.stat ?? lstat)).filter((path) => path !== ledgerPath))];
		// Git add cannot match a path already deleted from the index. Commit --only can
		// still match its HEAD version; a recreated untracked path must instead be added.
		const stagePaths = paths.filter((path) => !entries.some((entry) => entry.path === path && entry.status === "D ") || entries.some((entry) => entry.path === path && entry.status === "??"));
		return { paths, stagePaths };
	};
	let { paths, stagePaths } = await workPaths();
	if (!opts.emptyCommit && paths.length === 0) throw new Error("the working tree has no implementation changes (ledger metadata alone is not work)");
	for (const script of item.validation_scripts ?? opts.ledger.validation_scripts) {
		const result = await opts.exec("sh", ["-c", script], opts.workspace);
		if (result.code !== 0) {
			const output = `${result.stdout}${result.stderr}`;
			const logPath = join(opts.logDir ?? tmpdir(), `ledger-${opts.id}-${randomUUID()}.log`);
			await writeFile(logPath, `$ ${script}\n${output}`);
			return { rejected: true, script, exit: result.code, logPath, lastOutput: output.split("\n").filter(Boolean).slice(-20).join("\n") };
		}
	}
	await checkHead();
	const branch = (await gitResult(opts, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
	if (branch !== opts.branch) throw new Error(`branch changed during validation (${opts.branch} to ${branch}); inspect before recovery`);
	({ paths, stagePaths } = await workPaths());
	if (!opts.emptyCommit && paths.length === 0) throw new Error("validation left no implementation changes to commit");
	if (!opts.emptyCommit && stagePaths.length) {
		try {
			const staged = await opts.exec("git", ["add", "-A", "--", ...stagePaths.map((path) => `:(literal)${path}`)], opts.repoRoot);
			if (staged.code !== 0) throw new Error(staged.stderr || staged.stdout);
		} catch (error) {
			throw new Error(`git add failed; inspect the index before retrying: ${String(error)}`);
		}
	}
	const args = opts.emptyCommit ? ["commit", "--only", "--allow-empty", "-m", opts.commitMessage] : ["commit", "--only", "-m", opts.commitMessage, "--", ...paths.map((path) => `:(literal)${path}`)];
	let commitAttempted = false;
	let end = "";
	try {
		commitAttempted = true;
		const commit = await opts.exec("git", args, opts.repoRoot);
		if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
		end = (await gitResult(opts, ["rev-parse", "HEAD"])).trim();
		if (!end) throw new Error("cannot read new HEAD");
		const ledgerPath = ledgerRepoPath(opts);
		const nameArgs = ["diff", "--name-only", "-z", item.commits.start, end, "--", ".", ...(ledgerPath ? [`:(exclude,literal)${ledgerPath}`] : [])];
		const names = (await gitResult(opts, nameArgs)).split("\0").filter(Boolean);
		const filesOut = prefixFromRoot(opts.cwd, opts.workspace, opts.repoRoot, names);
		const outOfRepo: string[] = [];
		const sessionRoot = await resolveRepoRoot(opts.cwd, opts.exec);
		if (sessionRoot) {
			const session = await opts.exec("git", ["status", "--porcelain", "-z"], opts.cwd);
			if (session.code === 0) {
				const outside = parsePorcelain(session.stdout).filter((entry) => !isInside(join(sessionRoot, entry.path), opts.repoRoot));
				outOfRepo.push(...prefixFromRoot(opts.cwd, opts.cwd, sessionRoot, outside.map((entry) => entry.path)));
			}
		}
		item.files = { ...item.files, out: filesOut };
		item.summary = opts.summary;
		item.limitations = [...item.limitations, ...opts.limitations];
		item.commits = { ...item.commits, end, submissions: [...(item.commits.submissions ?? []), end] };
		delete item.commits.expected;
		delete item.assignment;
		item.status = effectiveReviewConfig(opts.ledger, item).enabled ? "review" : "done";
		await ensureParent(opts.ledgerPath);
		await writeFile(opts.ledgerPath, serializeLedger(opts.ledger));
		return { rejected: false, commit: end, filesOut, outOfRepo };
	} catch (error) {
		if (commitAttempted) throw new Error(`worker submission ${end ? `created commit ${end}` : "may have created a commit (commit result or HEAD is uncertain)"}; ledger update may be incomplete. Do not retry blindly; inspect HEAD, index, and ${opts.ledgerPath} and reconcile the claim and history: ${String(error)}`);
		throw error;
	}
}

export type NewFinding = Pick<Finding, "details" | "rationale" | "severity" | "required_checks">;

// A review claim uses the same workspace and diff context as a worker claim.
export async function startReview(opts: ItemContext & { agentId: string; artifactDir?: string }): ReturnType<typeof startWork> {
	assertReviewFields(opts.ledger);
	const item = findItem(opts.ledger, opts.id, opts.ledgerPath);
	if (!opts.agentId?.trim()) throw new Error("agent_id: must be a non-empty string");
	if (item.status !== "review") throw new Error(`item ${item.id} is ${item.status}; reviewer start requires review`);
	if (item.assignment) throw new Error(`item ${item.id} is already assigned to ${item.assignment.agent_id}`);
	requireWorkerBranch(opts, item);
	if (!item.commits.start) throw new Error(`item ${item.id} has no feature base commit`);
	const head = (await gitResult(opts, ["rev-parse", "HEAD"])).trim();
	if (!head) throw new Error("cannot read HEAD");
	const cumulative_diff = await workDiff(opts, item.commits.start, head, opts.artifactDir);
	const latest = item.commits.submissions?.at(-1);
	const latest_diff = latest ? await workDiff(opts, `${latest}^`, latest, opts.artifactDir) : null;
	item.assignment = { id: `${item.id}-${item.failed_reviews ?? 0}-reviewer`, role: "reviewer", agent_id: opts.agentId, claim_token: randomUUID() };
	try {
		await ensureParent(opts.ledgerPath);
		await writeFile(opts.ledgerPath, serializeLedger(opts.ledger));
	} catch (error) {
		throw new Error(`reviewer start could not write the claim; ledger write may be partial, inspect ${opts.ledgerPath} before retrying: ${String(error)}`);
	}
	return { item, config: { ...effectiveReviewConfig(opts.ledger, item), validation_scripts: item.validation_scripts ?? opts.ledger.validation_scripts }, pending_findings: (item.findings ?? []).filter((finding) => finding.status === "open"), workspace: opts.workspace, cumulative_diff, latest_diff };
}

// Resolve the ledger repository independently of the workspace. An untracked path is not committed.
async function trackedLedger(opts: ItemContext): Promise<{ root: string; path: string; head: string } | null> {
	const dir = dirname(opts.ledgerPath);
	const result = await opts.exec("git", ["rev-parse", "--show-toplevel"], dir);
	if (result.code !== 0) {
		if (/not a git repository/i.test(result.stderr)) return null;
		throw new Error(`cannot inspect ledger repository: ${result.stderr || result.stdout}`);
	}
	const root = result.stdout.trim();
	if (!root || !isInside(opts.ledgerPath, root)) throw new Error("cannot resolve ledger repository path");
	const path = relative(root, opts.ledgerPath);
	const files = await opts.exec("git", ["ls-files", "-z", "--", `:(literal)${path}`], root);
	if (files.code !== 0) throw new Error(`cannot check whether ledger is tracked: ${files.stderr || files.stdout}`);
	const head = await opts.exec("git", ["rev-parse", "--verify", "HEAD"], root);
	if (head.code !== 0 || !head.stdout.trim()) {
		if (head.stderr.includes("Needed a single revision")) {
			const branch = await opts.exec("git", ["symbolic-ref", "--quiet", "HEAD"], root);
			if (branch.code === 0 && branch.stdout.trim()) {
				if (!files.stdout.split("\0").includes(path)) return null;
				return { root, path, head: "(unborn)" };
			}
		}
		throw new Error(`cannot read ledger repository HEAD: ${head.stderr || head.stdout}`);
	}
	if (!files.stdout.split("\0").includes(path)) {
		// A path staged for deletion is absent from the index but remains tracked at HEAD.
		const tree = await opts.exec("git", ["ls-tree", "--name-only", "-z", "HEAD", "--", `:(literal)${path}`], root);
		if (tree.code !== 0) throw new Error(`cannot inspect ledger at HEAD: ${tree.stderr || tree.stdout}`);
		if (!tree.stdout.split("\0").includes(path)) return null;
	}
	return { root, path, head: head.stdout.trim() };
}

export async function submitReview(opts: ItemContext & {
	agentId: string;
	claimToken: string;
	closeFindings: string[];
	newFindings: NewFinding[];
}): Promise<{ status: ItemStatus; failed_reviews: number; open_findings: Finding[]; ledger_commit: string | null; ledger_commit_note: string }> {
	assertReviewFields(opts.ledger);
	const item = findItem(opts.ledger, opts.id, opts.ledgerPath);
	if (item.status !== "review") throw new Error(`item ${item.id} is ${item.status}; reviewer submit requires review`);
	if (!opts.agentId?.trim() || !opts.claimToken?.trim() || !item.assignment || item.assignment.role !== "reviewer" || item.assignment.agent_id !== opts.agentId || item.assignment.claim_token !== opts.claimToken) throw new Error(`item ${item.id} has no matching reviewer claim (agent_id and claim_token required)`);
	requireWorkerBranch(opts, item);
	if (!Array.isArray(opts.closeFindings) || opts.closeFindings.some((id) => typeof id !== "string" || !id.trim())) throw new Error("close_findings must be a list of non-empty IDs");
	if (new Set(opts.closeFindings).size !== opts.closeFindings.length) throw new Error("close_findings contains duplicate IDs");
	const findings = item.findings ?? [];
	for (const id of opts.closeFindings) if (!findings.some((finding) => finding.id === id)) throw new Error(`unknown finding ID ${id}`);
	if (!Array.isArray(opts.newFindings)) throw new Error("new_findings must be a list");
	for (const [index, finding] of opts.newFindings.entries()) {
		if (!isRecord(finding) || Object.keys(finding).some((key) => !["details", "rationale", "severity", "required_checks"].includes(key)) || typeof finding.details !== "string" || !finding.details.trim() || typeof finding.rationale !== "string" || !finding.rationale.trim() || !FINDING_SEVERITIES.includes(finding.severity as Finding["severity"]) || !Array.isArray(finding.required_checks) || finding.required_checks.some((check: unknown) => typeof check !== "string" || !check.trim())) throw new Error(`new_findings[${index}] requires non-empty details and rationale, valid severity, and a list of non-empty required_checks`);
	}
	const iteration = item.failed_reviews ?? 0;
	const ids = new Set(findings.map((finding) => finding.id));
	const additions: Finding[] = opts.newFindings.map((finding) => {
		let id: string;
		do { id = `finding-${randomUUID()}`; } while (ids.has(id));
		ids.add(id);
		return { id, status: "open", ...finding, first_found_iteration: iteration };
	});
	const updated = [...findings.map((finding) => opts.closeFindings.includes(finding.id) ? { ...finding, status: "closed" as const } : finding), ...additions];
	const open = updated.filter((finding) => finding.status === "open");
	if (open.length && !Number.isSafeInteger(iteration + 1)) throw new Error("failed_reviews cannot be incremented safely");
	const tracked = await trackedLedger(opts);
	item.findings = updated;
	item.failed_reviews = open.length ? iteration + 1 : iteration;
	item.status = open.length ? "in-progress" : "done";
	delete item.assignment;
	try {
		await writeFile(opts.ledgerPath, serializeLedger(opts.ledger));
	} catch (error) {
		throw new Error(`review ledger write failed; ${opts.ledgerPath} may be partially written, no commit attempted. Inspect and reconcile before retrying: ${String(error)}`);
	}
	if (!tracked) return { status: item.status, failed_reviews: item.failed_reviews, open_findings: open, ledger_commit: null, ledger_commit_note: "Ledger is untracked, ignored, or outside a repository; written without a commit." };
	let commitAttempted = false;
	let commit = "";
	try {
		if (tracked.head !== "(unborn)") {
			const diff = await opts.exec("git", ["diff", "--quiet", "HEAD", "--", `:(literal)${tracked.path}`], tracked.root);
			if (diff.code !== 0 && diff.code !== 1) throw new Error(`cannot inspect ledger diff: ${diff.stderr || diff.stdout}`);
			if (diff.code === 0) return { status: item.status, failed_reviews: item.failed_reviews, open_findings: open, ledger_commit: null, ledger_commit_note: "Tracked ledger was written but already matches HEAD; no commit needed." };
		}
		commitAttempted = true;
		const result = await opts.exec("git", ["commit", "--only", "-m", `Review ${item.id}`, "--", `:(literal)${tracked.path}`], tracked.root);
		if (result.code !== 0) throw new Error(`git commit failed: ${result.stderr || result.stdout}`);
		const head = await opts.exec("git", ["rev-parse", "HEAD"], tracked.root);
		if (head.code !== 0 || !head.stdout.trim()) throw new Error(`cannot read new ledger HEAD: ${head.stderr || head.stdout}`);
		commit = head.stdout.trim();
		return { status: item.status, failed_reviews: item.failed_reviews, open_findings: open, ledger_commit: commit, ledger_commit_note: "Committed the entire tracked ledger file, including pre-existing edits; unrelated staged files were excluded." };
	} catch (error) {
		throw new Error(`review ledger was written at ${opts.ledgerPath}; ${commit ? `created commit ${commit}` : commitAttempted ? "a commit may have been created (result or HEAD uncertain)" : "no commit was attempted"}. Prior ledger HEAD ${tracked.head}. Do not retry blindly; inspect ledger, HEAD, and index and reconcile: ${String(error)}`);
	}
}
