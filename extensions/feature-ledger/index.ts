#!/usr/bin/env node
// Pi extension for the feature-ledger workflow. The workflow lives in
// skills/feature-ledger/SKILL.md; these tools cover the steps an agent cannot
// do reliably by hand: reading where a feature stands, the status transition, and
// the validation-gated commit. Read operations never write.
// Core logic is in ledger.ts so it is testable without a Pi session.

import { access, readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { normalizeJsonEncoded } from "../../lib/args.ts";
import { allowedValues, badShapeProblem, checkParsed, effectiveReviewConfig, FINDING_SEVERITIES, findItem, orchestrateList, orchestrateNext, releaseClaim, missingInputWarning, missingPlanProblem, missingWorkspaceProblem, outsideRepoProblem, parseLedger, problemTarget, planReference, resolveLedgerPath, resolveRepoRoot, resolveWorkspace, startWork, submitWork, startReview, submitReview, type Exec, type ExecResult, type ItemContext, type Ledger, type LedgerItem } from "./ledger.ts";

// The same path argument on every tool. It is never required: without it the path comes
// from the resolution order.
const PATH_DESCRIPTION = "Ledger file. Without it the path is resolved in order: PI_LEDGER_PATH, then the first line of plan/ledger.path in the session root, then plan/ledger.yaml. Any extension is accepted; a relative path resolves against the session root.";
const PATH_PROPERTY = { type: "string", description: PATH_DESCRIPTION };

// Action names belong to the tools, not to the model, so they stay here: one list per tool, read by both
// the schema and the guard at call time, so an action is named once per tool. Vocabularies the model owns,
// such as finding severity below, are referenced through the exported arrays in ledger.ts rather than copied.
const ORCHESTRATE_ACTIONS = ["list", "next", "release"] as const;
const WORK_ACTIONS = ["start", "submit"] as const;
const REVIEW_ACTIONS = ["start", "submit"] as const;
const [ORCHESTRATE_LIST, ORCHESTRATE_NEXT, ORCHESTRATE_RELEASE] = ORCHESTRATE_ACTIONS;
const [WORK_START, WORK_SUBMIT] = WORK_ACTIONS;
const [REVIEW_START, REVIEW_SUBMIT] = REVIEW_ACTIONS;

const GET_PARAMS = {
	type: "object", properties: { id: { type: "string", minLength: 1 }, path: PATH_PROPERTY },
	required: ["id"], additionalProperties: false,
} as unknown as TSchema;

const ORCHESTRATE_PARAMS = {
	anyOf: [
		...[ORCHESTRATE_LIST, ORCHESTRATE_NEXT].map((action) => ({ type: "object", properties: { action: { const: action }, path: PATH_PROPERTY }, required: ["action"], additionalProperties: false })),
		{ type: "object", properties: { action: { const: ORCHESTRATE_RELEASE }, id: { type: "string", minLength: 1 }, agent_id: { type: "string", minLength: 1 }, claim_token: { type: "string", minLength: 1 }, path: PATH_PROPERTY }, required: ["action", "id", "agent_id", "claim_token"], additionalProperties: false },
	],
} as unknown as TSchema;

const CHECK_PARAMS = {
	type: "object",
	properties: { path: PATH_PROPERTY },
	required: [],
	additionalProperties: false,
} as unknown as TSchema;

const WORK_PARAMS = {
	anyOf: [
		{
			type: "object",
			properties: { action: { const: WORK_START }, id: { type: "string", minLength: 1 }, agent_id: { type: "string", minLength: 1 }, path: PATH_PROPERTY },
			required: ["action", "id", "agent_id"], additionalProperties: false,
		},
		{
			type: "object",
			properties: { action: { const: WORK_SUBMIT }, id: { type: "string", minLength: 1 }, agent_id: { type: "string", minLength: 1 }, claim_token: { type: "string", minLength: 1 }, commit_message: { type: "string", minLength: 1 }, summary: { type: "string", minLength: 1 }, limitations: { type: "array", items: { type: "string" } }, empty_commit: { type: "boolean" }, path: PATH_PROPERTY },
			required: ["action", "id", "agent_id", "claim_token", "commit_message", "summary"], additionalProperties: false,
		},
	],
} as unknown as TSchema;

const REVIEW_PARAMS = {
	anyOf: [
		{
			type: "object",
			properties: { action: { const: REVIEW_START }, id: { type: "string", minLength: 1 }, agent_id: { type: "string", minLength: 1 }, path: PATH_PROPERTY },
			required: ["action", "id", "agent_id"], additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				action: { const: REVIEW_SUBMIT }, id: { type: "string", minLength: 1 }, agent_id: { type: "string", minLength: 1 }, claim_token: { type: "string", minLength: 1 }, commit_message: { type: "string", minLength: 1 }, path: PATH_PROPERTY,
				close_findings: { type: "array", items: { type: "string", minLength: 1 } },
				// The allowed severities are the model's list, so a schema cannot accept a value the shared gate
				// would reject, and the two lists cannot drift apart.
				new_findings: { type: "array", items: { type: "object", properties: { details: { type: "string", minLength: 1 }, rationale: { type: "string", minLength: 1 }, severity: { enum: [...FINDING_SEVERITIES] }, required_checks: { type: "array", items: { type: "string", minLength: 1 } } }, required: ["details", "rationale", "severity", "required_checks"], additionalProperties: false } },
			},
			required: ["action", "id", "agent_id", "claim_token", "commit_message"], additionalProperties: false,
		},
	],
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

type GateResult = { path: string; parsed: ParsedLedger; problems: string[] };

// One validation entry point for every action, reads included. Every tool resolves the path, reads
// once and runs the model check here before doing any work, so no tool accepts a file another would
// reject. A tool that acts on an item reports the gate as an error; only ledger_check reports it as
// data. Both use these lines unchanged, so the wording matches for the same file. Filesystem and git
// checks stay in ledger_check because they need the filesystem, and a read path never writes.
async function validateLedger(ctx: ExtensionContext, explicit?: string): Promise<GateResult> {
	const path = await resolvePath(ctx, explicit);
	const parsed = parseLedger(await readFile(path, "utf8"));
	return { path, parsed, problems: checkParsed(parsed) };
}

// A file with no model always contributes at least the "no ledger block" line, so this never hands
// back an absent model.
function requireValid(gate: GateResult): Ledger {
	if (gate.problems.length) throw new Error(`invalid ledger: ${gate.problems.join("; ")}`);
	return gate.parsed.ledger!;
}

// Names each required field that is missing, in the order of the required list.
// The tool wrapper reports it as "id: missing" rather than only the arguments received.
function missingRequired(params: Record<string, unknown>, required: string[]): string[] {
	return required.filter((field) => params[field] === undefined || params[field] === "");
}

function requireArguments(params: Record<string, unknown>, required: string[], allowed: string[]): void {
	const missing = missingRequired(params, required);
	if (missing.length) throw new Error(missing.map((field) => `${field}: missing`).join(", "));
	for (const key of Object.keys(params)) if (!allowed.includes(key)) throw new Error(`${key}: not allowed for this action`);
	for (const key of [...required, "path"]) {
		if (params[key] !== undefined && (typeof params[key] !== "string" || (key !== "path" && !(params[key] as string).trim()))) throw new Error(`${key}: must be a non-empty string`);
	}
	if (params.empty_commit !== undefined && typeof params.empty_commit !== "boolean") throw new Error("empty_commit: must be a boolean");
	if (params.limitations !== undefined && (!Array.isArray(params.limitations) || params.limitations.some((value) => typeof value !== "string"))) throw new Error(badShapeProblem("limitations", "a list of strings", params.limitations));
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

	// prepareArguments is typed (args: unknown) => Static<TParams>; normalizeJsonEncoded returns unknown, so each hook uses an
	// explicit `as never` cast (not a generic). Pi still validates the result against the unchanged strict schema.
	pi.registerTool({
		name: "ledger_get_feature",
		label: "Ledger feature",
		description: `Read the full feature, assignment, findings, commits and effective review configuration. ${PATH_DESCRIPTION}`,
		parameters: GET_PARAMS,
		prepareArguments: (args) => normalizeJsonEncoded(GET_PARAMS, args) as never,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				requireArguments(params, ["id"], ["id", "path"]);
				const gate = await validateLedger(ctx, params.path);
				const ledger = requireValid(gate);
				const item = findItem(ledger, params.id, gate.path);
				const result = { item, config: { ...effectiveReviewConfig(ledger, item), validation_scripts: item.validation_scripts ?? ledger.validation_scripts }, workspace: resolveWorkspace(ctx.cwd, item, ledger.workspace) };
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
			} catch (error) {
				return { content: [{ type: "text", text: `ledger_get_feature: ${message(error)}` }], details: {}, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "ledger_orchestrate",
		label: "Ledger orchestration",
		description: `List in file order, select the next eligible item, or release a stopped run's matching identity and token. Release does not change status. Claims do not protect against concurrent writers. ${PATH_DESCRIPTION}`,
		parameters: ORCHESTRATE_PARAMS,
		prepareArguments: (args) => normalizeJsonEncoded(ORCHESTRATE_PARAMS, args) as never,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				if (!ORCHESTRATE_ACTIONS.includes(params.action)) throw new Error(`action must be ${allowedValues(ORCHESTRATE_ACTIONS)}`);
				const release = params.action === ORCHESTRATE_RELEASE;
				requireArguments(params, release ? ["id", "agent_id", "claim_token"] : [], release ? ["action", "id", "agent_id", "claim_token", "path"] : ["action", "path"]);
				const gate = await validateLedger(ctx, params.path);
				const ledger = requireValid(gate);
				const result = release ? { item: await releaseClaim(ledger, gate.path, params.id, params.agent_id, params.claim_token) }
					: params.action === ORCHESTRATE_LIST ? orchestrateList(ledger) : orchestrateNext(ledger);
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
			} catch (error) {
				return { content: [{ type: "text", text: `ledger_orchestrate: ${message(error)}` }], details: {}, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "ledger_check",
		label: "Ledger check",
		description: "Validate a ledger file. Reports parse problems plus one line per duplicate id. Read-only: it never writes the ledger. Output is JSON { path, ok, problems, warnings }; ok is true when there are no problems, and isError is set only when problems exist. A warning does not make the check fail. The ledger path is resolved in order: an optional path argument, then PI_LEDGER_PATH, then plan/ledger.path in the session root, then plan/ledger.yaml. Any extension is accepted. It reports a workspace that does not exist or is not inside a git repository, and a goal that names a plan file that does not exist, as problems. A files.in entry that does not exist yet is a warning, not a problem: an author may name a file an earlier step will create. Plan references resolve against the session root.",
		parameters: CHECK_PARAMS,
		prepareArguments: (args) => normalizeJsonEncoded(CHECK_PARAMS, args) as never,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const gate = await validateLedger(ctx, params.path);
				// The same core every other tool runs. Here its lines are reported as data, not thrown.
				const problems = [...gate.problems];
				// A warning is reported and does not fail the check. Only problems set ok and isError.
				const warnings: string[] = [];
				// These need the filesystem and git, so they run here and not in checkLedger. Plan
				// references resolve against the session root, not the repository.
				if (gate.parsed.ledger) {
					for (const [i, item] of gate.parsed.ledger.features.entries()) {
						const at = problemTarget(gate.parsed.indexes[i], item.id, "workspace");
						const workspace = resolveWorkspace(ctx.cwd, item, gate.parsed.ledger.workspace);
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
								warnings.push(missingInputWarning(problemTarget(gate.parsed.indexes[i], item.id, "files.in"), target));
							}
						}
						const ref = planReference(item.goal);
						if (ref) {
							try {
								await access(join(ctx.cwd, ref));
							} catch {
								problems.push(missingPlanProblem(problemTarget(gate.parsed.indexes[i], item.id, "goal"), ref));
							}
						}
					}
				}
				const result = { path: gate.path, ok: problems.length === 0, problems, warnings };
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {}, isError: problems.length > 0 };
			} catch (error) {
				return { content: [{ type: "text", text: `ledger_check: ${message(error)}` }], details: {}, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "ledger_work",
		label: "Ledger work",
		description: `Start or submit worker work. Start claims a todo or eligible in-progress item for agent_id and returns a fresh claim token, full item, effective config, pending findings and implementation/ledger diff views; the failed-review limit blocks start only. Submit requires the same agent_id and claim_token, runs validations and commits work, so a held claim still completes at the cap. empty_commit is only for an explained review fix. Claims fence stale sequential runs, not concurrent writers. The four patch previews share one 4 KiB budget per response; each oversized view writes its full patch to an artifact, and once the allowance is used up the result gives files and stat with a note pointing at the artifacts. ${PATH_DESCRIPTION}`,
		parameters: WORK_PARAMS,
		prepareArguments: (args) => normalizeJsonEncoded(WORK_PARAMS, args) as never,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				if (!WORK_ACTIONS.includes(params.action)) throw new Error(`action must be ${allowedValues(WORK_ACTIONS)}`);
				const required = params.action === WORK_START ? ["id", "agent_id"] : ["id", "agent_id", "claim_token", "commit_message", "summary"];
				requireArguments(params, required, params.action === WORK_START ? ["action", "id", "agent_id", "path"] : ["action", "id", "agent_id", "claim_token", "commit_message", "summary", "limitations", "empty_commit", "path"]);
				const gate = await validateLedger(ctx, params.path);
				const ledger = requireValid(gate);
				const item = findItem(ledger, params.id, gate.path);
				const opts = await itemContext(ctx, gate.path, ledger, item);
				if (params.action === WORK_START) {
					const result = await startWork({ ...opts, agentId: params.agent_id, artifactDir: process.env.TMPDIR || undefined });
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
				}
				const result = await submitWork({ ...opts, agentId: params.agent_id, claimToken: params.claim_token, commitMessage: params.commit_message, summary: params.summary, limitations: params.limitations ?? [], emptyCommit: params.empty_commit, logDir: process.env.TMPDIR || undefined });
				if (result.rejected) return { content: [{ type: "text", text: `ledger_work: rejected by ${result.script} (exit ${result.exit}); claim retained\nFull output: ${result.logPath}\nLast output:\n${result.lastOutput}` }], details: {}, isError: true };
				const warning = result.outOfRepo.length ? `\nwarning: changes outside ${opts.workspace} are not committed:\n${result.outOfRepo.map((file) => `- ${file}`).join("\n")}` : "";
				return { content: [{ type: "text", text: `ledger_work: ${params.id} is ${item.status} (commit ${result.commit})\nfiles.out:\n${result.filesOut.map((file) => `- ${file}`).join("\n")}${warning}` }], details: {} };
			} catch (error) {
				return { content: [{ type: "text", text: `ledger_work: ${message(error)}` }], details: {}, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "ledger_review",
		label: "Ledger review",
		description: `Start or submit a reviewer claim. Submit requires the same ID, path, agent ID and token plus a non-empty commit_message, which is used verbatim for the ledger commit. Submit closes finding IDs and adds findings; any open finding fails review. A tracked ledger is committed in its own repository in full, including pre-existing ledger edits, without other staged files. Untracked, ignored, or outside-repository ledgers are written without a commit. Claims fence stale sequential runs, not concurrent writers. ${PATH_DESCRIPTION}`,
		parameters: REVIEW_PARAMS,
		prepareArguments: (args) => normalizeJsonEncoded(REVIEW_PARAMS, args) as never,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				if (!REVIEW_ACTIONS.includes(params.action)) throw new Error(`action must be ${allowedValues(REVIEW_ACTIONS)}`);
				const required = params.action === REVIEW_START ? ["id", "agent_id"] : ["id", "agent_id", "claim_token", "commit_message"];
				requireArguments(params, required, params.action === REVIEW_START ? ["action", "id", "agent_id", "path"] : ["action", "id", "agent_id", "claim_token", "commit_message", "close_findings", "new_findings", "path"]);
				const gate = await validateLedger(ctx, params.path);
				const ledger = requireValid(gate);
				const item = findItem(ledger, params.id, gate.path);
				const opts = await itemContext(ctx, gate.path, ledger, item);
				const result = params.action === REVIEW_START
					? await startReview({ ...opts, agentId: params.agent_id, artifactDir: process.env.TMPDIR || undefined })
					: await submitReview({ ...opts, agentId: params.agent_id, claimToken: params.claim_token, commitMessage: params.commit_message, closeFindings: params.close_findings === undefined ? [] : params.close_findings, newFindings: params.new_findings === undefined ? [] : params.new_findings });
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
			} catch (error) {
				return { content: [{ type: "text", text: `ledger_review: ${message(error)}` }], details: {}, isError: true };
			}
		},
	});

}
