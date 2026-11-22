#!/usr/bin/env node
// Pi extension for the feature-ledger workflow. The workflow lives in
// skills/feature-ledger/SKILL.md; these tools cover the steps an agent cannot
// do reliably by hand: reading where a feature stands, the status transition, and
// the validation-gated commit. The read tools (ledger_list, ledger_next) never write.
// Core logic is in ledger.ts so it is testable without a Pi session.

import { access, readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { checkParsed, findItem, listItems, missingInputWarning, missingPlanProblem, missingWorkspaceProblem, nextItem, outsideRepoProblem, parseLedger, problemTarget, planReference, resolveLedgerPath, resolveRepoRoot, resolveWorkspace, startItem, submitItem, type Exec, type ExecResult, type ItemContext, type Ledger, type LedgerItem, type StartResult } from "./ledger.ts";

// The same path argument on every tool. It is never required: without it the path comes
// from the resolution order.
const PATH_DESCRIPTION = "Ledger file. Without it the path is resolved in order: PI_LEDGER_PATH, then the first line of plan/ledger.path in the session root, then plan/ledger.yaml. Any extension is accepted; a relative path resolves against the session root.";
const PATH_PROPERTY = { type: "string", description: PATH_DESCRIPTION };

const LIST_PARAMS = {
	type: "object",
	properties: { path: PATH_PROPERTY },
	required: [],
	additionalProperties: false,
} as unknown as TSchema;

const START_PARAMS = {
	type: "object",
	properties: {
		id: { type: "string", description: "Feature id in the resolved ledger file" },
		path: PATH_PROPERTY,
	},
	required: ["id"],
	additionalProperties: false,
} as unknown as TSchema;

const CHECK_PARAMS = {
	type: "object",
	properties: { path: PATH_PROPERTY },
	required: [],
	additionalProperties: false,
} as unknown as TSchema;

const SUBMIT_PARAMS = {
	type: "object",
	properties: {
		id: { type: "string", description: "Feature id in the resolved ledger file" },
		commit_message: { type: "string", description: "Commit message for the single commit this item produces" },
		summary: { type: "string", description: "What was done, in past tense" },
		limitations: { type: "array", items: { type: "string" }, description: "Known limitations to append to the item" },
		path: PATH_PROPERTY,
	},
	required: ["id", "commit_message", "summary"],
	additionalProperties: false,
} as unknown as TSchema;

const POINTER_FILE = join("plan", "ledger.path");
const DEFAULT_LEDGER = "plan/ledger.yaml";

// The pointer file is read at call time: one line, one path. A missing or unreadable file
// contributes nothing to the resolution order.
async function readPointer(cwd: string): Promise<string> {
	try {
		const text = await readFile(join(cwd, POINTER_FILE), "utf8");
		return text.split("\n")[0]?.trim() ?? "";
	} catch {
		return "";
	}
}

async function resolvePath(ctx: ExtensionContext, explicit?: string): Promise<string> {
	return resolveLedgerPath(ctx.cwd, { explicit, env: process.env.PI_LEDGER_PATH, pointer: await readPointer(ctx.cwd), default: DEFAULT_LEDGER });
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Names each required field that is missing, in the order of the required list.
// The tool wrapper reports it as "id: missing" rather than only the arguments received.
function missingRequired(params: Record<string, unknown>, required: string[]): string[] {
	return required.filter((field) => params[field] === undefined || params[field] === "");
}

function briefText(item: LedgerItem, brief: StartResult["brief"]): string {
	const lines = [
		`ledger_start: ${item.id} is in-progress (commit ${item.commits.start})`,
		"",
		`Workspace: ${brief.workspace}`,
		`Goal: ${brief.goal}`,
		"",
		"Acceptance criteria:",
		...brief.acceptance_criteria.map((criterion) => `- ${criterion}`),
		"",
		"Constraints:",
		...brief.constraints.map((constraint) => `- ${constraint}`),
		"",
		"Files in:",
		...brief.files_in.map((file) => `- ${file}`),
		"",
		"Tests:",
		...brief.tests.map((testLine) => `- ${testLine}`),
		"",
		`Validation scripts (run by ledger_submit from the item's workspace root): ${brief.validation_scripts.join(", ")}`,
	];
	return lines.join("\n");
}

export default function featureLedger(pi: ExtensionAPI): void {
	const exec: Exec = async (command, args, cwd): Promise<ExecResult> => {
		const result = await pi.exec(command, args, { cwd });
		return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	};

	async function readBranch(repoRoot: string): Promise<string> {
		// symbolic-ref gives the real branch name before the first commit; rev-parse gives HEAD there.
		// Keep rev-parse as the fallback for a detached HEAD, where symbolic-ref fails.
		const symbolic = await exec("git", ["symbolic-ref", "--short", "HEAD"], repoRoot);
		const branch = symbolic.stdout.trim() || (await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoRoot)).stdout.trim();
		if (!branch) throw new Error("cannot read the current branch");
		return branch;
	}

	// The workspace, repository and actual branch an item works in. Only the write steps need a
	// repository; the read tools never resolve one.
	async function itemContext(ctx: ExtensionContext, ledgerPath: string, ledger: Ledger, item: LedgerItem): Promise<ItemContext> {
		const workspace = resolveWorkspace(ctx.cwd, item, ledger.workspace);
		const repoRoot = await resolveRepoRoot(workspace, exec);
		if (!repoRoot) throw new Error(`no git repository at ${workspace}`);
		return { cwd: ctx.cwd, ledgerPath, ledger, workspace, repoRoot, branch: await readBranch(repoRoot), id: item.id, exec };
	}

	// Read tools do not touch git: the path comes from the resolution order, not from a branch.
	async function readLedger(ctx: ExtensionContext, explicit?: string, forWrite = false): Promise<{ path: string; ledger: Ledger }> {
		const path = await resolvePath(ctx, explicit);
		const text = await readFile(path, "utf8");
		const parsed = parseLedger(text);
		if (!parsed.ledger) throw new Error(`cannot read the ledger: ${parsed.problems.join("; ")}`);
		if (forWrite) {
			const problems = checkParsed(parsed);
			if (problems.length) throw new Error(`invalid ledger: ${problems.join("; ")}`);
		}
		return { path, ledger: parsed.ledger };
	}

	pi.registerTool({
		name: "ledger_list",
		label: "Ledger list",
		description: "Read every ledger item in file order. Returns JSON: branch, and for each item id, status, short_goal, workspace, and commits (start is null for a todo item, end is null for an in-progress item). Errors when an item has no short_goal value. Read-only. The ledger path is resolved in order: an optional path argument, then PI_LEDGER_PATH, then plan/ledger.path in the session root, then plan/ledger.yaml. Any extension is accepted.",
		parameters: LIST_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const result = listItems((await readLedger(ctx, params.path)).ledger);
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
			} catch (error) {
				return { content: [{ type: "text", text: `ledger_list: ${message(error)}` }], details: {}, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "ledger_next",
		label: "Ledger next",
		description: "Read the next item to work on: the first in-progress item, else the first todo. Returns JSON { next: { id, status, short_goal, workspace }, status } where status is the ledger state (todo when nothing is started, in-progress when at least one item is in-progress or done, done when all are done and next is null). Errors when the selected item has no short_goal value. Read-only. The ledger path is resolved in order: an optional path argument, then PI_LEDGER_PATH, then plan/ledger.path in the session root, then plan/ledger.yaml. Any extension is accepted.",
		parameters: LIST_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const result = nextItem((await readLedger(ctx, params.path)).ledger);
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
			} catch (error) {
				return { content: [{ type: "text", text: `ledger_next: ${message(error)}` }], details: {}, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "ledger_check",
		label: "Ledger check",
		description: "Validate a ledger file. Reports parse problems plus one line per duplicate id. Read-only: it never writes the ledger. Output is JSON { path, ok, problems, warnings }; ok is true when there are no problems, and isError is set only when problems exist. A warning does not make the check fail. The ledger path is resolved in order: an optional path argument, then PI_LEDGER_PATH, then plan/ledger.path in the session root, then plan/ledger.yaml. Any extension is accepted. It reports a workspace that does not exist or is not inside a git repository, and a goal that names a plan file that does not exist, as problems. A files.in entry that does not exist yet is a warning, not a problem: an author may name a file an earlier step will create. Plan references resolve against the session root.",
		parameters: CHECK_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const path = await resolvePath(ctx, params.path);
				const parsed = parseLedger(await readFile(path, "utf8"));
				const problems = checkParsed(parsed);
				// A warning is reported and does not fail the check. Only problems set ok and isError.
				const warnings: string[] = [];
				// These need the filesystem and git, so they run here and not in checkLedger. Plan
				// references resolve against the session root, not the repository.
				if (parsed.ledger) {
					for (const [i, item] of parsed.ledger.features.entries()) {
						const at = problemTarget(parsed.indexes[i], item.id, "workspace");
						const workspace = resolveWorkspace(ctx.cwd, item, parsed.ledger.workspace);
						try {
							await access(workspace);
						} catch {
							problems.push(missingWorkspaceProblem(at, workspace));
							continue;
						}
						if (!(await resolveRepoRoot(workspace, exec))) problems.push(outsideRepoProblem(at, workspace));
						for (const entry of item.files.in) {
							const target = isAbsolute(entry) ? entry : join(ctx.cwd, entry);
							try {
								await access(target);
							} catch {
								warnings.push(missingInputWarning(problemTarget(parsed.indexes[i], item.id, "files.in"), target));
							}
						}
						const ref = planReference(item.goal);
						if (ref) {
							try {
								await access(join(ctx.cwd, ref));
							} catch {
								problems.push(missingPlanProblem(problemTarget(parsed.indexes[i], item.id, "goal"), ref));
							}
						}
					}
				}
				const result = { path, ok: problems.length === 0, problems, warnings };
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {}, isError: problems.length > 0 };
			} catch (error) {
				return { content: [{ type: "text", text: `ledger_check: ${message(error)}` }], details: {}, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "ledger_start",
		label: "Ledger start",
		description: "Read a feature ledger item and mark it in-progress. Returns the item brief: goal, acceptance criteria, constraints, files.in, tests. Refuses when the item is not todo. The item's workspace is resolved (the item value, else the ledger default, else the session root), and a per-item branch is checked against that repository. The ledger path is resolved in order: an optional path argument, then PI_LEDGER_PATH, then plan/ledger.path in the session root, then plan/ledger.yaml. Any extension is accepted.",
		parameters: START_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const { path, ledger } = await readLedger(ctx, params.path, true);
				const item = findItem(ledger, params.id, path);
				// The file is parsed once, and the brief reports the item the write path returned.
				const { item: started, brief } = await startItem(await itemContext(ctx, path, ledger, item));
				return { content: [{ type: "text", text: briefText(started, brief) }], details: {} };
			} catch (error) {
				return { content: [{ type: "text", text: `ledger_start: ${message(error)}` }], details: {}, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "ledger_submit",
		label: "Ledger submit",
		description: "Validate and commit a ledger item. Pass id first. Checks the item state first: the item must be in-progress, HEAD must still be the recorded start commit, and the working tree must have changes. Then it runs the item's validation scripts (item override, else the base list); any failure rejects the submit and writes the full output to a log file. On success: git add -A, one commit, files.out from the diff, summary and limitations recorded, item marked done. Validation runs from the item's workspace; the commit is made inside that repository, and changes outside it are reported as a warning line, not committed. The ledger path is resolved in order: an optional path argument, then PI_LEDGER_PATH, then plan/ledger.path in the session root, then plan/ledger.yaml. Any extension is accepted.",
		parameters: SUBMIT_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const missing = missingRequired(params, SUBMIT_PARAMS.required as string[]);
				if (missing.length > 0) throw new Error(missing.map((field) => `${field}: missing`).join(", "));
				const { path, ledger } = await readLedger(ctx, params.path, true);
				const item = findItem(ledger, params.id, path);
				const opts = await itemContext(ctx, path, ledger, item);
				const result = await submitItem({ ...opts, commitMessage: params.commit_message, summary: params.summary, limitations: params.limitations ?? [], logDir: process.env.TMPDIR || "/tmp" });
				if (result.rejected) {
					return {
						content: [{ type: "text", text: `ledger_submit: rejected by ${result.script} (exit ${result.exit})\nFull output: ${result.logPath}\nLast output:\n${result.lastOutput}` }],
						details: {},
						isError: true,
					};
				}
				const warning = result.outOfRepo.length > 0
					? `\nwarning: changes outside ${opts.workspace} are not committed:\n${result.outOfRepo.map((file) => `- ${file}`).join("\n")}`
					: "";
				return {
					content: [{ type: "text", text: `ledger_submit: ${params.id} is done (commit ${result.commit})\nfiles.out:\n${result.filesOut.map((file) => `- ${file}`).join("\n")}${warning}` }],
					details: {},
				};
			} catch (error) {
				return { content: [{ type: "text", text: `ledger_submit: ${message(error)}` }], details: {}, isError: true };
			}
		},
	});
}
