import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@earendil-works/pi-schema";
import { parseLedger, serializeLedger, submitReview, type LedgerItem } from "./ledger.ts";
import featureLedger from "./index.ts";
import { createFakeApi, createFakeContext, exec, setupRepo } from "./test-harness.ts";

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
const call = (api: ReturnType<typeof createFakeApi>, tool: string, dir: string, params: Record<string, unknown>) => api.tools[tool].execute(null, params, null, null, createFakeContext(dir));
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
const reviewArgs = (path: string, token: string, agent_id = "reviewer") => ({ action: "submit", id: "alpha", agent_id, claim_token: token, path });
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
		assert.ok(schema.check({ action: "submit", id: "alpha", agent_id: "x", claim_token: "t" }));
		assert.ok(!schema.check({ action: "submit", id: "alpha", agent_id: "x" }));
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
		for (const invalid of [{ ...args, agent_id: "wrong" }, { ...args, claim_token: "stale" }, { ...args, close_findings: ["unknown"] }, { ...args, close_findings: ["same", "same"] }, { ...args, new_findings: [finding("critical")] }, { ...args, new_findings: [{ ...finding("nit"), required_checks: [""] }] }]) {
			const before = await readFile(path, "utf8");
			assert.ok((await call(api, "ledger_review", dir, invalid)).isError);
			assert.equal(await readFile(path, "utf8"), before);
		}
		const first = await call(api, "ledger_review", dir, { ...args, new_findings: ["blocker", "major", "minor", "nit"].map(finding) });
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
		assert.match((await call(api, "ledger_work", dir, { action: "start", id: "alpha", agent_id: "fixer", path })).content[0].text, /failed-review limit 2/);
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
	for (const severity of [null, "blocker", "major", "minor", "nit"]) {
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
			const result = await call(api, "ledger_review", workspace.dir, reviewArgs(path, brief.item.assignment.claim_token));
			assert.ok(!result.isError, result.content[0].text);
			const output = JSON.parse(result.content[0].text);
			assert.match(output.ledger_commit, /^[a-f0-9]{40}$/);
			assert.match(output.ledger_commit_note, /including pre-existing edits/);
			assert.equal((await exec("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], ledgerRepo.dir)).stdout.trim(), "plan/ledger.yaml");
			assert.match((await exec("git", ["show", "HEAD:plan/ledger.yaml"], ledgerRepo.dir)).stdout, /Pre-existing ledger edit/);
			assert.equal((await exec("git", ["show", ":README.md"], ledgerRepo.dir)).stdout, "staged unrelated\n");
			assert.equal(await readFile(join(ledgerRepo.dir, "README.md"), "utf8"), "unstaged unrelated\n");
		} finally { if (separate) await ledgerRepo.cleanup(); await workspace.cleanup(); }
	}
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
		await assert.rejects(submitReview({ cwd: repo.dir, ledgerPath: repo.path, ledger, workspace: repo.dir, repoRoot: repo.dir, branch: repo.branch, id: "alpha", exec: faultExec, agentId: "reviewer", claimToken: brief.item.assignment.claim_token, closeFindings: [], newFindings: [] }), /may be partially written, no commit attempted/);
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
