import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compile } from "@earendil-works/pi-schema";
import { parseLedger, PATCH_BUDGET_BYTES, serializeLedger, type LedgerItem } from "./ledger.ts";
import featureLedger from "./index.ts";
import { createFakeApi, createFakeContext, invoke, exec, setupRepo as setupBaseRepo } from "./test-harness.ts";

delete process.env.PI_LEDGER_PATH;
const fixture = (review: boolean) => `ledger:
  branch: {BRANCH}
  validation_scripts:
    - echo base-ok
  features:
    - id: alpha
      status: todo
      review: ${review}
      short_goal: Do the thing.
      goal: Do the thing.
      files:
        in: [src/a.ts]
        out: []
      limitations:
        - Existing limitation.
      commits: {}
`;
async function setup(review: boolean) {
	const repo = await setupBaseRepo(fixture(review));
	await mkdir(join(repo.dir, "src"));
	return repo;
}
const call = (api: ReturnType<typeof createFakeApi>, dir: string, params: Record<string, unknown>) =>
	invoke(api.tools.ledger_work, params, createFakeContext(dir));
const readItem = async (path: string) => parseLedger(await readFile(path, "utf8")).ledger!.features[0];
async function changeItem(path: string, change: (item: LedgerItem) => void) {
	const ledger = parseLedger(await readFile(path, "utf8")).ledger!;
	change(ledger.features[0]);
	await writeFile(path, serializeLedger(ledger));
}
async function start(api: ReturnType<typeof createFakeApi>, dir: string, path: string, agent_id: string) {
	const result = await call(api, dir, { action: "start", id: "alpha", agent_id, path });
	assert.ok(!result.isError, result.content[0].text);
	return JSON.parse(result.content[0].text);
}
function submitArgs(path: string, agent_id: string, claim_token: string) {
	return { action: "submit", id: "alpha", agent_id, claim_token, commit_message: "Work", summary: "Completed work", path };
}

test("ledger_work exposes action-specific schemas and submits an initial non-review item", async () => {
	const { dir, path, cleanup } = await setup(false);
	try {
		const api = createFakeApi(); featureLedger(api);
		const schema = compile(api.tools.ledger_work.parameters);
		assert.ok(schema.check({ action: "start", id: "alpha", agent_id: "external-agent", path }));
		assert.ok(!schema.check({ action: "start", id: "alpha", agent_id: "x", commit_message: "unexpected" }));
		assert.ok(!schema.check({ action: "submit", id: "alpha", agent_id: "x" }));
		assert.ok(schema.check(submitArgs(path, "x", "token")));
		const brief = await start(api, dir, path, "external-agent");
		assert.equal(brief.item.assignment.id, "alpha-0-worker");
		assert.equal(brief.item.assignment.agent_id, "external-agent");
		assert.equal(brief.config.enabled, false);
		assert.deepEqual(brief.config.validation_scripts, ["echo base-ok"]);
		assert.equal(brief.item.commits.start, brief.item.commits.expected);
		assert.deepEqual(brief.cumulative_diff.implementation.files, []);
		assert.equal(brief.latest_diff, null);
		const params = submitArgs(path, "external-agent", brief.item.assignment.claim_token);
		assert.match((await call(api, dir, { action: "start", id: "alpha", agent_id: "other", path })).content[0].text, /already assigned/);
		assert.match((await call(api, dir, { ...params, agent_id: "other" })).content[0].text, /no matching worker claim/);
		// A submission refused for another identity leaves the held claim exactly as it was.
		const held = await readItem(path);
		assert.equal(held.assignment?.agent_id, "external-agent");
		assert.equal(held.assignment?.claim_token, params.claim_token);
		assert.match((await call(api, dir, { ...params, claim_token: "old" })).content[0].text, /no matching worker claim/);
		assert.match((await call(api, dir, { ...params, empty_commit: true })).content[0].text, /only for a review-fix/);
		assert.match((await call(api, dir, params)).content[0].text, /no implementation changes/);
		await writeFile(join(dir, "src/a.ts"), "implementation\n");
		const result = await call(api, dir, params);
		assert.ok(!result.isError, result.content[0].text);
		const item = await readItem(path);
		assert.equal(item.status, "done");
		assert.equal(item.assignment, undefined);
		assert.equal(item.commits.expected, undefined);
		assert.deepEqual(item.files.out, ["src/a.ts"]);
		assert.deepEqual(item.commits.submissions, [item.commits.end]);
		assert.equal(item.summary, "Completed work");
	} finally { await cleanup(); }
});

test("ledger_work retains claims on validation failure and rejects moved HEAD and wrong branch", async () => {
	const { dir, path, cleanup } = await setup(true);
	try {
		const api = createFakeApi(); featureLedger(api);
		const brief = await start(api, dir, path, "a");
		await writeFile(join(dir, "src/a.ts"), "change\n");
		const params = submitArgs(path, "a", brief.item.assignment.claim_token);
		await changeItem(path, item => { item.validation_scripts = ["echo expected-failure; exit 7"]; });
		const failure = await call(api, dir, params);
		assert.ok(failure.isError);
		assert.match(failure.content[0].text, /exit 7.*claim retained/s);
		assert.match(failure.content[0].text, /expected-failure/);
		assert.equal((await readItem(path)).assignment!.claim_token, params.claim_token);
		await changeItem(path, item => { item.branch = "wrong-branch"; });
		assert.match((await call(api, dir, params)).content[0].text, /wrong-branch/);
		await changeItem(path, item => { delete item.branch; });
		assert.equal((await exec("git", ["commit", "--allow-empty", "-m", "move HEAD"], dir)).code, 0);
		assert.match((await call(api, dir, params)).content[0].text, /HEAD moved since worker start/);
		assert.equal((await readItem(path)).assignment!.claim_token, params.claim_token);
	} finally { await cleanup(); }
});

test("a limit lowered during a held claim does not block that submission", async () => {
	const { dir, path, cleanup } = await setup(true);
	try {
		const api = createFakeApi(); featureLedger(api);
		const brief = await start(api, dir, path, "a");
		await writeFile(join(dir, "src/a.ts"), "change\n");
		// The limit governs starting another attempt only, so the held claim can still finish.
		await changeItem(path, item => { item.failed_reviews = 5; item.max_failed_reviews = 3; item.assignment!.id = "alpha-5-worker"; });
		const result = await call(api, dir, submitArgs(path, "a", brief.item.assignment.claim_token));
		assert.ok(!result.isError, result.content[0].text);
		assert.equal((await readItem(path)).status, "review");
	} finally { await cleanup(); }
});

test("ledger_work review fixes return cumulative and latest diffs, findings, and fresh claims", async () => {
	const { dir, path, cleanup } = await setup(true);
	try {
		const api = createFakeApi(); featureLedger(api);
		const first = await start(api, dir, path, "alpha-0-worker");
		await writeFile(join(dir, "src/a.ts"), "initial\n");
		let result = await call(api, dir, submitArgs(path, "alpha-0-worker", first.item.assignment.claim_token));
		assert.ok(!result.isError, result.content[0].text);
		assert.equal((await readItem(path)).status, "review");
		await changeItem(path, item => {
			item.status = "in-progress"; item.failed_reviews = 1;
			item.findings = [
				{ id: "one", status: "open", severity: "major", details: "Fix it", rationale: "Needed", first_found_iteration: 1, required_checks: ["true"] },
				{ id: "two", status: "closed", severity: "nit", details: "Closed", rationale: "Done", first_found_iteration: 1, required_checks: [] },
			];
		});
		const second = await start(api, dir, path, "independent-agent");
		assert.equal(second.item.assignment.id, "alpha-1-worker");
		assert.notEqual(second.item.assignment.claim_token, first.item.assignment.claim_token);
		assert.deepEqual(second.pending_findings.map((f: { id: string }) => f.id), ["one"]);
		assert.deepEqual(second.cumulative_diff.implementation.files, ["src/a.ts"]);
		assert.match(second.latest_diff.implementation.patch, /\+initial/);
		assert.match((await call(api, dir, submitArgs(path, "independent-agent", first.item.assignment.claim_token))).content[0].text, /no matching worker claim/);
		await mkdir(join(dir, "more"));
		await writeFile(join(dir, "more/fix.ts"), "fixed\n");
		result = await call(api, dir, { ...submitArgs(path, "independent-agent", second.item.assignment.claim_token), limitations: ["Known limit"] });
		assert.ok(!result.isError, result.content[0].text);
		const fixed = await readItem(path);
		assert.equal(fixed.status, "review");
		assert.deepEqual(fixed.files.out, ["more/fix.ts", "src/a.ts"]);
		assert.equal(fixed.commits.submissions!.length, 2);
		assert.equal(fixed.commits.start, first.item.commits.start);
		assert.equal(fixed.limitations.at(-1), "Known limit");
		await changeItem(path, item => { item.status = "in-progress"; item.failed_reviews = 2; });
		const third = await start(api, dir, path, "again");
		assert.deepEqual(third.latest_diff.implementation.files, ["more/fix.ts"]);
		assert.deepEqual(third.cumulative_diff.implementation.files, ["more/fix.ts", "src/a.ts"]);
	} finally { await cleanup(); }
});

test("ledger_work empty review-fix commits preserve staged and unstaged work and run validations", async () => {
	const { dir, path, cleanup } = await setup(true);
	try {
		const api = createFakeApi(); featureLedger(api);
		const first = await start(api, dir, path, "a");
		await writeFile(join(dir, "src/a.ts"), "first\n");
		const initial = await call(api, dir, submitArgs(path, "a", first.item.assignment.claim_token));
		assert.ok(!initial.isError, initial.content[0].text);
		await changeItem(path, item => { item.status = "in-progress"; item.failed_reviews = 1; item.validation_scripts = ["echo ran > validation-marker"]; });
		const second = await start(api, dir, path, "b");
		await writeFile(join(dir, "src/a.ts"), "staged\n");
		assert.equal((await exec("git", ["add", "src/a.ts"], dir)).code, 0);
		await writeFile(join(dir, "src/a.ts"), "unstaged\n");
		const result = await call(api, dir, { ...submitArgs(path, "b", second.item.assignment.claim_token), summary: "Finding already addressed; no code change required", empty_commit: true });
		assert.ok(!result.isError, result.content[0].text);
		assert.equal(await readFile(join(dir, "validation-marker"), "utf8"), "ran\n");
		assert.equal((await exec("git", ["diff", "--cached", "--name-only"], dir)).stdout.trim(), "src/a.ts");
		assert.equal((await exec("git", ["show", ":src/a.ts"], dir)).stdout, "staged\n");
		assert.equal(await readFile(join(dir, "src/a.ts"), "utf8"), "unstaged\n");
		assert.equal((await exec("git", ["diff", "HEAD^", "HEAD", "--name-only"], dir)).stdout, "");
		assert.deepEqual((await readItem(path)).files.out, ["src/a.ts"]);
	} finally { await cleanup(); }
});

test("ledger_work separates tracked ledger metadata and stores full oversized patches", async () => {
	const { dir, path, cleanup } = await setup(true);
	try {
		assert.equal((await exec("git", ["add", "-f", "plan/ledger.yaml"], dir)).code, 0);
		assert.equal((await exec("git", ["commit", "-m", "Track metadata"], dir)).code, 0);
		const api = createFakeApi(); featureLedger(api);
		const first = await start(api, dir, path, "a");
		assert.equal((await exec("git", ["add", "-f", "plan/ledger.yaml"], dir)).code, 0);
		const stagedLedger = (await exec("git", ["show", ":plan/ledger.yaml"], dir)).stdout;
		await writeFile(join(dir, "src/a.ts"), "x".repeat(40000) + "\n");
		const result = await call(api, dir, submitArgs(path, "a", first.item.assignment.claim_token));
		assert.ok(!result.isError, result.content[0].text);
		assert.deepEqual((await readItem(path)).files.out, ["src/a.ts"]);
		assert.equal((await exec("git", ["diff", "HEAD^", "HEAD", "--name-only"], dir)).stdout.trim(), "src/a.ts");
		assert.equal((await exec("git", ["show", ":plan/ledger.yaml"], dir)).stdout, stagedLedger);
		await changeItem(path, item => { item.status = "in-progress"; item.failed_reviews = 1; });
		assert.equal((await exec("git", ["add", "-f", "plan/ledger.yaml"], dir)).code, 0);
		assert.equal((await exec("git", ["commit", "-m", "Review metadata"], dir)).code, 0);
		const brief = await start(api, dir, path, "b");
		assert.deepEqual(brief.cumulative_diff.implementation.files, ["src/a.ts"]);
		assert.deepEqual(brief.cumulative_diff.ledger_metadata.files, ["plan/ledger.yaml"]);
		assert.equal(brief.cumulative_diff.implementation.truncated, true);
		assert.ok(brief.cumulative_diff.implementation.full_patch_path);
		assert.match(await readFile(brief.cumulative_diff.implementation.full_patch_path, "utf8"), /x{40000}/);
		assert.deepEqual(brief.latest_diff.ledger_metadata.files, []);
	} finally { await cleanup(); }
});

// A truncated view returns the bytes it was allowed plus the truncation notice naming its artifact.
function splitPreview(patch: string): { preview: string; artifact: string } | null {
	const match = /^([\s\S]*?)\n\[Patch truncated; full patch: ([^\]]+)\]$/.exec(patch);
	return match ? { preview: match[1], artifact: match[2] } : null;
}

test("worker start applies one shared patch budget across its four views", async () => {
	const { dir, path, cleanup } = await setup(true);
	try {
		assert.equal((await exec("git", ["add", "-f", "plan/ledger.yaml"], dir)).code, 0);
		assert.equal((await exec("git", ["commit", "-m", "Track metadata"], dir)).code, 0);
		const api = createFakeApi(); featureLedger(api);
		const first = await start(api, dir, path, "a");
		await writeFile(join(dir, "src/a.ts"), "x".repeat(6000) + "\n");
		const submitted = await call(api, dir, submitArgs(path, "a", first.item.assignment.claim_token));
		assert.ok(!submitted.isError, submitted.content[0].text);
		// A worker submission commits implementation only, so the oversized ledger change needs its own commit.
		await changeItem(path, item => { item.status = "in-progress"; item.failed_reviews = 1; item.limitations.push("y".repeat(6000)); });
		assert.equal((await exec("git", ["add", "-f", "plan/ledger.yaml"], dir)).code, 0);
		assert.equal((await exec("git", ["commit", "-m", "Review metadata"], dir)).code, 0);
		const brief = await start(api, dir, path, "b");
		// Views are cumulative implementation, cumulative ledger metadata, latest implementation, latest ledger metadata.
		const views = [brief.cumulative_diff.implementation, brief.cumulative_diff.ledger_metadata, brief.latest_diff.implementation, brief.latest_diff.ledger_metadata];
		// The first view is larger than the whole allowance on its own, so it takes all of it.
		assert.equal(splitPreview(views[0].patch)!.preview.length, PATCH_BUDGET_BYTES);
		// Every later view with changes has nothing left, so it returns files and stat with a note naming its artifact.
		for (const view of views.slice(1, 3)) {
			const parts = splitPreview(view.patch);
			assert.ok(parts, `view must report truncation with an artifact path: ${view.patch}`);
			assert.equal(view.truncated, true);
			assert.equal(parts.preview, "");
			assert.equal(parts.artifact, view.full_patch_path);
			assert.match(view.stat, /src\/a\.ts|plan\/ledger\.yaml/);
		}
		// The last view covers a commit with no change in that path, so there is nothing to truncate.
		assert.deepEqual(views[3], { files: [], stat: "", patch: "", truncated: false });
		let returnedBytes = 0;
		for (const view of views) returnedBytes += view.truncated ? splitPreview(view.patch)!.preview.length : view.patch.length;
		assert.ok(returnedBytes <= PATCH_BUDGET_BYTES, `response returned ${returnedBytes} bytes over the shared budget`);
		assert.deepEqual(views.map((view) => view.files), [["src/a.ts"], ["plan/ledger.yaml"], ["src/a.ts"], []]);
		assert.match(await readFile(views[0].full_patch_path!, "utf8"), /x{6000}/);
		assert.match(await readFile(views[1].full_patch_path!, "utf8"), /y{6000}/);
	} finally { await cleanup(); }
});

// A submission commit can be the first commit in the repository, so there is no parent to compare against.
// The response must say why instead of passing a raw git failure through to the caller.
test("worker start returns an empty latest view with a note when the submission commit has no parent", async () => {
	const { dir, path, cleanup } = await setup(true);
	try {
		const api = createFakeApi(); featureLedger(api);
		// An orphan branch makes the next commit a root commit with no parent.
		assert.equal((await exec("git", ["checkout", "-q", "--orphan", "root-commit"], dir)).code, 0);
		assert.equal((await exec("git", ["commit", "-q", "--allow-empty", "-m", "Root commit"], dir)).code, 0);
		const root = (await exec("git", ["rev-parse", "HEAD"], dir)).stdout.trim();
		await changeItem(path, item => { delete item.branch; item.status = "in-progress"; item.failed_reviews = 1; item.commits.start = root; item.commits.submissions = [root]; });
		const brief = await start(api, dir, path, "a");
		assert.match(brief.latest_diff.note!, new RegExp(`^Submission commit ${root} is the first commit in the repository and has no parent, so the latest view is empty\.$`));
		assert.equal(brief.latest_diff.from, "");
		assert.equal(brief.latest_diff.to, root);
		assert.deepEqual(brief.latest_diff.implementation, { files: [], stat: "", patch: "", truncated: false });
		assert.deepEqual(brief.latest_diff.ledger_metadata, { files: [], stat: "", patch: "", truncated: false });
		// The cumulative view still resolves its base from the ledger record.
		assert.equal(brief.cumulative_diff.from, root);
		assert.equal(brief.cumulative_diff.to, root);
		// A later submission does have a parent, so the normal latest diff works again.
		await writeFile(join(dir, "src/a.ts"), "later work\n");
		const submitted = await call(api, dir, submitArgs(path, "a", brief.item.assignment.claim_token));
		assert.ok(!submitted.isError, submitted.content[0].text);
		const secondCommit = (await readItem(path)).commits.submissions!.at(-1)!;
		assert.notEqual(secondCommit, root);
		await changeItem(path, item => { item.status = "in-progress"; item.failed_reviews = 2; });
		const after = await start(api, dir, path, "b");
		assert.equal(after.latest_diff.note, undefined);
		assert.equal(after.latest_diff.from, root);
		assert.equal(after.latest_diff.to, secondCommit);
		assert.deepEqual(after.latest_diff.implementation.files, ["src/a.ts"]);
		assert.match(after.latest_diff.implementation.patch, /\+later work/);
	} finally { await cleanup(); }
});

test("ledger_work reports post-commit failures with the commit and recovery guidance", async () => {
	const { dir, path, cleanup } = await setup(false);
	try {
		const api = createFakeApi();
		let failDiff = false;
		api.exec = async (command, args, cwd) => {
			if (failDiff && command === "git" && args[0] === "diff" && args[1] === "--name-only") return { code: 1, stdout: "", stderr: "injected diff failure" };
			return exec(command, args, cwd);
		};
		featureLedger(api);
		const brief = await start(api, dir, path, "a");
		await writeFile(join(dir, "src/a.ts"), "change\n");
		failDiff = true;
		const result = await call(api, dir, submitArgs(path, "a", brief.item.assignment.claim_token));
		assert.ok(result.isError);
		assert.match(result.content[0].text, /created commit [0-9a-f]{40}/);
		assert.match(result.content[0].text, /Do not retry blindly.*injected diff failure/);
		assert.equal((await readItem(path)).assignment!.claim_token, brief.item.assignment.claim_token);
	} finally { await cleanup(); }
});

test("ledger_work start enforces state, branch, the start-only cap and raised or unlimited limits", async () => {
	const { dir, path, cleanup } = await setup(true);
	try {
		const api = createFakeApi(); featureLedger(api);
		const params = { action: "start", id: "alpha", agent_id: "a", path };
		await changeItem(path, item => { item.status = "review"; });
		assert.match((await call(api, dir, params)).content[0].text, /worker start requires todo or in-progress/);
		await changeItem(path, item => { item.status = "todo"; item.branch = "not-this-branch"; });
		assert.match((await call(api, dir, params)).content[0].text, /not-this-branch/);
		const head = (await exec("git", ["rev-parse", "HEAD"], dir)).stdout.trim();
		await changeItem(path, item => { delete item.branch; item.status = "in-progress"; item.failed_reviews = 5; item.commits.start = head; });
		const cappedStart = (await call(api, dir, params)).content[0].text;
		assert.match(cappedStart, /failed-review limit 5/);
		// The cap governs starting another attempt only, so the error names it as a start refusal.
		assert.match(cappedStart, /before starting another attempt/);
		await changeItem(path, item => { item.max_failed_reviews = 0; });
		const brief = await start(api, dir, path, "a");
		assert.equal(brief.config.max_failed_reviews, 0);
	} finally { await cleanup(); }
});

test("ledger_work commits both sides of a staged rename", async () => {
	const { dir, path, cleanup } = await setup(false);
	try {
		await writeFile(join(dir, "src/old.ts"), "contents\n");
		assert.equal((await exec("git", ["add", "src/old.ts"], dir)).code, 0);
		assert.equal((await exec("git", ["commit", "-m", "Add old path"], dir)).code, 0);
		const api = createFakeApi(); featureLedger(api);
		const brief = await start(api, dir, path, "a");
		assert.equal((await exec("git", ["mv", "src/old.ts", "src/new.ts"], dir)).code, 0);
		const result = await call(api, dir, submitArgs(path, "a", brief.item.assignment.claim_token));
		assert.ok(!result.isError, result.content[0].text);
		assert.equal((await exec("git", ["status", "--porcelain"], dir)).stdout, "");
		assert.notEqual((await exec("git", ["cat-file", "-e", "HEAD:src/old.ts"], dir)).code, 0);
		assert.equal((await exec("git", ["show", "HEAD:src/new.ts"], dir)).stdout, "contents\n");
	} finally { await cleanup(); }
});

test("ledger_work treats Git pathspec metacharacters in filenames literally", async () => {
	const { dir, path, cleanup } = await setup(false);
	try {
		const api = createFakeApi(); featureLedger(api);
		const brief = await start(api, dir, path, "a");
		await writeFile(join(dir, ":file.ts"), "contents\n");
		const result = await call(api, dir, submitArgs(path, "a", brief.item.assignment.claim_token));
		assert.ok(!result.isError, result.content[0].text);
		assert.deepEqual((await readItem(path)).files.out, [":file.ts"]);
	} finally { await cleanup(); }
});

test("ledger_work shape errors: hard failures show Pi's line, late failures show the shape line", async () => {
	const { dir, path, cleanup } = await setup(false);
	try {
		const api = createFakeApi(); featureLedger(api);
		const brief = await start(api, dir, path, "a");
		const args = submitArgs(path, "a", brief.item.assignment.claim_token);
		const before = await readFile(path, "utf8");
		await assert.rejects(call(api, dir, { ...args, limitations: [{ a: 1 }] }), (error: Error) => /Validation failed for tool "ledger_work"/.test(error.message) && /limitations\.0/.test(error.message) && /Received arguments:/.test(error.message));
		const late = await api.tools.ledger_work.execute(null, { ...args, limitations: "no focus ring, slow" }, null, null, createFakeContext(dir));
		assert.ok(late.isError);
		assert.match(late.content[0].text, /limitations must be a list of strings, got "no focus ring, slow"/);
		assert.equal(await readFile(path, "utf8"), before);
		assert.equal((await readItem(path)).assignment?.claim_token, brief.item.assignment.claim_token);
	} finally { await cleanup(); }
});

test("ledger_work limitations as JSON text records two entries", async () => {
	const { dir, path, cleanup } = await setup(false);
	try {
		const api = createFakeApi(); featureLedger(api);
		const brief = await start(api, dir, path, "a");
		await writeFile(join(dir, "code.txt"), "implementation\n");
		const result = await call(api, dir, { ...submitArgs(path, "a", brief.item.assignment.claim_token), limitations: JSON.stringify(["no focus ring", "slow"]) });
		assert.ok(!result.isError, result.content[0].text);
		assert.deepEqual((await readItem(path)).limitations.slice(-2), ["no focus ring", "slow"]);
	} finally { await cleanup(); }
});
