import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@earendil-works/pi-schema";
import { FINDING_SEVERITIES, parseLedger, PATCH_BUDGET_BYTES, serializeLedger, submitReview, type LedgerItem } from "./ledger.ts";
import featureLedger from "./index.ts";
import { createFakeApi, createFakeContext, invoke, exec, setupRepo } from "./test-harness.ts";

const fixture = `ledger:
  branch: {BRANCH}
  validation_scripts: []
  features:
    - id: alpha
      status: todo
      review: true
      short_goal: Review feature.
      goal: Implement feature.
      files:
        in: []
        out: []
      commits: {}
`;
// Skips Pi's argument validation, to prove the tool refuses an argument its own schema also rejects.
const callUnvalidated = (api: ReturnType<typeof createFakeApi>, tool: string, dir: string, params: Record<string, unknown>) => api.tools[tool].execute(null, params, null, null, createFakeContext(dir));
const call = (api: ReturnType<typeof createFakeApi>, tool: string, dir: string, params: Record<string, unknown>) => invoke(api.tools[tool], params, createFakeContext(dir));
const itemAt = async (path: string) => parseLedger(await readFile(path, "utf8")).ledger!.features[0];
async function change(path: string, update: (item: LedgerItem) => void) {
	const ledger = parseLedger(await readFile(path, "utf8")).ledger!;
	update(ledger.features[0]);
	await writeFile(path, serializeLedger(ledger));
}
async function initialWork(api: ReturnType<typeof createFakeApi>, dir: string, path: string) {
	const start = await call(api, "ledger_work", dir, { action: "start", id: "alpha", agent_id: "worker", path });
	assert.ok(!start.isError, start.content[0].text);
	await writeFile(join(dir, "code.txt"), "implementation\n");
	const result = await call(api, "ledger_work", dir, { action: "submit", id: "alpha", agent_id: "worker", claim_token: JSON.parse(start.content[0].text).item.assignment.claim_token, commit_message: "Work", summary: "Worked", path });
	assert.ok(!result.isError, result.content[0].text);
}
async function reviewStart(api: ReturnType<typeof createFakeApi>, dir: string, path: string, agent_id = "reviewer") {
	const result = await call(api, "ledger_review", dir, { action: "start", id: "alpha", agent_id, path });
	assert.ok(!result.isError, result.content[0].text);
	return JSON.parse(result.content[0].text);
}
// A reviewer supplies the commit message and the tool uses it unchanged.
const reviewArgs = (path: string, token: string, agent_id = "reviewer", commit_message = "Review alpha round 0") => ({ action: "submit", id: "alpha", agent_id, claim_token: token, commit_message, path });
const finding = (severity: string) => ({ details: `Issue ${severity}`, rationale: "Why", severity, required_checks: ["manual check: do not run"] });
async function fix(api: ReturnType<typeof createFakeApi>, dir: string, path: string) {
	const start = await call(api, "ledger_work", dir, { action: "start", id: "alpha", agent_id: "fixer", path });
	assert.ok(!start.isError, start.content[0].text);
	const result = await call(api, "ledger_work", dir, { action: "submit", id: "alpha", agent_id: "fixer", claim_token: JSON.parse(start.content[0].text).item.assignment.claim_token, commit_message: "Fix", summary: "Verified existing work", empty_commit: true, path });
	assert.ok(!result.isError, result.content[0].text);
}

test("ledger_review schema, claims, validation and finding history through retries and cap", async () => {
	const { dir, path, cleanup } = await setupRepo(fixture);
	try {
		const api = createFakeApi(); featureLedger(api);
		const schema = compile(api.tools.ledger_review.parameters);
		assert.ok(schema.check({ action: "submit", id: "alpha", agent_id: "x", claim_token: "t", commit_message: "Review alpha round 0" }));
		assert.ok(!schema.check({ action: "submit", id: "alpha", agent_id: "x" }));
		// commit_message is required for submit, so a call without it or with an empty one does not validate.
		assert.ok(!schema.check({ action: "submit", id: "alpha", agent_id: "x", claim_token: "t" }));
		assert.ok(!schema.check({ action: "submit", id: "alpha", agent_id: "x", claim_token: "t", commit_message: "" }));
		assert.ok(!schema.check({ action: "start", id: "alpha", agent_id: "x", claim_token: "t" }));
		assert.ok(!schema.check({ action: "submit", id: "alpha", agent_id: "x", claim_token: "t", new_findings: [finding("critical")] }));
		assert.match((await call(api, "ledger_review", dir, { action: "start", id: "alpha", agent_id: "r", path })).content[0].text, /requires review/);
		await initialWork(api, dir, path);
		await change(path, item => { item.max_failed_reviews = 2; });
		const brief = await reviewStart(api, dir, path, "alpha-0-reviewer");
		assert.equal(brief.item.assignment.id, "alpha-0-reviewer");
		assert.deepEqual(brief.cumulative_diff.implementation.files, ["code.txt"]);
		assert.deepEqual(brief.latest_diff.implementation.files, ["code.txt"]);
		assert.equal(brief.config.max_failed_reviews, 2);
		const args = reviewArgs(path, brief.item.assignment.claim_token, "alpha-0-reviewer");
		assert.match((await call(api, "ledger_review", dir, { action: "start", id: "alpha", agent_id: "r", path })).content[0].text, /already assigned/);
		for (const invalid of [{ ...args, agent_id: "wrong" }, { ...args, claim_token: "stale" }, { ...args, commit_message: "   " }, { ...args, close_findings: ["unknown"] }, { ...args, close_findings: ["same", "same"] }, { ...args, new_findings: [finding("critical")] }, { ...args, new_findings: [{ ...finding("nit"), required_checks: [""] }] }]) {
			const before = await readFile(path, "utf8");
			assert.ok((await callUnvalidated(api, "ledger_review", dir, invalid)).isError);
			assert.equal(await readFile(path, "utf8"), before);
			// The file is unchanged because the claim itself survived the refusal.
			const kept = await itemAt(path);
			assert.equal(kept.assignment?.agent_id, "alpha-0-reviewer");
			assert.equal(kept.assignment?.claim_token, brief.item.assignment.claim_token);
		}
		const first = await call(api, "ledger_review", dir, { ...args, new_findings: FINDING_SEVERITIES.map(finding) });
		assert.ok(!first.isError, first.content[0].text);
		const failed = JSON.parse(first.content[0].text);
		assert.equal(failed.status, "in-progress"); assert.equal(failed.failed_reviews, 1);
		assert.equal(failed.ledger_commit, null);
		assert.equal(new Set(failed.open_findings.map((f: { id: string }) => f.id)).size, 4);
		assert.ok(failed.open_findings.every((f: { first_found_iteration: number }) => f.first_found_iteration === 0));
		await fix(api, dir, path);
		const second = await reviewStart(api, dir, path, "another-agent");
		assert.equal(second.item.assignment.id, "alpha-1-reviewer");
		assert.notEqual(second.item.assignment.claim_token, brief.item.assignment.claim_token);
		assert.equal(second.pending_findings.length, 4);
		assert.match((await call(api, "ledger_review", dir, reviewArgs(path, brief.item.assignment.claim_token, "another-agent"))).content[0].text, /no matching reviewer claim/);
		const ids = failed.open_findings.map((f: { id: string }) => f.id);
		const secondArgs = reviewArgs(path, second.item.assignment.claim_token, "another-agent");
		const failedAgain = await call(api, "ledger_review", dir, { ...secondArgs, close_findings: ids.slice(0, 3) });
		assert.ok(!failedAgain.isError, failedAgain.content[0].text);
		assert.equal(JSON.parse(failedAgain.content[0].text).failed_reviews, 2);
		const cappedFixerStart = (await call(api, "ledger_work", dir, { action: "start", id: "alpha", agent_id: "fixer", path })).content[0].text;
		assert.match(cappedFixerStart, /failed-review limit 2/);
		// The cap governs starting another attempt only, so the error names it as a start refusal.
		assert.match(cappedFixerStart, /before starting another attempt/);
		await change(path, item => { item.max_failed_reviews = 3; });
		await fix(api, dir, path);
		const third = await reviewStart(api, dir, path);
		assert.deepEqual(third.pending_findings.map((f: { id: string }) => f.id), [ids[3]]);
		const thirdResult = await call(api, "ledger_review", dir, { ...reviewArgs(path, third.item.assignment.claim_token), close_findings: [ids[3]] });
		assert.ok(!thirdResult.isError, thirdResult.content[0].text);
		const done = await itemAt(path);
		assert.equal(done.status, "done"); assert.equal(done.failed_reviews, 2);
		assert.deepEqual(done.findings!.map(f => f.id), ids);
		assert.ok(done.findings!.every(f => f.status === "closed"));
		assert.equal(done.assignment, undefined);
		assert.equal(done.commits.submissions!.length, 3);
	} finally { await cleanup(); }
});

test("ledger_review empty pass and each severity independently fail", async () => {
	for (const severity of [null, ...FINDING_SEVERITIES]) {
		const { dir, path, cleanup } = await setupRepo(fixture);
		try {
			const api = createFakeApi(); featureLedger(api); await initialWork(api, dir, path);
			const brief = await reviewStart(api, dir, path);
			const result = await call(api, "ledger_review", dir, { ...reviewArgs(path, brief.item.assignment.claim_token), ...(severity ? { new_findings: [finding(severity)] } : {}) });
			assert.ok(!result.isError, result.content[0].text);
			assert.equal(JSON.parse(result.content[0].text).status, severity ? "in-progress" : "done", String(severity));
		} finally { await cleanup(); }
	}
});

test("tracked ledger commit contains all ledger edits but preserves unrelated staged and unstaged files in same and different repositories", async () => {
	for (const separate of [false, true]) {
		const workspace = await setupRepo(fixture);
		const ledgerRepo = separate ? await setupRepo(fixture) : workspace;
		const path = ledgerRepo.path;
		try {
			assert.equal((await exec("git", ["add", "-f", "plan/ledger.yaml"], ledgerRepo.dir)).code, 0);
			assert.equal((await exec("git", ["commit", "-m", "Track ledger"], ledgerRepo.dir)).code, 0);
			const api = createFakeApi(); featureLedger(api); await initialWork(api, workspace.dir, path);
			await change(path, item => { item.goal = "Pre-existing ledger edit"; });
			const brief = await reviewStart(api, workspace.dir, path);
			await writeFile(join(ledgerRepo.dir, "README.md"), "staged unrelated\n");
			assert.equal((await exec("git", ["add", "README.md"], ledgerRepo.dir)).code, 0);
			await writeFile(join(ledgerRepo.dir, "README.md"), "unstaged unrelated\n");
			// The project's own commit convention is what the supplied message says, not a generated one.
			const message = "fix(feature-ledger): review alpha round 0";
			const result = await call(api, "ledger_review", workspace.dir, { ...reviewArgs(path, brief.item.assignment.claim_token), commit_message: message });
			assert.ok(!result.isError, result.content[0].text);
			const output = JSON.parse(result.content[0].text);
			assert.match(output.ledger_commit, /^[a-f0-9]{40}$/);
			assert.equal((await exec("git", ["log", "-1", "--format=%s"], ledgerRepo.dir)).stdout.trim(), message);
			assert.match(output.ledger_commit_note, /including pre-existing edits/);
			assert.equal((await exec("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], ledgerRepo.dir)).stdout.trim(), "plan/ledger.yaml");
			assert.match((await exec("git", ["show", "HEAD:plan/ledger.yaml"], ledgerRepo.dir)).stdout, /Pre-existing ledger edit/);
			assert.equal((await exec("git", ["show", ":README.md"], ledgerRepo.dir)).stdout, "staged unrelated\n");
			assert.equal(await readFile(join(ledgerRepo.dir, "README.md"), "utf8"), "unstaged unrelated\n");
		} finally { if (separate) await ledgerRepo.cleanup(); await workspace.cleanup(); }
	}
});

// A rejected message stops before any Git work, so the claim and repository are untouched.
// A supplied message is what the recorded commit carries, unchanged.
test("review submit requires a non-empty commit message and records it verbatim", async () => {
	const repo = await setupRepo(fixture);
	try {
		assert.equal((await exec("git", ["add", "-f", "plan/ledger.yaml"], repo.dir)).code, 0);
		assert.equal((await exec("git", ["commit", "-m", "Track"], repo.dir)).code, 0);
		const api = createFakeApi(); featureLedger(api); await initialWork(api, repo.dir, repo.path);
		const brief = await reviewStart(api, repo.dir, repo.path);
		let gitCalls = 0;
		api.exec = async (command, args, cwd) => { if (command === "git") gitCalls++; return exec(command, args, cwd); };
		for (const [value, expected] of [[undefined, /commit_message: missing/], ["", /commit_message: missing/], ["   ", /commit_message: must be a non-empty string/]] as const) {
			gitCalls = 0;
			const params = value === undefined ? { ...reviewArgs(repo.path, brief.item.assignment.claim_token), commit_message: undefined } : { ...reviewArgs(repo.path, brief.item.assignment.claim_token), commit_message: value };
			const result = await callUnvalidated(api, "ledger_review", repo.dir, params);
			assert.ok(result.isError, String(value));
			assert.match(result.content[0].text, expected);
			assert.equal(gitCalls, 0, `a rejected submission ran ${gitCalls} git commands for ${String(value)}`);
			assert.equal((await itemAt(repo.path)).status, "review");
		}
		const message = "Review alpha round 0: left one finding open";
		const result = await call(api, "ledger_review", repo.dir, { ...reviewArgs(repo.path, brief.item.assignment.claim_token), commit_message: message, new_findings: [finding("nit")] });
		assert.ok(!result.isError, result.content[0].text);
		assert.match(JSON.parse(result.content[0].text).ledger_commit, /^[a-f0-9]{40}$/);
		assert.equal((await exec("git", ["log", "-1", "--format=%s"], repo.dir)).stdout.trim(), message);
	} finally { await repo.cleanup(); }
});

test("untracked, ignored and outside-repository ledgers are written without a commit", async () => {
	for (const kind of ["untracked", "ignored", "outside"]) {
		const repo = await setupRepo(fixture);
		const outside = kind === "outside" ? await mkdtemp(join(tmpdir(), "ledger-outside-")) : "";
		const path = kind === "outside" ? join(outside, "ledger.yaml") : kind === "untracked" ? join(repo.dir, "ledger.yaml") : repo.path;
		try {
			if (path !== repo.path) await writeFile(path, await readFile(repo.path, "utf8"));
			const api = createFakeApi(); featureLedger(api); await initialWork(api, repo.dir, path);
			const brief = await reviewStart(api, repo.dir, path);
			const before = (await exec("git", ["rev-parse", "HEAD"], repo.dir)).stdout;
			const result = await call(api, "ledger_review", repo.dir, reviewArgs(path, brief.item.assignment.claim_token));
			assert.ok(!result.isError, result.content[0].text);
			assert.equal(JSON.parse(result.content[0].text).ledger_commit, null, kind);
			assert.equal((await exec("git", ["rev-parse", "HEAD"], repo.dir)).stdout, before);
			assert.equal((await itemAt(path)).status, "done");
		} finally { if (outside) await rm(outside, { recursive: true }); await repo.cleanup(); }
	}
});

test("review partial failures report written ledger and uncertain or known commit state", async () => {
	for (const stage of ["commit", "post-commit-head"]) {
		const repo = await setupRepo(fixture);
		try {
			assert.equal((await exec("git", ["add", "-f", "plan/ledger.yaml"], repo.dir)).code, 0);
			assert.equal((await exec("git", ["commit", "-m", "Track"], repo.dir)).code, 0);
			const api = createFakeApi(); let injecting = false; let committed = false;
			api.exec = async (command, args, cwd) => {
				if (injecting && command === "git" && args[0] === "commit") {
					if (stage === "commit") return { code: 1, stdout: "", stderr: "injected commit failure" };
					const result = await exec(command, args, cwd); committed = true; return result;
				}
				if (injecting && committed && command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return { code: 1, stdout: "", stderr: "injected HEAD failure" };
				return exec(command, args, cwd);
			};
			featureLedger(api); await initialWork(api, repo.dir, repo.path);
			const brief = await reviewStart(api, repo.dir, repo.path);
			const before = (await exec("git", ["rev-parse", "HEAD"], repo.dir)).stdout.trim();
			injecting = true;
			const result = await call(api, "ledger_review", repo.dir, reviewArgs(repo.path, brief.item.assignment.claim_token));
			assert.ok(result.isError);
			assert.match(result.content[0].text, /review ledger was written/);
			assert.match(result.content[0].text, /a commit may have been created/);
			assert.match(result.content[0].text, /Do not retry blindly/);
			assert.match(result.content[0].text, stage === "commit" ? /injected commit failure/ : /injected HEAD failure/);
			assert.equal((await itemAt(repo.path)).status, "done");
			const after = (await exec("git", ["rev-parse", "HEAD"], repo.dir)).stdout.trim();
			assert.equal(before === after, stage === "commit");
		} finally { await repo.cleanup(); }
	}
});

test("review failed write does not attempt commit and reports possible partial write", async () => {
	const repo = await setupRepo(fixture);
	try {
		assert.equal((await exec("git", ["add", "-f", "plan/ledger.yaml"], repo.dir)).code, 0);
		assert.equal((await exec("git", ["commit", "-m", "Track"], repo.dir)).code, 0);
		const api = createFakeApi(); featureLedger(api); await initialWork(api, repo.dir, repo.path);
		const brief = await reviewStart(api, repo.dir, repo.path);
		const ledger = parseLedger(await readFile(repo.path, "utf8")).ledger!;
		let commits = 0;
		const faultExec = async (command: string, args: string[], cwd: string) => {
			const result = await exec(command, args, cwd);
			if (command === "git" && args[0] === "rev-parse" && args.includes("HEAD") && cwd === repo.dir) {
				await rm(repo.path); await mkdir(repo.path);
			}
			if (command === "git" && args[0] === "commit") commits++;
			return result;
		};
		await assert.rejects(submitReview({ cwd: repo.dir, ledgerPath: repo.path, ledger, workspace: repo.dir, repoRoot: repo.dir, branch: repo.branch, id: "alpha", exec: faultExec, agentId: "reviewer", claimToken: brief.item.assignment.claim_token, commitMessage: "Review alpha round 0", closeFindings: [], newFindings: [] }), /may be partially written, no commit attempted/);
		assert.equal(commits, 0);
	} finally { await repo.cleanup(); }
});

test("empty updates do not pass an open finding, and reviewer claim contains oversized diff artifacts", async () => {
	const repo = await setupRepo(fixture);
	try {
		const api = createFakeApi(); featureLedger(api);
		const start = await call(api, "ledger_work", repo.dir, { action: "start", id: "alpha", agent_id: "worker", path: repo.path });
		const token = JSON.parse(start.content[0].text).item.assignment.claim_token;
		await writeFile(join(repo.dir, "code.txt"), "x".repeat(50000));
		const work = await call(api, "ledger_work", repo.dir, { action: "submit", id: "alpha", agent_id: "worker", claim_token: token, commit_message: "Work", summary: "Worked", path: repo.path });
		assert.ok(!work.isError, work.content[0].text);
		await change(repo.path, item => { item.findings = [{ id: "earlier", status: "open", details: "Still open", rationale: "Must fix", severity: "nit", first_found_iteration: 0, required_checks: [] }]; });
		const brief = await reviewStart(api, repo.dir, repo.path);
		assert.equal(brief.cumulative_diff.implementation.truncated, true);
		assert.equal((await readFile(brief.cumulative_diff.implementation.full_patch_path, "utf8")).includes("x".repeat(50000)), true);
		const result = await call(api, "ledger_review", repo.dir, reviewArgs(repo.path, brief.item.assignment.claim_token));
		assert.ok(!result.isError, result.content[0].text);
		assert.equal(JSON.parse(result.content[0].text).status, "in-progress");
		assert.equal((await itemAt(repo.path)).findings![0].id, "earlier");
	} finally { await repo.cleanup(); }
});

// A truncated view returns the bytes it was allowed plus the truncation notice naming its artifact.
function splitPreview(patch: string): { preview: string; artifact: string } | null {
	const match = /^([\s\S]*?)\n\[Patch truncated; full patch: ([^\]]+)\]$/.exec(patch);
	return match ? { preview: match[1], artifact: match[2] } : null;
}

test("reviewer start applies one shared patch budget across its four views", async () => {
	const repo = await setupRepo(fixture);
	try {
		assert.equal((await exec("git", ["add", "-f", "plan/ledger.yaml"], repo.dir)).code, 0);
		assert.equal((await exec("git", ["commit", "-m", "Track"], repo.dir)).code, 0);
		const api = createFakeApi(); featureLedger(api);
		// The implementation patch is smaller than the allowance, so it uses part of it.
		const workStart = await call(api, "ledger_work", repo.dir, { action: "start", id: "alpha", agent_id: "worker", path: repo.path });
		assert.ok(!workStart.isError, workStart.content[0].text);
		await writeFile(join(repo.dir, "code.txt"), "x".repeat(3000));
		const work = await call(api, "ledger_work", repo.dir, { action: "submit", id: "alpha", agent_id: "worker", claim_token: JSON.parse(workStart.content[0].text).item.assignment.claim_token, commit_message: "Work", summary: "Worked", path: repo.path });
		assert.ok(!work.isError, work.content[0].text);
		// A worker submission commits implementation only, so the oversized ledger change needs its own commit.
		await change(repo.path, item => { item.limitations.push("y".repeat(6000)); });
		assert.equal((await exec("git", ["add", "-f", "plan/ledger.yaml"], repo.dir)).code, 0);
		assert.equal((await exec("git", ["commit", "-m", "Review metadata"], repo.dir)).code, 0);
		const brief = await reviewStart(api, repo.dir, repo.path);
		// Views are cumulative implementation, cumulative ledger metadata, latest implementation, latest ledger metadata.
		const views = [brief.cumulative_diff.implementation, brief.cumulative_diff.ledger_metadata, brief.latest_diff.implementation, brief.latest_diff.ledger_metadata];
		// The first view fits inside the allowance, so it is returned complete and the next oversized view gets only what is left.
		assert.ok(!views[0].truncated && views[0].patch.includes("x".repeat(3000)));
		const second = splitPreview(views[1].patch)!;
		assert.ok(second, "the oversized view must report truncation with an artifact path");
		assert.equal(views[1].truncated, true);
		assert.ok(second.preview.length > 0 && second.preview.length < PATCH_BUDGET_BYTES);
		assert.equal(second.preview.length, PATCH_BUDGET_BYTES - views[0].patch.length);
		assert.equal(second.artifact, views[1].full_patch_path);
		assert.match(await readFile(second.artifact, "utf8"), /y{6000}/);
		// The allowance is spent, so a later view with changes returns files and stat plus the note pointing at its artifact.
		const third = splitPreview(views[2].patch)!;
		assert.ok(third, "a view past the allowance must still report truncation with an artifact path");
		assert.equal(views[2].truncated, true);
		assert.equal(third.preview, "");
		assert.equal(third.artifact, views[2].full_patch_path);
		assert.match(views[2].stat, /code\.txt/);
		assert.match(await readFile(third.artifact, "utf8"), /x{3000}/);
		// The last view covers no change in that path, so there is nothing to truncate.
		assert.deepEqual(views[3], { files: [], stat: "", patch: "", truncated: false });
		let returnedBytes = 0;
		for (const view of views) returnedBytes += view.truncated ? splitPreview(view.patch)!.preview.length : view.patch.length;
		assert.ok(returnedBytes <= PATCH_BUDGET_BYTES, `response returned ${returnedBytes} bytes over the shared budget`);
		assert.deepEqual(views.map((view) => view.files), [["code.txt"], ["plan/ledger.yaml"], ["code.txt"], []]);
	} finally { await repo.cleanup(); }
});

test("a tracked ledger staged for deletion is still committed with its restored contents", async () => {
	const repo = await setupRepo(fixture);
	try {
		assert.equal((await exec("git", ["add", "-f", "plan/ledger.yaml"], repo.dir)).code, 0);
		assert.equal((await exec("git", ["commit", "-m", "Track"], repo.dir)).code, 0);
		const api = createFakeApi(); featureLedger(api); await initialWork(api, repo.dir, repo.path);
		const brief = await reviewStart(api, repo.dir, repo.path);
		assert.equal((await exec("git", ["rm", "--cached", "plan/ledger.yaml"], repo.dir)).code, 0);
		const result = await call(api, "ledger_review", repo.dir, reviewArgs(repo.path, brief.item.assignment.claim_token));
		assert.ok(!result.isError, result.content[0].text);
		assert.match(JSON.parse(result.content[0].text).ledger_commit, /^[a-f0-9]{40}$/);
		assert.match((await exec("git", ["show", "HEAD:plan/ledger.yaml"], repo.dir)).stdout, /status: done/);
	} finally { await repo.cleanup(); }
});

test("tracked ledger in an unborn independent repository is committed alone", async () => {
	const workspace = await setupRepo(fixture);
	const other = await mkdtemp(join(tmpdir(), "ledger-unborn-"));
	try {
		assert.equal((await exec("git", ["init", "-q"], other)).code, 0);
		assert.equal((await exec("git", ["config", "user.name", "Ledger Test"], other)).code, 0);
		assert.equal((await exec("git", ["config", "user.email", "test@example.test"], other)).code, 0);
		const path = join(other, "ledger.yaml");
		await writeFile(path, await readFile(workspace.path, "utf8"));
		await writeFile(join(other, "unrelated"), "staged\n");
		assert.equal((await exec("git", ["add", "ledger.yaml", "unrelated"], other)).code, 0);
		const api = createFakeApi(); featureLedger(api); await initialWork(api, workspace.dir, path);
		const brief = await reviewStart(api, workspace.dir, path);
		const result = await call(api, "ledger_review", workspace.dir, reviewArgs(path, brief.item.assignment.claim_token));
		assert.ok(!result.isError, result.content[0].text);
		assert.match(JSON.parse(result.content[0].text).ledger_commit, /^[a-f0-9]{40}$/);
		assert.equal((await exec("git", ["ls-tree", "--name-only", "HEAD"], other)).stdout.trim(), "ledger.yaml");
		assert.equal((await exec("git", ["diff", "--cached", "--name-only"], other)).stdout.trim(), "unrelated");
	} finally { await rm(other, { recursive: true }); await workspace.cleanup(); }
});

test("review preflight failures leave the claim intact; post-write pre-commit failures report no commit", async () => {
	for (const stage of ["ls-files", "diff"]) {
		const repo = await setupRepo(fixture);
		try {
			assert.equal((await exec("git", ["add", "-f", "plan/ledger.yaml"], repo.dir)).code, 0);
			assert.equal((await exec("git", ["commit", "-m", "Track"], repo.dir)).code, 0);
			const api = createFakeApi(); let injecting = false;
			api.exec = async (command, args, cwd) => {
				if (injecting && command === "git" && args[0] === stage) return { code: 2, stdout: "", stderr: `injected ${stage} failure` };
				return exec(command, args, cwd);
			};
			featureLedger(api); await initialWork(api, repo.dir, repo.path);
			const brief = await reviewStart(api, repo.dir, repo.path);
			const before = await readFile(repo.path, "utf8");
			const head = (await exec("git", ["rev-parse", "HEAD"], repo.dir)).stdout;
			injecting = true;
			const result = await call(api, "ledger_review", repo.dir, reviewArgs(repo.path, brief.item.assignment.claim_token));
			assert.ok(result.isError);
			assert.match(result.content[0].text, new RegExp(`injected ${stage} failure`));
			if (stage === "ls-files") assert.equal(await readFile(repo.path, "utf8"), before);
			else {
				assert.match(result.content[0].text, /review ledger was written.*no commit was attempted/s);
				assert.equal((await itemAt(repo.path)).status, "done");
			}
			assert.equal((await exec("git", ["rev-parse", "HEAD"], repo.dir)).stdout, head);
		} finally { await repo.cleanup(); }
	}
});

test("ledger_review shape errors: hard failures show Pi's line, late failures show the shape line", async () => {
	const { dir, path, cleanup } = await setupRepo(fixture);
	try {
		const api = createFakeApi(); featureLedger(api);
		await initialWork(api, dir, path);
		const brief = await reviewStart(api, dir, path);
		const args = reviewArgs(path, brief.item.assignment.claim_token);
		const before = await readFile(path, "utf8");
		// Hard failure: unparseable text where objects belong stays with Pi's validator, which echoes the arguments.
		await assert.rejects(call(api, "ledger_review", dir, { ...args, new_findings: ["not json"] }), (error: Error) => /Validation failed for tool "ledger_review"/.test(error.message) && /new_findings\.0/.test(error.message) && /Received arguments:/.test(error.message) && error.message.includes("not json"));
		// Hard failure: Pi's validator rejects an object where IDs belong, so the ID lookup is never reached.
		await assert.rejects(call(api, "ledger_review", dir, { ...args, close_findings: { id: "not-an-id" } }), (error: Error) => /Validation failed for tool "ledger_review"/.test(error.message) && /close_findings: expected array, got object/.test(error.message) && /Received arguments:/.test(error.message) && error.message.includes("not-an-id") && !error.message.includes("unknown finding ID"));
		// Pi coerces a bare string into a one-item list, so it passes validation and reaches the ID lookup.
		const coerced = await call(api, "ledger_review", dir, { ...args, close_findings: "not json" });
		assert.ok(coerced.isError);
		assert.match(coerced.content[0].text, /unknown finding ID/);
		assert.equal(await readFile(path, "utf8"), before);
		assert.equal((await itemAt(path)).assignment?.claim_token, brief.item.assignment.claim_token);
		// Late failures: the value passes validation, then the runtime check names field, shape and preview.
		const blank = await call(api, "ledger_review", dir, { ...args, close_findings: ["  "] });
		assert.ok(blank.isError);
		assert.match(blank.content[0].text, /close_findings must be a list of non-empty IDs, got \["  "\]/);
		const long = "x".repeat(200);
		const checks = await call(api, "ledger_review", dir, { ...args, new_findings: [{ ...finding("nit"), required_checks: [long, " "] }] });
		assert.ok(checks.isError);
		assert.match(checks.content[0].text, /new_findings\[0\]\.required_checks must be a list of non-empty strings, got \["x+…/);
		assert.ok(!checks.content[0].text.includes(long));
		const notList = await callUnvalidated(api, "ledger_review", dir, { ...args, new_findings: [{ ...finding("nit"), required_checks: "check one, check two" }] });
		assert.match(notList.content[0].text, /required_checks must be a list of non-empty strings, got "check one, check two"/);
		assert.equal(await readFile(path, "utf8"), before);
		assert.equal((await itemAt(path)).assignment?.claim_token, brief.item.assignment.claim_token);
	} finally { await cleanup(); }
});

// A model may send an array argument as JSON text. prepareArguments decodes it before Pi validates it.
async function reviewedFindings(newFindings: unknown, extra: (ids: string[]) => Record<string, unknown> = () => ({})) {
	const { dir, path, cleanup } = await setupRepo(fixture);
	try {
		const api = createFakeApi(); featureLedger(api); await initialWork(api, dir, path);
		const brief = await reviewStart(api, dir, path);
		const result = await call(api, "ledger_review", dir, { ...reviewArgs(path, brief.item.assignment.claim_token), new_findings: newFindings, ...extra([]) });
		assert.ok(!result.isError, result.content[0].text);
		const item = await itemAt(path);
		return { failed: item.failed_reviews, findings: item.findings!.map(({ details, rationale, severity, required_checks, status }) => ({ details, rationale, severity, required_checks, status })) };
	} finally { await cleanup(); }
}

test("ledger_review new_findings as JSON text gives the same ledger result as the array", async () => {
	const findings = [finding("minor"), finding("major")];
	const expected = await reviewedFindings(findings);
	assert.equal(expected.findings.length, 2);
	assert.deepEqual(await reviewedFindings(JSON.stringify(findings)), expected);
});

test("ledger_review required_checks as JSON text inside a finding object is normalized", async () => {
	const result = await reviewedFindings([{ ...finding("minor"), required_checks: JSON.stringify(["check one", "check two"]) }]);
	assert.deepEqual(result.findings[0].required_checks, ["check one", "check two"]);
	// "[1]" decodes to [1], which Pi's coercion turns into ["1"].
	const numeric = await reviewedFindings([{ ...finding("minor"), required_checks: "[1]" }]);
	assert.deepEqual(numeric.findings[0].required_checks, ["1"]);
});

test("ledger_review close_findings as JSON text closes the correct IDs", async () => {
	const { dir, path, cleanup } = await setupRepo(fixture);
	try {
		const api = createFakeApi(); featureLedger(api); await initialWork(api, dir, path);
		const first = await reviewStart(api, dir, path);
		const failed = JSON.parse((await call(api, "ledger_review", dir, { ...reviewArgs(path, first.item.assignment.claim_token), new_findings: [finding("minor"), finding("major")] })).content[0].text);
		const ids = failed.open_findings.map((f: { id: string }) => f.id);
		await fix(api, dir, path);
		const second = await reviewStart(api, dir, path);
		const result = await call(api, "ledger_review", dir, { ...reviewArgs(path, second.item.assignment.claim_token), close_findings: JSON.stringify([ids[0]]) });
		assert.ok(!result.isError, result.content[0].text);
		const statuses = Object.fromEntries((await itemAt(path)).findings!.map(f => [f.id, f.status]));
		assert.deepEqual(statuses, { [ids[0]]: "closed", [ids[1]]: "open" });
	} finally { await cleanup(); }
});

test("ledger_review garbage new_findings text and \"[1]\" fail with Pi's line, keep the ledger and the claim", async () => {
	const { dir, path, cleanup } = await setupRepo(fixture);
	try {
		const api = createFakeApi(); featureLedger(api); await initialWork(api, dir, path);
		const brief = await reviewStart(api, dir, path);
		const args = reviewArgs(path, brief.item.assignment.claim_token);
		for (const bad of ["[not json", "[1]"]) {
			const before = await readFile(path, "utf8");
			await assert.rejects(call(api, "ledger_review", dir, { ...args, new_findings: bad }), (error: Error) =>
				/Validation failed for tool "ledger_review"/.test(error.message) && /new_findings/.test(error.message) && /Received arguments:/.test(error.message) && error.message.includes(JSON.stringify(bad)));
			assert.equal(await readFile(path, "utf8"), before);
			assert.equal((await itemAt(path)).assignment?.claim_token, brief.item.assignment.claim_token);
		}
	} finally { await cleanup(); }
});
