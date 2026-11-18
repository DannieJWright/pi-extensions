#!/usr/bin/env node
// Pi extension for the feature-ledger workflow. The workflow lives in
// skills/feature-ledger/SKILL.md; these tools cover the steps an agent cannot
// do reliably by hand: reading where a feature stands, the status transition, and
// the validation-gated commit. The read tools (ledger_list, ledger_next) never write.
// Core logic is in ledger.ts so it is testable without a Pi session.

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { checkParsed, ledgerPath, listItems, locationProblem, missingPlanProblem, nextItem, parseLedger, problemTarget, planReference, resolveCheckTarget, startItem, submitItem, trackedPlanProblem, type Exec, type ExecResult, type Ledger, type LedgerItem } from "./ledger.ts";

const EMPTY_PARAMS = {
	type: "object",
	properties: {},
	required: [],
	additionalProperties: false,
} as unknown as TSchema;

const START_PARAMS = {
	type: "object",
	properties: {
		id: { type: "string", description: "Feature id in plan/<branch>/ledger.yaml" },
	},
	required: ["id"],
	additionalProperties: false,
} as unknown as TSchema;

const CHECK_PARAMS = {
	type: "object",
	properties: {
		path: { type: "string", description: "Ledger file to check. Default plan/<branch>/ledger.yaml for the current branch. Use a path for a draft ledger not yet under plan/." },
	},
	required: [],
	additionalProperties: false,
} as unknown as TSchema;

const SUBMIT_PARAMS = {
	type: "object",
	properties: {
		id: { type: "string", description: "Feature id in plan/<branch>/ledger.yaml" },
		commit_message: { type: "string", description: "Commit message for the single commit this item produces" },
		summary: { type: "string", description: "What was done, in past tense" },
		limitations: { type: "array", items: { type: "string" }, description: "Known limitations to append to the item" },
	},
	required: ["id", "commit_message", "summary"],
	additionalProperties: false,
} as unknown as TSchema;

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Names each required field that is missing, in the order of the required list.
// The tool wrapper reports it as "id: missing" rather than only the arguments received.
function missingRequired(params: Record<string, unknown>, required: string[]): string[] {
	return required.filter((field) => params[field] === undefined || params[field] === "");
}

function briefText(item: LedgerItem, brief: { validation_scripts: string[] }): string {
	const lines = [
		`ledger_start: ${item.id} is in-progress (commit ${item.commits.start})`,
		"",
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
		`Validation scripts (run by ledger_submit from the repo root): ${brief.validation_scripts.join(", ")}`,
	];
	return lines.join("\n");
}

export default function featureLedger(pi: ExtensionAPI): void {
	const exec: Exec = async (command, args, cwd): Promise<ExecResult> => {
		const result = await pi.exec(command, args, { cwd });
		return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	};

	async function locate(ctx: ExtensionContext): Promise<{ repoRoot: string; branch: string }> {
		const root = (await exec("git", ["rev-parse", "--show-toplevel"], ctx.cwd)).stdout.trim();
		if (!root) throw new Error("not inside a git repository");
		// symbolic-ref gives the real branch name before the first commit; rev-parse gives HEAD there.
		// Keep rev-parse as the fallback for a detached HEAD, where symbolic-ref fails.
		const symbolic = await exec("git", ["symbolic-ref", "--short", "HEAD"], root);
		const branch = symbolic.stdout.trim() || (await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], root)).stdout.trim();
		if (!branch) throw new Error("cannot read the current branch");
		return { repoRoot: root, branch };
	}

	async function readLedger(ctx: ExtensionContext): Promise<Ledger> {
		const { repoRoot, branch } = await locate(ctx);
		const path = ledgerPath(repoRoot, branch);
		const text = await readFile(path, "utf8");
		const { ledger, problems } = parseLedger(text);
		if (!ledger) throw new Error(`cannot read the ledger: ${problems.join("; ")}`);
		return ledger;
	}

	pi.registerTool({
		name: "ledger_list",
		label: "Ledger list",
		description: "Read every ledger item in file order. Returns JSON: branch, and for each item id, status, short_goal, and commits (start is null for a todo item, end is null for an in-progress item). Errors when an item has no short_goal value. Read-only.",
		parameters: EMPTY_PARAMS,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			try {
				const result = listItems(await readLedger(ctx));
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
			} catch (error) {
				return { content: [{ type: "text", text: `ledger_list: ${message(error)}` }], details: {}, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "ledger_next",
		label: "Ledger next",
		description: "Read the next item to work on: the first in-progress item, else the first todo. Returns JSON { next: { id, status, short_goal }, status } where status is the ledger state (todo when nothing is started, in-progress when at least one item is in-progress or done, done when all are done and next is null). Errors when the selected item has no short_goal value. Read-only.",
		parameters: EMPTY_PARAMS,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			try {
				const result = nextItem(await readLedger(ctx));
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
			} catch (error) {
				return { content: [{ type: "text", text: `ledger_next: ${message(error)}` }], details: {}, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "ledger_check",
		label: "Ledger check",
		description: "Validate a ledger file. Reports parse problems plus one line per duplicate id. Read-only: it never writes the ledger. Default target is plan/<branch>/ledger.yaml for the current branch; an optional path checks a draft ledger. Output is JSON { path, ok, problems }, isError when problems exist. A path that is not plan/<branch>/ledger.yaml for the current branch is reported as a problem, as is a goal that names a plan file that does not exist and a repository with tracked files under plan/.",
		parameters: CHECK_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				// git may be unavailable for a draft ledger outside a repo: check the file and skip the location line.
				let repoRoot = "";
				let branch = "";
				try {
					const located = await locate(ctx);
					repoRoot = located.repoRoot;
					branch = located.branch;
				} catch (error) {
					if (!params.path) throw error;
				}
				const path = resolveCheckTarget(ctx.cwd, params.path, branch ? ledgerPath(repoRoot, branch) : undefined);
				const parsed = parseLedger(await readFile(path, "utf8"));
				const problems = checkParsed(parsed);
				const location = locationProblem(path, repoRoot, branch);
				if (location) problems.push(location);
				// These two need the filesystem and git, so they run here and not in checkLedger.
				if (parsed.ledger && repoRoot) {
					for (const [i, item] of parsed.ledger.features.entries()) {
						const ref = planReference(item.goal);
						if (!ref) continue;
						try {
							await access(join(repoRoot, ref));
						} catch {
							problems.push(missingPlanProblem(problemTarget(parsed.indexes[i], item.id, "goal"), ref));
						}
					}
					const tracked = (await exec("git", ["ls-files", "plan/"], repoRoot)).stdout.split("\n").filter((line) => line !== "");
					if (tracked.length > 0) problems.push(trackedPlanProblem(tracked));
				}
				const result = { path, ok: problems.length === 0, problems };
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {}, isError: problems.length > 0 };
			} catch (error) {
				return { content: [{ type: "text", text: `ledger_check: ${message(error)}` }], details: {}, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "ledger_start",
		label: "Ledger start",
		description: "Read a feature ledger item and mark it in-progress. Returns the item brief: goal, acceptance criteria, constraints, files.in, tests. Refuses when the item is not todo.",
		parameters: START_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const { repoRoot, branch } = await locate(ctx);
				const { item, brief } = await startItem({ repoRoot, branch, id: params.id, exec });
				return { content: [{ type: "text", text: briefText(item, brief) }], details: {} };
			} catch (error) {
				return { content: [{ type: "text", text: `ledger_start: ${message(error)}` }], details: {}, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "ledger_submit",
		label: "Ledger submit",
		description: "Validate and commit a ledger item. Pass id first. Runs the item's validation scripts (item override, else the base list); any failure rejects the submit and writes the full output to a log file. On success: git add -A, one commit, files.out from the diff, summary and limitations recorded, item marked done.",
		parameters: SUBMIT_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const missing = missingRequired(params, SUBMIT_PARAMS.required as string[]);
				if (missing.length > 0) throw new Error(missing.map((field) => `${field}: missing`).join(", "));
				const { repoRoot, branch } = await locate(ctx);
				const result = await submitItem({
					repoRoot,
					branch,
					id: params.id,
					commitMessage: params.commit_message,
					summary: params.summary,
					limitations: params.limitations ?? [],
					exec,
					logDir: process.env.TMPDIR || "/tmp",
				});
				if (result.rejected) {
					return {
						content: [{ type: "text", text: `ledger_submit: rejected by ${result.script} (exit ${result.exit})\nFull output: ${result.logPath}\nLast output:\n${result.lastOutput}` }],
						details: {},
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: `ledger_submit: ${params.id} is done (commit ${result.commit})\nfiles.out:\n${result.filesOut.map((file) => `- ${file}`).join("\n")}` }],
					details: {},
				};
			} catch (error) {
				return { content: [{ type: "text", text: `ledger_submit: ${message(error)}` }], details: {}, isError: true };
			}
		},
	});
}
