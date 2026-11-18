import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLedger, ensureParent, ledgerPath, listItems, nextItem, parseLedger, serializeLedger, startItem, submitItem } from "./ledger.ts";
import featureLedger from "./index.ts";
import { createFakeApi, createFakeContext, exec, setupRepo } from "./test-harness.ts";

// The harness provides exec and setupRepo. The ledger lives under plan/, which the
// repo gitignores; setupRepo mirrors that here.

const FIXTURE = `ledger:
  description: Test fixture.
  workspace: .
  branch: {BRANCH}
  validation_scripts:
    - echo base-ok

  features:
    - id: alpha
      status: todo
      goal: >
        Do the thing.
      short_goal: Do the thing.
      acceptance_criteria:
        - The thing is done.
      constraints:
        - No new dependencies.
      files:
        in:
          - src/a.ts
        out: []
      tests:
        - tests/a.test.ts
      limitations:
        - Existing limitation.
      summary: ''
      commits: {}
`;

test("the reference example parses with folded blocks and arrays", async () => {
	const path = fileURLToPath(new URL("../../skills/feature-ledger/references/ledger.yaml", import.meta.url));
	const { ledger, problems } = parseLedger(await readFile(path, "utf8"));
	assert.deepEqual(problems, []);
	assert.equal(ledger!.branch, "chat-ui");
	assert.deepEqual(ledger!.validation_scripts, ["just test all"]);
	assert.equal(ledger!.features.length, 2);
	const item = ledger!.features[0];
	assert.equal(item.id, "search-result-labels");
	assert.equal(item.status, "done");
	assert.match(item.goal, /Option 4\.a of plan\/chat-ui\/agent-improvement-ideas-1\.md/);
	assert.equal(item.short_goal, "Live search with readable result rows.");
	assert.equal(item.acceptance_criteria.length, 3);
	assert.deepEqual(item.files.out, [
		"packages/web/src/features/agent/components/transcript/TranscriptSearch.tsx",
		"packages/web/src/features/agent/lib/format.ts",
	]);
	assert.equal(item.commits.start, "6be88a3");
	assert.match(item.summary, /Pair check passed/);
	// The item omits validation_scripts, so the base list applies.
	assert.equal(item.validation_scripts, undefined);
});

test("serialize then parse round-trips", async () => {
	const path = fileURLToPath(new URL("../../skills/feature-ledger/references/ledger.yaml", import.meta.url));
	const first = parseLedger(await readFile(path, "utf8")).ledger!;
	const again = parseLedger(serializeLedger(first)).ledger!;
	assert.deepEqual(again, first);
});

test("commit hashes that look numeric stay strings", () => {
	const { ledger, problems } = parseLedger("ledger:\n  branch: alpha\n  features:\n    - id: alpha\n      status: done\n      short_goal: Do the thing.\n      commits:\n        start: 6576964\n        end: 1048321\n");
	assert.deepEqual(problems, []);
	assert.equal(ledger!.features[0].commits.start, "6576964");
	assert.equal(ledger!.features[0].commits.end, "1048321");
});

test("start marks the item in-progress and records the start commit", async () => {
	const { dir, branch, cleanup } = await setupRepo(FIXTURE);
	try {
		const result = await startItem({ repoRoot: dir, branch, id: "alpha", exec });
		assert.equal(result.item.status, "in-progress");
		assert.match(result.item.commits.start!, /^[0-9a-f]{7,}$/);
		assert.deepEqual(result.brief.acceptance_criteria, ["The thing is done."]);
		assert.deepEqual(result.brief.tests, ["tests/a.test.ts"]);
		assert.deepEqual(result.brief.validation_scripts, ["echo base-ok"]);
		const reread = parseLedger(await readFile(ledgerPath(dir, branch), "utf8")).ledger!;
		assert.equal(reread.features[0].status, "in-progress");
		assert.equal(reread.features[0].commits.start, result.item.commits.start);
		const second = await startItem({ repoRoot: dir, branch, id: "alpha", exec }).catch((error) => error as Error);
		assert.match(second.message, /already in-progress/);
	} finally { await cleanup(); }
});

test("a failed validation rejects the submit and writes the full log", async () => {
	const fixture = FIXTURE.replace("echo base-ok", "sh -c 'echo failing-line >&2; exit 1'");
	const { dir, branch, cleanup } = await setupRepo(fixture);
	try {
		await startItem({ repoRoot: dir, branch, id: "alpha", exec });
		await writeFile(join(dir, "src.txt"), "work\n");
		const headBefore = (await exec("git", ["rev-parse", "HEAD"], dir)).stdout.trim();
		const result = await submitItem({
			repoRoot: dir, branch, id: "alpha", commitMessage: "feat: alpha", summary: "Done.", limitations: [],
			exec, logDir: dir,
		});
		assert.ok(result.rejected);
		assert.match(result.script, /exit 1/);
		assert.equal(result.exit, 1);
		assert.match(result.lastOutput, /failing-line/);
		assert.match(await readFile(result.logPath, "utf8"), /failing-line/);
		// Nothing was written to the ledger and nothing was committed.
		const reread = parseLedger(await readFile(ledgerPath(dir, branch), "utf8")).ledger!;
		assert.equal(reread.features[0].status, "in-progress");
		assert.equal((await exec("git", ["rev-parse", "HEAD"], dir)).stdout.trim(), headBefore);
	} finally { await cleanup(); }
});

test("a passing validation commits and closes the item", async () => {
	const { dir, branch, cleanup } = await setupRepo(FIXTURE);
	try {
		const started = await startItem({ repoRoot: dir, branch, id: "alpha", exec });
		await ensureParent(join(dir, "src/a.ts"));
		await writeFile(join(dir, "src/a.ts"), "changed\n");
		const result = await submitItem({
			repoRoot: dir, branch, id: "alpha", commitMessage: "feat: alpha",
			summary: "Did the thing. Pair check passed (artifacts/alpha/1/after.png).",
			limitations: ["No focus ring."], exec, logDir: dir,
		});
		assert.ok(!result.rejected);
		const reread = parseLedger(await readFile(ledgerPath(dir, branch), "utf8")).ledger!;
		const item = reread.features[0];
		assert.equal(item.status, "done");
		assert.deepEqual(item.files.out, ["src/a.ts"]);
		assert.match(item.summary, /Pair check passed/);
		assert.deepEqual(item.limitations, ["Existing limitation.", "No focus ring."]);
		assert.equal(item.commits.end, result.commit);
		assert.equal(item.commits.start, started.item.commits.start);
	} finally { await cleanup(); }
});

test("submit refuses an item that is not in-progress", async () => {
	const { dir, branch, cleanup } = await setupRepo(FIXTURE);
	try {
		const error = await submitItem({ repoRoot: dir, branch, id: "alpha", commitMessage: "x", summary: "y", limitations: [], exec, logDir: dir }).catch((error) => error as Error);
		assert.match(error.message, /submit requires in-progress/);
	} finally { await cleanup(); }
});

test("submit refuses a clean tree and a moved HEAD", async () => {
	const { dir, branch, cleanup } = await setupRepo(FIXTURE);
	try {
		await startItem({ repoRoot: dir, branch, id: "alpha", exec });
		const clean = await submitItem({ repoRoot: dir, branch, id: "alpha", commitMessage: "x", summary: "y", limitations: [], exec, logDir: dir }).catch((error) => error as Error);
		assert.match(clean.message, /no changes/);
		await writeFile(join(dir, "work.txt"), "work\n");
		await exec("git", ["add", "-A"], dir);
		await exec("git", ["commit", "-q", "-m", "extra commit during the work"], dir);
		const moved = await submitItem({ repoRoot: dir, branch, id: "alpha", commitMessage: "x", summary: "y", limitations: [], exec, logDir: dir }).catch((error) => error as Error);
		assert.match(moved.message, /HEAD moved/);
	} finally { await cleanup(); }
});

test("a missing short_goal is reported as a problem", () => {
	const { problems } = parseLedger("ledger:\n  branch: alpha\n  features:\n    - id: alpha\n      status: todo\n      goal: Do the thing.\n");
	assert.deepEqual(problems, ["features[0] (alpha): missing short_goal"]);
	const empty = parseLedger("ledger:\n  branch: alpha\n  features:\n    - id: alpha\n      status: todo\n      short_goal: ''\n");
	assert.deepEqual(empty.problems, ["features[0] (alpha): missing short_goal"]);
});

test("checkLedger reports no problems for a clean ledger", () => {
	const clean = [
		"ledger:",
		"  branch: alpha",
		"  features:",
		"    - id: first",
		"      status: todo",
		"      short_goal: First item.",
		"    - id: second",
		"      status: done",
		"      short_goal: Second item.",
	].join("\n");
	assert.deepEqual(checkLedger(clean), []);
});

test("checkLedger reports no problems for the reference example", async () => {
	const path = fileURLToPath(new URL("../../skills/feature-ledger/references/ledger.yaml", import.meta.url));
	assert.deepEqual(checkLedger(await readFile(path, "utf8")), []);
});

test("checkLedger reports duplicate ids for the second and later occurrence", () => {
	const two = [
		"ledger:",
		"  branch: alpha",
		"  features:",
		"    - id: first",
		"      status: todo",
		"      short_goal: First item.",
		"    - id: first",
		"      status: todo",
		"      short_goal: Second item with the same id.",
	].join("\n");
	assert.deepEqual(checkLedger(two), ["features[1] (first): duplicate id"]);

	const three = [
		"ledger:",
		"  branch: alpha",
		"  features:",
		"    - id: first",
		"      status: todo",
		"      short_goal: First item.",
		"    - id: first",
		"      status: done",
		"      short_goal: Second item with the same id.",
		"    - id: first",
		"      status: done",
		"      short_goal: Third item with the same id.",
	].join("\n");
	assert.deepEqual(checkLedger(three), ["features[1] (first): duplicate id", "features[2] (first): duplicate id"]);
});

test("checkLedger names the file position when an item is skipped", () => {
	const skipped = [
		"ledger:",
		"  branch: alpha",
		"  features:",
		"    - id: ''",
		"      status: todo",
		"      short_goal: No id.",
		"    - id: first",
		"      status: todo",
		"      short_goal: First item.",
		"    - id: first",
		"      status: todo",
		"      short_goal: Second item with the same id.",
	].join("\n");
	assert.deepEqual(checkLedger(skipped), ["features[0]: missing id", "features[2] (first): duplicate id"]);
});

test("checkLedger keeps the existing missing short_goal problems", () => {
	const missing = "ledger:\n  branch: alpha\n  features:\n    - id: alpha\n      status: todo\n      goal: Do the thing.\n";
	assert.deepEqual(checkLedger(missing), ["features[0] (alpha): missing short_goal"]);
	const duplicate = "ledger:\n  branch: alpha\n  features:\n    - id: alpha\n      status: todo\n      short_goal: Do the thing.\n    - id: alpha\n      status: todo\n";
	assert.deepEqual(checkLedger(duplicate), ["features[1] (alpha): missing short_goal", "features[1] (alpha): duplicate id"]);
});

test("parseLedger does not report duplicate ids: read tools keep their behavior", () => {
	const { problems } = parseLedger("ledger:\n  branch: alpha\n  features:\n    - id: alpha\n      status: todo\n      short_goal: First item.\n    - id: alpha\n      status: todo\n      short_goal: Second item with the same id.\n");
	assert.deepEqual(problems, []);
});

test("listItems keeps file order and reports unset commits as null", () => {
	const { ledger } = parseLedger([
		"ledger:",
		"  branch: alpha",
		"  features:",
		"    - id: first",
		"      status: todo",
		"      short_goal: First item.",
		"    - id: second",
		"      status: in-progress",
		"      short_goal: Second item.",
		"      commits:",
		"        start: 6be88a3",
		"    - id: third",
		"      status: done",
		"      short_goal: Third item.",
		"      commits:",
		"        start: 1111111",
		"        end: 2222222",
	].join("\n"));
	assert.deepEqual(listItems(ledger!), {
		branch: "alpha",
		items: [
			{ id: "first", status: "todo", short_goal: "First item.", commits: { start: null, end: null } },
			{ id: "second", status: "in-progress", short_goal: "Second item.", commits: { start: "6be88a3", end: null } },
			{ id: "third", status: "done", short_goal: "Third item.", commits: { start: "1111111", end: "2222222" } },
		],
	});
});

test("nextItem takes the in-progress item before an unstarted one", () => {
	const { ledger } = parseLedger([
		"ledger:",
		"  branch: alpha",
		"  features:",
		"    - id: first",
		"      status: done",
		"      short_goal: First item.",
		"    - id: second",
		"      status: todo",
		"      short_goal: Second item.",
		"    - id: third",
		"      status: in-progress",
		"      short_goal: Third item.",
	].join("\n"));
	assert.deepEqual(nextItem(ledger!), { next: { id: "third", status: "in-progress", short_goal: "Third item." }, status: "in-progress" });
});

test("nextItem reports in-progress for a mixed ledger (some done, some todo)", () => {
	const { ledger } = parseLedger("ledger:\n  branch: alpha\n  features:\n    - id: first\n      status: done\n      short_goal: First item.\n    - id: second\n      status: todo\n      short_goal: Second item.\n");
	assert.deepEqual(nextItem(ledger!), { next: { id: "second", status: "todo", short_goal: "Second item." }, status: "in-progress" });
});

test("listItems errors on an item with no short_goal value", () => {
	const { ledger } = parseLedger("ledger:\n  branch: alpha\n  features:\n    - id: first\n      status: todo\n      goal: Do the thing.\n");
	assert.throws(() => listItems(ledger!), /item first has no short_goal/);
});

test("nextItem errors on the selected item with no short_goal value", () => {
	const { ledger } = parseLedger("ledger:\n  branch: alpha\n  features:\n    - id: first\n      status: in-progress\n");
	assert.throws(() => nextItem(ledger!), /item first has no short_goal/);
});

test("nextItem reports the first todo when nothing is started", () => {
	const { ledger } = parseLedger("ledger:\n  branch: alpha\n  features:\n    - id: first\n      status: todo\n      short_goal: First item.\n    - id: second\n      status: todo\n      short_goal: Second item.\n");
	assert.deepEqual(nextItem(ledger!), { next: { id: "first", status: "todo", short_goal: "First item." }, status: "todo" });
});

test("nextItem reports all items complete", () => {
	const { ledger } = parseLedger("ledger:\n  branch: alpha\n  features:\n    - id: first\n      status: done\n      short_goal: First item.\n");
	assert.deepEqual(nextItem(ledger!), { next: null, status: "done" });
});

test("nextItem on an empty ledger reports todo with no next", () => {
	const { ledger } = parseLedger("ledger:\n  branch: alpha\n  features: []\n");
	assert.deepEqual(nextItem(ledger!), { next: null, status: "todo" });
});

test("the harness runs a tool against a temporary repository with no Pi session", async () => {
	const { dir, branch, cleanup } = await setupRepo(FIXTURE);
	try {
		const api = createFakeApi();
		featureLedger(api);
		assert.ok(Object.keys(api.tools).sort().join(",") === "ledger_check,ledger_list,ledger_next,ledger_start,ledger_submit");

		const ctx = createFakeContext(dir);
		const list = await api.tools.ledger_list.execute(null, {}, null, null, ctx);
		assert.ok(!list.isError);
		const result = JSON.parse(list.content[0].text);
		assert.equal(result.branch, branch);
		assert.deepEqual(result.items, [{ id: "alpha", status: "todo", short_goal: "Do the thing.", commits: { start: null, end: null } }]);

		const next = await api.tools.ledger_next.execute(null, {}, null, null, ctx);
		assert.ok(!next.isError);
		assert.equal(JSON.parse(next.content[0].text).next.id, "alpha");

		// exec wraps child_process.execFile and returns { code, stdout, stderr }.
		const failed = await api.exec("git", ["symbolic-ref", "refs/not-a-ref"], dir);
		assert.notEqual(failed.code, 0);
		assert.equal(failed.stdout, "");
	} finally { await cleanup(); }
});

test("a submit call with no id names the missing field", async () => {
	const { dir, cleanup } = await setupRepo(FIXTURE);
	try {
		const api = createFakeApi();
		featureLedger(api);
		// id stays first in the schema and in the required list.
		assert.equal((api.tools.ledger_submit.parameters as { required: string[] }).required[0], "id");
		assert.match(api.tools.ledger_submit.description, /Pass id first/);

		const result = await api.tools.ledger_submit.execute(null, {}, null, null, createFakeContext(dir));
		assert.ok(result.isError);
		assert.match(result.content[0].text, /^ledger_submit: id: missing/);

		const partial = await api.tools.ledger_submit.execute(null, { id: "alpha" }, null, null, createFakeContext(dir));
		assert.ok(partial.isError);
		assert.equal(partial.content[0].text, "ledger_submit: commit_message: missing, summary: missing");
	} finally { await cleanup(); }
});
