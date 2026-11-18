import { test } from "node:test";
import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLedger, ensureParent, isAddableEntry, ledgerPath, listItems, locationProblem, missingPlanProblem, nextItem, parseLedger, planReference, problemTarget, resolveCheckTarget, serializeLedger, startItem, submitItem, trackedPlanProblem, addablePaths } from "./ledger.ts";
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
	// A hash with leading zeros keeps them: a value with a leading zero is not read as a number.
	const zeros = parseLedger("ledger:\n  branch: alpha\n  features:\n    - id: alpha\n      status: done\n      short_goal: Do the thing.\n      commits:\n        start: 0092502\n        end: 1048321\n");
	assert.deepEqual(zeros.problems, []);
	assert.equal(zeros.ledger!.features[0].commits.start, "0092502");
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

test("the entry filter keeps regular files, symbolic links, and directories", () => {
	const entry = (kind: string) => ({
		isFile: () => kind === "file",
		isSymbolicLink: () => kind === "symlink",
		isDirectory: () => kind === "directory",
	});
	assert.ok(isAddableEntry(entry("file")));
	assert.ok(isAddableEntry(entry("symlink")));
	assert.ok(isAddableEntry(entry("directory")));
	assert.ok(!isAddableEntry(entry("character device")));
	assert.ok(!isAddableEntry(entry("block device")));
	assert.ok(!isAddableEntry(entry("socket")));
});

test("the pathspec is built from the addable entries only", async () => {
	const kinds: Record<string, string> = {
		".pi-dotfile": "character device",
		"src/a.ts": "file",
		"docs/link.md": "symlink",
		"artifacts": "directory",
		"src/b.ts": "file",
	};
	const fakeStat = async (path: string) => {
		const kind = kinds[path.slice("/repo/".length)];
		return {
			isFile: () => kind === "file",
			isSymbolicLink: () => kind === "symlink",
			isDirectory: () => kind === "directory",
		};
	};
	const porcelain = ["?? .pi-dotfile", "?? src/a.ts", "?? docs/link.md", "?? artifacts", "R  src/b.ts -> src/a.ts", ""].join("\n");
	assert.deepEqual(await addablePaths(porcelain, "/repo", fakeStat), ["src/a.ts", "docs/link.md", "artifacts", "src/b.ts"]);
});

test("a device entry is skipped and only the real file is staged", async () => {
	const { dir, branch, cleanup } = await setupRepo(FIXTURE);
	// The sandbox view shows a project-root dotfile as a character device, which git add cannot
	// take. The stat is injected because the sandbox cannot create a device.
	const fakeStat = async (path: string) => ({
		isFile: () => path.endsWith("src/a.ts"),
		isSymbolicLink: () => false,
		isDirectory: () => false,
	});
	try {
		await startItem({ repoRoot: dir, branch, id: "alpha", exec });
		await ensureParent(join(dir, "src/a.ts"));
		await writeFile(join(dir, "src/a.ts"), "changed\n");
		const addArgs: string[][] = [];
		const recordingExec = async (command: string, args: string[], cwd: string) => {
			if (command === "git" && args[0] === "status") return { code: 0, stdout: "?? .pi-dotfile\n?? src/a.ts\n", stderr: "" };
			if (command === "git" && args[0] === "add") addArgs.push(args);
			return exec(command, args, cwd);
		};
		const result = await submitItem({
			repoRoot: dir, branch, id: "alpha", commitMessage: "feat: alpha",
			summary: "Did the thing.", limitations: [], exec: recordingExec, logDir: dir, stat: fakeStat,
		});
		assert.ok(!result.rejected);
		assert.deepEqual(addArgs[0], ["add", "--", "src/a.ts"]);
		// files.out still comes from the commit diff, so the skipped entry is not in it.
		assert.deepEqual(result.filesOut, ["src/a.ts"]);
	} finally {
		await cleanup();
	}
});

test("a tree with only a device entry reports no changes", async () => {
	const { dir, branch, cleanup } = await setupRepo(FIXTURE);
	const fakeStat = async () => ({ isFile: () => false, isSymbolicLink: () => false, isDirectory: () => false });
	try {
		await startItem({ repoRoot: dir, branch, id: "alpha", exec });
		const noiseOnly = async (command: string, args: string[], cwd: string) => {
			if (command === "git" && args[0] === "status") return { code: 0, stdout: "?? .pi-dotfile\n", stderr: "" };
			return exec(command, args, cwd);
		};
		const error = await submitItem({
			repoRoot: dir, branch, id: "alpha", commitMessage: "x", summary: "y", limitations: [], exec: noiseOnly, logDir: dir, stat: fakeStat,
		}).catch((error) => error as Error);
		assert.match(error.message, /no changes/);
	} finally {
		await cleanup();
	}
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
		"    - \"not an item\"",
		"    - id: first",
		"      status: todo",
		"      short_goal: First item.",
		"    - id: first",
		"      status: todo",
		"      short_goal: Second item with the same id.",
	].join("\n");
	assert.deepEqual(checkLedger(skipped), ["features[0] is not an item", "features[2] (first): duplicate id"]);
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

test("a bullet that parses as a mapping is reported as a problem line", () => {
	const mapping = [
		"ledger:",
		"  branch: alpha",
		"  features:",
		"    - id: alpha",
		"      status: todo",
		"      short_goal: Do the thing.",
		"      constraints:",
		"        - Read-only: the tool never writes the ledger.",
	].join("\n");
	assert.deepEqual(parseLedger(mapping).problems, [
		'features[0] (alpha): constraints[0] is not a string (a bullet that starts with "key: value" reads as a mapping)',
	]);
	assert.deepEqual(checkLedger(mapping), [
		'features[0] (alpha): constraints[0] is not a string (a bullet that starts with "key: value" reads as a mapping)',
	]);

	// A quoted bullet is a string: no problem.
	const quoted = [
		"ledger:",
		"  branch: alpha",
		"  features:",
		"    - id: alpha",
		"      status: todo",
		"      short_goal: Do the thing.",
		"      constraints:",
		'        - "Read-only: the tool never writes the ledger."',
	].join("\n");
	assert.deepEqual(parseLedger(quoted).problems, []);
	assert.deepEqual(checkLedger(quoted), []);
	assert.deepEqual(parseLedger(quoted).ledger!.features[0].constraints, ["Read-only: the tool never writes the ledger."]);

	// Read tools keep their behavior: the mapping entry still reaches the reader as [object Object].
	const { ledger } = parseLedger(mapping);
	assert.deepEqual(listItems(ledger!).items[0].short_goal, "Do the thing.");
	assert.deepEqual(nextItem(ledger!).next!.short_goal, "Do the thing.");
});

test("an unborn branch reports the configured init.defaultBranch name", async () => {
	const dir = await mkdtemp(join(tmpdir(), "feature-ledger-"));
	try {
		await exec("git", ["-c", "init.defaultBranch=feature-x", "init", "-q"], dir);
		// The ledger file must exist for the check to read it; the branch name comes from the symbolic ref.
		await ensureParent(ledgerPath(dir, "feature-x"));
		await writeFile(ledgerPath(dir, "feature-x"), "ledger:\n  branch: feature-x\n  features: []\n");
		const api = createFakeApi();
		featureLedger(api);
		const result = JSON.parse((await api.tools.ledger_check.execute(null, {}, null, null, createFakeContext(dir))).content[0].text);
		assert.match(result.path, /\/plan\/feature-x\/ledger\.yaml$/);
		assert.ok(result.ok);
	} finally { await rm(dir, { recursive: true }); }
});

test("a detached HEAD resolves through the fallback", async () => {
	const { dir, branch, cleanup } = await setupRepo(FIXTURE);
	try {
		await execFile("git", ["checkout", "--detach", "-q"], { cwd: dir });
		// The default target is now plan/HEAD/, so the file must be readable there for the
		// location line to be produced.
		await ensureParent(ledgerPath(dir, "HEAD"));
		await writeFile(ledgerPath(dir, "HEAD"), await readFile(ledgerPath(dir, branch), "utf8"));
		const api = createFakeApi();
		featureLedger(api);
		const result = JSON.parse((await api.tools.ledger_check.execute(null, {}, null, null, createFakeContext(dir))).content[0].text);
		assert.match(result.path, /\/plan\/HEAD\/ledger\.yaml$/);
		assert.ok(result.ok);
	} finally { await cleanup(); }
});

test("resolveCheckTarget resolves a relative path against cwd and uses an absolute path as given", () => {
	assert.equal(resolveCheckTarget("/repo"), "/repo");
	assert.equal(resolveCheckTarget("/repo/work", "draft/ledger.yaml"), "/repo/work/draft/ledger.yaml");
	assert.equal(resolveCheckTarget("/repo/work", "/tmp/draft.yaml"), "/tmp/draft.yaml");
	// With no path, the caller-supplied default target is used.
	assert.equal(resolveCheckTarget("/repo/work", undefined, ledgerPath("/repo", "feature-x")), "/repo/plan/feature-x/ledger.yaml");
});

test("locationProblem names the location line only for a path outside plan/<branch>/", () => {
	assert.equal(locationProblem(ledgerPath("/repo", "feature-x"), "/repo", "feature-x"), null);
	assert.equal(locationProblem("/repo/plan/other/ledger.yaml", "/repo", "feature-x"),
		"path is not plan/feature-x/ledger.yaml for branch feature-x (ledger_list will not find it)");
	// No branch (a draft ledger outside a repo): no location line.
	assert.equal(locationProblem("/tmp/draft.yaml", "", ""), null);
});

const GOAL_WITH_PLAN = FIXTURE.replace(
	"      goal: >\n        Do the thing.",
	"      goal: Option 9 of plan/2026-11-18_missing-plan.md. Do the thing.",
);

test("planReference reads the plan path out of a goal", () => {
	assert.equal(planReference("Option 4.a of plan/chat-ui/agent-improvement-ideas-1.md. Live search."), "plan/chat-ui/agent-improvement-ideas-1.md");
	assert.equal(planReference("Do the thing."), null);
});

test("the two new lines follow the location line in wording", () => {
	assert.equal(missingPlanProblem(problemTarget(0, "alpha", "goal"), "plan/x.md"),
		"features[0] (alpha): goal names a plan file that does not exist (plan/x.md)");
	assert.equal(trackedPlanProblem(["plan/feature-x/ledger.yaml"]),
		"git ls-files plan/ is not empty: plan/feature-x/ledger.yaml (the plan and the ledger are removed before the PR is opened)");
});

test("checkLedger stays free of the git and filesystem checks", () => {
	assert.deepEqual(checkLedger(GOAL_WITH_PLAN.replace("{BRANCH}", "feature-x")), []);
});

test("ledger_check reports a goal that names a plan file that does not exist", async () => {
	const { dir, branch, cleanup } = await setupRepo(GOAL_WITH_PLAN);
	try {
		const api = createFakeApi();
		featureLedger(api);
		const result = await api.tools.ledger_check.execute(null, {}, null, null, createFakeContext(dir));
		assert.ok(result.isError);
		assert.deepEqual(JSON.parse(result.content[0].text).problems, [
			"features[0] (alpha): goal names a plan file that does not exist (plan/2026-11-18_missing-plan.md)",
		]);
	} finally { await cleanup(); }
});

test("ledger_check reports tracked files under plan/", async () => {
	const { dir, branch, cleanup } = await setupRepo(FIXTURE);
	try {
		await exec("git", ["add", "-f", `plan/${branch}/ledger.yaml`], dir);
		const api = createFakeApi();
		featureLedger(api);
		const result = await api.tools.ledger_check.execute(null, {}, null, null, createFakeContext(dir));
		assert.ok(result.isError);
		assert.deepEqual(JSON.parse(result.content[0].text).problems, [
			`git ls-files plan/ is not empty: plan/${branch}/ledger.yaml (the plan and the ledger are removed before the PR is opened)`,
		]);
	} finally { await cleanup(); }
});

test("parseLedger returns the file position of each parsed item", () => {
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
		"    - not an item",
		"    - id: second",
		"      status: todo",
		"      short_goal: Second item.",
	].join("\n");
	const { problems, indexes } = parseLedger(skipped);
	// Item 0 has no id and item 2 is not an item, so neither is in the parsed list.
	// The parsed items are the ones at file positions 1 and 3, so indexes holds those two.
	assert.deepEqual(indexes, [1, 3]);
	assert.deepEqual(problems, [
		"features[0]: missing id",
		"features[2] is not an item",
	]);
	// The duplicate line names the position in the file, not the index in the parsed list.
	assert.deepEqual(checkLedger(skipped), [
		"features[0]: missing id",
		"features[2] is not an item",
	]);
});

test("a duplicate id names the file position when an earlier item is skipped for a missing id", () => {
	const skipped = [
		"ledger:",
		"  branch: alpha",
		"  features:",
		"    - id: ''",
		"      status: todo",
		"      short_goal: No id.",
		"    - id: first",
		"      status: todo",
		"      short_goal: First item with the id.",
		"    - id: first",
		"      status: todo",
		"      short_goal: Second item with the same id.",
	].join("\n");
	const { problems, indexes } = parseLedger(skipped);
	// The item with no id is not in the parsed list, so the two items with the id are parsed at
	// index 0 and 1, and their file positions are 1 and 2.
	assert.deepEqual(indexes, [1, 2]);
	assert.deepEqual(problems, ["features[0]: missing id"]);
	assert.deepEqual(checkLedger(skipped), [
		"features[0]: missing id",
		"features[2] (first): duplicate id",
	]);
});

test("a duplicate id names the file position when an item is skipped", () => {
	const skipped = [
		"ledger:",
		"  branch: alpha",
		"  features:",
		"    - \"not an item\"",
		"    - id: first",
		"      status: todo",
		"      short_goal: First item.",
		"    - id: first",
		"      status: todo",
		"      short_goal: Second item with the same id.",
	].join("\n");
	const { indexes } = parseLedger(skipped);
	// The skipped item is not in the parsed list, so parsed index 1 and 2 name file positions 1 and 2.
	assert.deepEqual(indexes, [1, 2]);
	assert.deepEqual(checkLedger(skipped), [
		"features[0] is not an item",
		"features[2] (first): duplicate id",
	]);
});
