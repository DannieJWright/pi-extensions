import { test } from "node:test";
import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { badValueProblem, checkLedger, ensureParent, isAddableEntry, isAddableStatus, isInside, listItems, missingInputWarning, missingPlanProblem, missingWorkspaceProblem, nextItem, outsideRepoProblem, parseLedger, parsePorcelain, planReference, problemTarget, prefixFromRoot, resolveLedgerPath, resolveRepoRoot, resolveWorkspace, serializeLedger, startItem, submitItem, addablePaths } from "./ledger.ts";
import { effectiveReviewConfig, type Finding } from "./ledger.ts";
import featureLedger from "./index.ts";
import { createFakeApi, createFakeContext, exec, setupRepo } from "./test-harness.ts";

// Never let an inherited ledger path redirect fixture tests into a real ledger.
delete process.env.PI_LEDGER_PATH;

// The harness provides exec and setupRepo. The ledger lives under plan/, which the
// repo gitignores; setupRepo mirrors that here.

// The write steps take the resolved context, so the tests build it the same way the tool does: the
// parsed ledger is read once and passed in.
const itemOpts = (cwd: string, ledgerPath: string, id: string, extra: Record<string, unknown> = {}) => ({
	cwd, ledgerPath, ledger: parseLedger(readFileSync(ledgerPath, "utf8")).ledger!, workspace: cwd, repoRoot: cwd, branch: "", id, exec, ...extra,
});

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

test("review configuration defaults off and resolves feature, ledger, default, and unlimited limits", () => {
	const ledger = parseLedger(FIXTURE.replace("{BRANCH}", "feature-x")).ledger!;
	const item = ledger.features[0];
	assert.deepEqual(effectiveReviewConfig(ledger, item), { enabled: false, max_failed_reviews: 5 });
	ledger.max_failed_reviews = 3;
	assert.equal(effectiveReviewConfig(ledger, item).max_failed_reviews, 3);
	item.review = true;
	item.max_failed_reviews = 0;
	assert.deepEqual(effectiveReviewConfig(ledger, item), { enabled: true, max_failed_reviews: 0 });
	item.max_failed_reviews = 2;
	assert.equal(effectiveReviewConfig(ledger, item).max_failed_reviews, 2);
});

test("nested review findings, assignment, and numeric-looking commit hashes round-trip without loss", () => {
	const ledger = parseLedger(FIXTURE.replace("{BRANCH}", "feature-x")).ledger!;
	ledger.max_failed_reviews = 0;
	const item = ledger.features[0];
	item.status = "review";
	item.review = true;
	item.failed_reviews = 2;
	item.assignment = { id: "alpha-2-reviewer", role: "reviewer", agent_id: "agent 'A'", claim_token: "123" };
	const finding: Finding = { id: "finding-1", status: "open", severity: "nit", details: "Line 1\n\nLine 2: 'quoted' \\\n", rationale: "Keep  spaces and 'apostrophes'.", first_found_iteration: 1, required_checks: ["check: one, two", "true", "123"] };
	item.findings = [finding, { ...finding, id: "finding-2", status: "closed", severity: "major", required_checks: [] }];
	item.commits.submissions = ["1234567", "00ab123"];
	const text = serializeLedger(ledger);
	const parsed = parseLedger(text);
	assert.deepEqual(parsed.problems, [], text);
	assert.deepEqual(parsed.ledger, ledger, "review model must survive serialization exactly");
});

test("checker rejects invalid review configuration, finding fields, assignments, and state invariants", () => {
	for (const field of ["review: 'false'", "max_failed_reviews: -1", "max_failed_reviews: '5'", "max_failed_reviews: null", "failed_reviews: -1"]) {
		assert.notDeepEqual(checkLedger(itemLedger([`      ${field}`])), [], field);
	}
	assert.match(checkLedger(itemLedger([]).replace("  branch: feature-x", "  max_failed_reviews: -1\n  branch: feature-x")).join("\n"), /ledger.max_failed_reviews/);
	const text = itemLedger([
		"      review: true", "      failed_reviews: 1", "      assignment:",
		"        id: alpha-0-reviewer", "        role: reviewer", "        agent_id: ''", "        claim_token: ''",
		"      findings:", "        - id: duplicate", "          status: open", "          details: ''", "          rationale: ''",
		"          severity: critical", "          first_found_iteration: 2", "          required_checks: [ok, '']",
		"        - id: duplicate", "          status: closed", "          details: Detail", "          rationale: Reason",
		"          severity: minor", "          first_found_iteration: 0", "          required_checks: []",
	]).replace("status: todo", "status: done");
	const problems = checkLedger(text).join("\n");
	for (const needle of ["assignment.id", "assignment.agent_id", "assignment.claim_token", "assignment.role", "findings[0].details", "findings[0].rationale", "findings[0].severity", "findings[0].first_found_iteration", "findings[0].required_checks", "cannot be open", "findings[1].id"]) assert.ok(problems.includes(needle), `${needle}: ${problems}`);
	assert.match(checkLedger(itemLedger(["      review: false"]).replace("status: todo", "status: review")).join("\n"), /review requires review enabled/);
	assert.match(checkLedger(itemLedger(["      assignment: []"])).join("\n"), /assignment.*mapping/);
	assert.match(checkLedger(itemLedger(["      findings: invalid"])).join("\n"), /findings.*list/);
	assert.match(checkLedger(itemLedger([]).replace("      commits: {}", "      commits: {submissions: [123]}")).join("\n"), /commits.submissions/);
});

test("legacy writes reject invalid review data and leave the ledger unchanged", async () => {
	const fixture = FIXTURE.replace("      status: todo", "      status: todo\n      max_failed_reviews: '5'");
	const { dir, path, cleanup } = await setupRepo(fixture);
	try {
		const api = createFakeApi();
		featureLedger(api);
		const ctx = createFakeContext(dir);
		const before = await readFile(path, "utf8");
		for (const [name, params] of [["ledger_start", { id: "alpha" }], ["ledger_submit", { id: "alpha", commit_message: "x", summary: "x" }]] as const) {
			const result = await api.tools[name].execute(null, params, null, null, ctx);
			assert.ok(result.isError, name);
			assert.match(result.content[0].text, /max_failed_reviews.*nonnegative integer/);
			assert.equal(await readFile(path, "utf8"), before);
		}
		const checked = await api.tools.ledger_check.execute(null, {}, null, null, ctx);
		assert.ok(checked.isError);
		assert.match(checked.content[0].text, /max_failed_reviews/);
	} finally { await cleanup(); }
});

test("legacy start refuses review-enabled work rather than silently bypassing review", async () => {
	const { dir, path, cleanup } = await setupRepo(FIXTURE.replace("      status: todo", "      status: todo\n      review: true"));
	try {
		const before = await readFile(path, "utf8");
		await assert.rejects(startItem(itemOpts(dir, path, "alpha")), /legacy ledger_start cannot manage review/);
		assert.equal(await readFile(path, "utf8"), before);
	} finally { await cleanup(); }
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

test("a null commit value is dropped, so the round-trip stays value-clean", () => {
	// An empty commit value parses to null. serializeLedger writes nothing for null or undefined, so a
	// value parse kept would never come back: the same item serialised and parsed again must give the
	// same object. listItems still reports an unset commit as null, so the read view is unchanged.
	const parsed = parseLedger("ledger:\n  branch: alpha\n  features:\n    - id: alpha\n      status: in-progress\n      short_goal: Do the thing.\n      commits:\n        start:\n        end: 6be88a3\n");
	assert.deepEqual(parsed.problems, []);
	assert.equal(parsed.ledger!.features[0].commits.start, undefined);
	// The written file keeps no empty commit key, and reading it back gives the same object.
	assert.ok(!serializeLedger(parsed.ledger!).includes("start:"), serializeLedger(parsed.ledger!));
	assert.deepEqual(parseLedger(serializeLedger(parsed.ledger!)).ledger!, parsed.ledger!);
	assert.deepEqual(listItems(parsed.ledger!).items[0].commits, { start: null, end: "6be88a3" });
});

test("start marks the item in-progress and records the start commit", async () => {
	const { dir, path, cleanup } = await setupRepo(FIXTURE);
	try {
		const result = await startItem(itemOpts(dir, path, "alpha"));
		assert.equal(result.item.status, "in-progress");
		assert.match(result.item.commits.start!, /^[0-9a-f]{7,}$/);
		assert.deepEqual(result.brief.acceptance_criteria, ["The thing is done."]);
		assert.deepEqual(result.brief.tests, ["tests/a.test.ts"]);
		assert.deepEqual(result.brief.validation_scripts, ["echo base-ok"]);
		const reread = parseLedger(await readFile(path, "utf8")).ledger!;
		assert.equal(reread.features[0].status, "in-progress");
		assert.equal(reread.features[0].commits.start, result.item.commits.start);
		const second = await startItem(itemOpts(dir, path, "alpha")).catch((error) => error as Error);
		assert.match(second.message, /already in-progress/);
	} finally { await cleanup(); }
});

test("a failed validation rejects the submit and writes the full log", async () => {
	const fixture = FIXTURE.replace("echo base-ok", "sh -c 'echo failing-line >&2; exit 1'");
	const { dir, path, cleanup } = await setupRepo(fixture);
	try {
		await startItem(itemOpts(dir, path, "alpha"));
		await writeFile(join(dir, "src.txt"), "work\n");
		const headBefore = (await exec("git", ["rev-parse", "HEAD"], dir)).stdout.trim();
		const result = await submitItem(itemOpts(dir, path, "alpha", { commitMessage: "feat: alpha", summary: "Done.", limitations: [], logDir: dir, }));
		assert.ok(result.rejected);
		assert.match(result.script, /exit 1/);
		assert.equal(result.exit, 1);
		assert.match(result.lastOutput, /failing-line/);
		assert.match(await readFile(result.logPath, "utf8"), /failing-line/);
		// Nothing was written to the ledger and nothing was committed.
		const reread = parseLedger(await readFile(path, "utf8")).ledger!;
		assert.equal(reread.features[0].status, "in-progress");
		assert.equal((await exec("git", ["rev-parse", "HEAD"], dir)).stdout.trim(), headBefore);
	} finally { await cleanup(); }
});

test("a passing validation commits and closes the item", async () => {
	const { dir, path, cleanup } = await setupRepo(FIXTURE);
	try {
		const started = await startItem(itemOpts(dir, path, "alpha"));
		await ensureParent(join(dir, "src/a.ts"));
		await writeFile(join(dir, "src/a.ts"), "changed\n");
		const result = await submitItem(itemOpts(dir, path, "alpha", { commitMessage: "feat: alpha", summary: "Did the thing. Pair check passed (artifacts/alpha/1/after.png).", limitations: ["No focus ring."], logDir: dir }));
		assert.ok(!result.rejected);
		const reread = parseLedger(await readFile(path, "utf8")).ledger!;
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
	const { dir, path, cleanup } = await setupRepo(FIXTURE);
	try {
		const error = await submitItem(itemOpts(dir, path, "alpha", { commitMessage: "x", summary: "y", limitations: [], logDir: dir })).catch((error) => error as Error);
		assert.match(error.message, /submit requires in-progress/);
	} finally { await cleanup(); }
});

test("submit refuses a clean tree and a moved HEAD", async () => {
	const { dir, path, cleanup } = await setupRepo(FIXTURE);
	try {
		await startItem(itemOpts(dir, path, "alpha"));
		const clean = await submitItem(itemOpts(dir, path, "alpha", { commitMessage: "x", summary: "y", limitations: [], logDir: dir })).catch((error) => error as Error);
		assert.match(clean.message, /no changes/);
		await writeFile(join(dir, "work.txt"), "work\n");
		await exec("git", ["add", "-A"], dir);
		await exec("git", ["commit", "-q", "-m", "extra commit during the work"], dir);
		const moved = await submitItem(itemOpts(dir, path, "alpha", { commitMessage: "x", summary: "y", limitations: [], logDir: dir })).catch((error) => error as Error);
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
	// A removal or a rename is recorded by git, so those entries are addable without a path on disk.
	assert.ok(isAddableStatus(" D"));
	assert.ok(isAddableStatus("D "));
	assert.ok(isAddableStatus("R "));
	assert.ok(!isAddableStatus("??"));
	assert.ok(!isAddableStatus(" M"));
	// A conflict code is addable too: git add on an unmerged path records the working-tree version,
	// which resolves the conflict.
	assert.ok(isAddableStatus("DU"));
	assert.ok(isAddableStatus("UD"));
	assert.ok(isAddableStatus("DD"));
});

test("the pathspec is built from the addable entries only", async () => {
	const kinds: Record<string, string> = {
		".pi-dotfile": "character device",
		"src/a.ts": "file",
		"docs/link.md": "symlink",
		"artifacts": "directory",
		"src/renamed.ts": "file",
	};
	const fakeStat = async (path: string) => {
		const kind = kinds[path.slice("/repo/".length)];
		return {
			isFile: () => kind === "file",
			isSymbolicLink: () => kind === "symlink",
			isDirectory: () => kind === "directory",
		};
	};
	// A D entry has no path on disk, so it is kept by its status letter. A rename is two records with
	// no arrow: the destination first, then the source. The destination is the path that exists.
	const porcelain = ["?? .pi-dotfile", "?? src/a.ts", "?? docs/link.md", "?? artifacts", " D deleted.txt", "R  src/renamed.ts", "src/old.ts"].join("\0");
	assert.deepEqual(await addablePaths(porcelain, "/repo", fakeStat), ["src/a.ts", "docs/link.md", "artifacts", "deleted.txt", "src/renamed.ts"]);
});

test("a path with a space is kept through the -z parse", async () => {
	// With -z the records are NUL-separated and the paths are not quoted.
	const porcelain = ["?? notes with a space.md", " D old name.txt"].join("\0");
	assert.deepEqual(parsePorcelain(porcelain), [
		{ status: "??", path: "notes with a space.md" },
		{ status: " D", path: "old name.txt" },
	]);
	const fakeStat = async () => ({ isFile: () => true, isSymbolicLink: () => false, isDirectory: () => false });
	assert.deepEqual(await addablePaths(porcelain, "/repo", fakeStat), ["notes with a space.md", "old name.txt"]);
});

test("a rename is read as two records: the destination, then the source", () => {
	// With -z the arrow is gone and the order is reversed, so the source record must not be read as a
	// record of its own.
	assert.deepEqual(parsePorcelain(["R  src/renamed.ts", "src/old.ts"].join("\0")), [
		{ status: "R ", path: "src/renamed.ts" },
	]);
	// A short source path is consumed too, so no garbage entry reaches the caller.
	assert.deepEqual(parsePorcelain(["R  src/renamed.ts", "old"].join("\0")), [
		{ status: "R ", path: "src/renamed.ts" },
	]);
	// A copy has the same shape.
	assert.deepEqual(parsePorcelain(["C  docs/new.md", "docs/old.md", "?? notes.md"].join("\0")), [
		{ status: "C ", path: "docs/new.md" },
		{ status: "??", path: "notes.md" },
	]);
});

test("a device entry is skipped and a deletion next to it is staged", async () => {
	const { dir, path, cleanup } = await setupRepo(FIXTURE);
	// The sandbox view shows a project-root dotfile as a character device, which git add cannot
	// take. The stat is injected because the sandbox cannot create a device.
	const fakeStat = async (path: string) => ({
		isFile: () => path.endsWith("src/a.ts"),
		isSymbolicLink: () => false,
		isDirectory: () => false,
	});
	try {
		await startItem(itemOpts(dir, path, "alpha"));
		await ensureParent(join(dir, "src/a.ts"));
		await writeFile(join(dir, "src/a.ts"), "changed\n");
		// A tracked file removed in the working tree has no inode, so it is kept by its status letter.
		await rm(join(dir, "README.md"));
		const status = ["?? .pi-dotfile", " D README.md", "?? src/a.ts"].join("\0");
		const addArgs: string[][] = [];
		const recordingExec = async (command: string, args: string[], cwd: string) => {
			if (command === "git" && args[0] === "status") return { code: 0, stdout: status, stderr: "" };
			if (command === "git" && args[0] === "add") addArgs.push(args);
			return exec(command, args, cwd);
		};
		const result = await submitItem(itemOpts(dir, path, "alpha", { commitMessage: "feat: alpha", summary: "Did the thing.", limitations: [], exec: recordingExec, logDir: dir, stat: fakeStat, }));
		assert.ok(!result.rejected);
		assert.deepEqual(addArgs[0], ["add", "-A", "--", "README.md", "src/a.ts"]);
		// files.out still comes from the commit diff, so the skipped device is not in it.
		assert.deepEqual(result.filesOut, ["README.md", "src/a.ts"]);
	} finally {
		await cleanup();
	}
});

test("a tree with only a device entry reports no changes", async () => {
	const { dir, path, cleanup } = await setupRepo(FIXTURE);
	const fakeStat = async () => ({ isFile: () => false, isSymbolicLink: () => false, isDirectory: () => false });
	try {
		await startItem(itemOpts(dir, path, "alpha"));
		const noiseOnly = async (command: string, args: string[], cwd: string) => {
			if (command === "git" && args[0] === "status") return { code: 0, stdout: "?? .pi-dotfile", stderr: "" };
			return exec(command, args, cwd);
		};
		const error = await submitItem(itemOpts(dir, path, "alpha", { commitMessage: "x", summary: "y", limitations: [], exec: noiseOnly, logDir: dir, stat: fakeStat, })).catch((error) => error as Error);
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
			{ id: "first", status: "todo", short_goal: "First item.", workspace: ".", commits: { start: null, end: null } },
			{ id: "second", status: "in-progress", short_goal: "Second item.", workspace: ".", commits: { start: "6be88a3", end: null } },
			{ id: "third", status: "done", short_goal: "Third item.", workspace: ".", commits: { start: "1111111", end: "2222222" } },
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
	assert.deepEqual(nextItem(ledger!), { next: { id: "third", status: "in-progress", short_goal: "Third item.", workspace: "." }, status: "in-progress" });
});

test("nextItem reports in-progress for a mixed ledger (some done, some todo)", () => {
	const { ledger } = parseLedger("ledger:\n  branch: alpha\n  features:\n    - id: first\n      status: done\n      short_goal: First item.\n    - id: second\n      status: todo\n      short_goal: Second item.\n");
	assert.deepEqual(nextItem(ledger!), { next: { id: "second", status: "todo", short_goal: "Second item.", workspace: "." }, status: "in-progress" });
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
	assert.deepEqual(nextItem(ledger!), { next: { id: "first", status: "todo", short_goal: "First item.", workspace: "." }, status: "todo" });
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
	const { dir, branch, path, cleanup } = await setupRepo(FIXTURE);
	try {
		const api = createFakeApi();
		featureLedger(api);
		assert.ok(Object.keys(api.tools).sort().join(",") === "ledger_check,ledger_list,ledger_next,ledger_start,ledger_submit");

		const ctx = createFakeContext(dir);
		const list = await api.tools.ledger_list.execute(null, {}, null, null, ctx);
		assert.ok(!list.isError);
		const result = JSON.parse(list.content[0].text);
		assert.equal(result.branch, branch);
		assert.deepEqual(result.items, [{ id: "alpha", status: "todo", short_goal: "Do the thing.", workspace: ".", commits: { start: null, end: null } }]);

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
		// An empty string counts as missing, not as a value.
		const empty = await api.tools.ledger_submit.execute(null, { id: "", commit_message: "x", summary: "y", limitations: [] }, null, null, createFakeContext(dir));
		assert.ok(empty.isError);
		assert.equal(empty.content[0].text, "ledger_submit: id: missing");
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

test("the default target is plan/ledger.yaml in the session root", async () => {
	const dir = await mkdtemp(join(tmpdir(), "feature-ledger-"));
	try {
		await exec("git", ["-c", "init.defaultBranch=feature-x", "init", "-q"], dir);
		// The ledger file must exist for the check to read it. Nothing here depends on the branch name.
		await ensureParent(join(dir, "plan", "ledger.yaml"));
		await writeFile(join(dir, "plan", "ledger.yaml"), "ledger:\n  branch: feature-x\n  features: []\n");
		const api = createFakeApi();
		featureLedger(api);
		const result = JSON.parse((await api.tools.ledger_check.execute(null, {}, null, null, createFakeContext(dir))).content[0].text);
		assert.equal(result.path, join(dir, "plan", "ledger.yaml"));
		assert.ok(result.ok);
		// A path outside a git repository is checked as a file: no location line, no git-backed check.
		const outside = JSON.parse((await api.tools.ledger_check.execute(null, { path: join(dir, "plan", "ledger.yaml") }, null, null, createFakeContext(dir))).content[0].text);
		assert.deepEqual(outside.problems, []);
	} finally { await rm(dir, { recursive: true }); }
});

test("a detached HEAD does not change the resolved path", async () => {
	const { dir, path, cleanup } = await setupRepo(FIXTURE);
	try {
		await execFile("git", ["checkout", "--detach", "-q"], { cwd: dir });
		// The check reads files.in entries, so the fixture's entry must exist.
		await ensureParent(join(dir, "src/a.ts"));
		await writeFile(join(dir, "src/a.ts"), "x\n");
		// Nothing builds a path from a branch anymore, so the default target is the same file.
		const api = createFakeApi();
		featureLedger(api);
		const result = JSON.parse((await api.tools.ledger_check.execute(null, {}, null, null, createFakeContext(dir))).content[0].text);
		assert.equal(result.path, path);
		assert.ok(result.ok);
	} finally { await cleanup(); }
});

test("resolveLedgerPath takes the first non-empty source in precedence order", () => {
	const all = { explicit: "plan/a.yaml", env: "plan/b.yaml", pointer: "plan/c.yaml", default: "plan/ledger.yaml" };
	assert.equal(resolveLedgerPath("/repo", all), "/repo/plan/a.yaml");
	assert.equal(resolveLedgerPath("/repo", { ...all, explicit: "" }), "/repo/plan/b.yaml");
	assert.equal(resolveLedgerPath("/repo", { ...all, explicit: undefined, env: "" }), "/repo/plan/c.yaml");
	assert.equal(resolveLedgerPath("/repo", { ...all, explicit: undefined, env: undefined, pointer: "" }), "/repo/plan/ledger.yaml");
	// Relative values resolve against the session root; absolute values are used as given.
	assert.equal(resolveLedgerPath("/repo/work", { explicit: "draft/ledger.yaml", default: "plan/ledger.yaml" }), "/repo/work/draft/ledger.yaml");
	assert.equal(resolveLedgerPath("/repo/work", { explicit: "/tmp/draft.yaml", default: "plan/ledger.yaml" }), "/tmp/draft.yaml");
	// The default is required. With every source empty there is no file to read, so the call throws
	// instead of handing back the session root, which is a directory.
	assert.throws(() => resolveLedgerPath("/repo/work", { default: "" }), /every source is empty/);
	// No extension check anywhere: .yml and .yaml both resolve.
	assert.equal(resolveLedgerPath("/repo", { explicit: "plan/iter.yml", default: "plan/ledger.yaml" }), "/repo/plan/iter.yml");
	assert.equal(resolveLedgerPath("/repo", { default: "plan/ledger.yml" }), "/repo/plan/ledger.yml");
});

test("resolveWorkspace takes the item value, then the ledger default, then the session root", () => {
	const parsed = parseLedger([
		"ledger:",
		"  branch: feature-x",
		"  features:",
		"    - id: alpha",
		"      status: todo",
		"      goal: Do the thing.",
		"      short_goal: Do the thing.",
		"      workspace: sub-repo-1",
		"      acceptance_criteria: [],",
		"      constraints: [],",
		"      files: { in: [], out: [] }",
		"      tests: [],",
		"      limitations: [],",
		"      summary: ''",
		"      commits: {}",
		].join("\n"));
	assert.deepEqual(parsed.problems, []);
	const item = parsed.ledger!.features[0];
	assert.equal(item.workspace, "sub-repo-1");
	assert.equal(resolveWorkspace("/repo", item, "."), "/repo/sub-repo-1");
	// The item wins over the ledger-level workspace.
	assert.equal(resolveWorkspace("/repo", item, "sub-repo-2"), "/repo/sub-repo-1");
	// An item without the field falls back to the ledger default, then to the session root.
	const plain = parseLedger(FIXTURE.replace("{BRANCH}", "feature-x")).ledger!.features[0];
	assert.equal(plain.workspace, undefined);
	assert.equal(resolveWorkspace("/repo", plain, ""), "/repo");
	assert.equal(resolveWorkspace("/repo", plain, "sub-repo-2"), "/repo/sub-repo-2");
	// An absolute workspace is used as given.
	assert.equal(resolveWorkspace("/repo", { ...plain, workspace: "/work/other" }, "."), "/work/other");
});

test("a per-item workspace and branch parse and round-trip", () => {
	const text = [
		"ledger:",
		"  branch: feature-x",
		"  features:",
		"    - id: alpha",
		"      status: todo",
		"      goal: Do the thing.",
		"      short_goal: Do the thing.",
		"      workspace: sub-repo-1",
		"      branch: feature-x",
		"      acceptance_criteria: [],",
		"      constraints: [],",
		"      files: { in: [], out: [] }",
		"      tests: [],",
		"      limitations: [],",
		"      summary: ''",
		"      commits: {}",
		].join("\n");
	const parsed = parseLedger(text);
	assert.deepEqual(parsed.problems, []);
	assert.equal(parsed.ledger!.features[0].workspace, "sub-repo-1");
	assert.equal(parsed.ledger!.features[0].branch, "feature-x");
	assert.deepEqual(parseLedger(serializeLedger(parsed.ledger!)).ledger, parsed.ledger);
	// A ledger without them is unchanged: the fields stay absent and are not written out.
	const plain = parseLedger(FIXTURE.replace("{BRANCH}", "feature-x"));
	assert.equal(plain.ledger!.features[0].workspace, undefined);
	assert.equal(plain.ledger!.features[0].branch, undefined);
	assert.ok(!serializeLedger(plain.ledger!).includes("      workspace:"));
});

test("resolveRepoRoot reads the repository from the workspace, and gives nothing outside one", async () => {
	const { dir, cleanup } = await setupRepo(FIXTURE);
	try {
		// A workspace inside the repository resolves to the repository root.
		const workspace = join(dir, "sub-repo-1");
		await mkdir(workspace);
		await writeFile(join(workspace, ".keep"), "x");
		assert.equal(await resolveRepoRoot(workspace, exec), dir);
		// Outside a git repository the result is empty, so the caller reports the workspace.
		const draft = await mkdtemp(join(tmpdir(), "feature-ledger-norepo-"));
		try {
			assert.equal(await resolveRepoRoot(draft, exec), "");
		} finally { await rm(draft, { recursive: true }); }
	} finally { await cleanup(); }
});

test("the tool resolves the path from the argument, then the environment, then the pointer, then the default", async () => {
	const { dir, path, cleanup } = await setupRepo(FIXTURE);
	const api = createFakeApi();
	featureLedger(api);
	const ctx = createFakeContext(dir);
	const call = async (params: Record<string, unknown>) => JSON.parse((await api.tools.ledger_check.execute(null, params, null, null, ctx)).content[0].text);
	try {
		// The check reads files.in entries, so the fixture's entry must exist.
		await ensureParent(join(dir, "src/a.ts"));
		await writeFile(join(dir, "src/a.ts"), "x\n");
		const base = await call({});
		assert.equal(base.path, path);
		assert.ok(base.ok);

		await writeFile(join(dir, "plan", "from-env.yaml"), await readFile(path, "utf8"));
		process.env.PI_LEDGER_PATH = join(dir, "plan", "from-env.yaml");
		try {
			assert.equal((await call({})).path, join(dir, "plan", "from-env.yaml"));
			// An explicit argument beats the environment.
			assert.equal((await call({ path: "plan/from-env.yaml" })).path, join(dir, "plan", "from-env.yaml"));
		} finally { delete process.env.PI_LEDGER_PATH; }

		// The pointer file is read at call time, so writing it changes the next call.
		await writeFile(join(dir, "plan", "from-pointer.yml"), await readFile(path, "utf8"));
		await writeFile(join(dir, "plan", "ledger.path"), "plan/from-pointer.yml\n");
		assert.equal((await call({})).path, join(dir, "plan", "from-pointer.yml"));
		assert.ok((await call({})).ok);
		// A missing or unreadable pointer contributes nothing: replace the pointer file with a
		// directory, so the read fails and the default applies.
		await rm(join(dir, "plan", "ledger.path"));
		await mkdir(join(dir, "plan", "ledger.path"));
		assert.equal((await call({})).path, path);
	} finally {
		delete process.env.PI_LEDGER_PATH;
		await cleanup();
	}
});

test("every tool takes an optional path and uses it when given", async () => {
	const { dir, path, cleanup } = await setupRepo(FIXTURE);
	const api = createFakeApi();
	featureLedger(api);
	const names = ["ledger_check", "ledger_list", "ledger_next", "ledger_start", "ledger_submit"];
	try {
		for (const name of names) {
			const schema = api.tools[name].parameters as { properties: Record<string, unknown>; required: string[] };
			assert.ok(schema.properties.path, `${name}: no path parameter`);
			assert.ok(!schema.required.includes("path"), `${name}: path is required`);
			assert.match(api.tools[name].description, /PI_LEDGER_PATH, then plan\/ledger\.path in the session root, then plan\/ledger\.yaml/, `${name}: the description does not state the resolution order`);
		}

		// A free-form path under plan/ with any extension: no path problem, no iteration naming.
		const other = join(dir, "plan", "scratch", "draft.yml");
		await ensureParent(other);
		await writeFile(other, FIXTURE.replace("{BRANCH}", "feature-x"));
		// The check reads files.in entries, so the fixture's entry must exist.
		await ensureParent(join(dir, "src/a.ts"));
		await writeFile(join(dir, "src/a.ts"), "x\n");
		const ctx = createFakeContext(dir);
		const call = async (name: string, params: Record<string, unknown>) => (await api.tools[name].execute(null, params, null, null, ctx)).content[0].text;

		const checked = JSON.parse(await call("ledger_check", { path: other }));
		assert.equal(checked.path, other);
		assert.ok(checked.ok);
		assert.equal(JSON.parse(await call("ledger_list", { path: other })).items[0].id, "alpha");
		assert.equal(JSON.parse(await call("ledger_next", { path: other })).next.id, "alpha");

		await call("ledger_start", { id: "alpha", path: other });
		assert.match(await readFile(other, "utf8"), /status: in-progress/);
		// The default file is untouched: only the file named by the argument changed.
		assert.match(await readFile(path, "utf8"), /status: todo/);

		// A submit through the argument writes the item in that file.
		await writeFile(join(dir, "tracked.txt"), "x\n");
		const submitted = await api.tools.ledger_submit.execute(null, { id: "alpha", commit_message: "test: submit through a path argument", summary: "Recorded the path argument.", path: other }, null, null, ctx);
		assert.ok(!submitted.isError, submitted.content[0].text);
		assert.match(submitted.content[0].text, /is done \(commit [0-9a-f]{7}\)/);
		assert.match(await readFile(other, "utf8"), /status: done/);
		assert.match(await readFile(path, "utf8"), /status: todo/);
	} finally { await cleanup(); }
});

const GOAL_WITH_PLAN = FIXTURE.replace(
	"      goal: >\n        Do the thing.",
	"      goal: Option 9 of plan/2026-11-18_missing-plan.md. Do the thing.",
);

test("planReference reads the plan path out of a goal", () => {
	assert.equal(planReference("Option 4.a of plan/chat-ui/agent-improvement-ideas-1.md. Live search."), "plan/chat-ui/agent-improvement-ideas-1.md");
	assert.equal(planReference("Do the thing."), null);
});

test("the check lines share one wording", () => {
	assert.equal(missingPlanProblem(problemTarget(0, "alpha", "goal"), "plan/x.md"),
		"features[0] (alpha): goal names a plan file that does not exist (plan/x.md)");
	assert.equal(missingWorkspaceProblem(problemTarget(0, "alpha", "workspace"), "/session/sub-repo-1"),
		"features[0] (alpha): workspace does not exist (/session/sub-repo-1)");
	assert.equal(outsideRepoProblem(problemTarget(0, "alpha", "workspace"), "/session/sub-repo-1"),
		"features[0] (alpha): workspace is not inside a git repository (/session/sub-repo-1)");
	assert.equal(missingInputWarning(problemTarget(0, "alpha", "files.in"), "/session/sub-repo-1/notes.md"),
		"features[0] (alpha): files.in names a path that does not exist yet (/session/sub-repo-1/notes.md)");
	assert.equal(badValueProblem(problemTarget(0, "alpha", "workspace"), ["sub-repo-1"]),
		"features[0] (alpha): workspace must be a non-empty string, got [\"sub-repo-1\"]");
});

test("parseLedger reports a workspace or branch that is not a plain value", () => {
	// A typo such as workspace: [sub-repo-1] must not fall back to the session root in silence.
	assert.deepEqual(parseLedger(itemLedger(["      workspace: [sub-repo-1]"])).problems, [
		"features[0] (alpha): workspace must be a non-empty string, got [\"sub-repo-1\"]",
	]);
	assert.deepEqual(parseLedger(itemLedger(["      branch: \"\""])).problems, [
		"features[0] (alpha): branch must be a non-empty string, got \"\"",
	]);
	// A field that is not written stays quiet.
	assert.deepEqual(parseLedger(itemLedger([])).problems, []);
});

test("checkLedger stays free of the git and filesystem checks", () => {
	assert.deepEqual(checkLedger(GOAL_WITH_PLAN.replace("{BRANCH}", "feature-x")), []);
});

test("ledger_check reports a goal that names a plan file that does not exist", async () => {
	const { dir, path, cleanup } = await setupRepo(GOAL_WITH_PLAN);
	try {
		// The check reads files.in entries, so the fixture's entry must exist.
		await ensureParent(join(dir, "src/a.ts"));
		await writeFile(join(dir, "src/a.ts"), "x\n");
		const api = createFakeApi();
		featureLedger(api);
		const result = await api.tools.ledger_check.execute(null, {}, null, null, createFakeContext(dir));
		assert.ok(result.isError);
		assert.deepEqual(JSON.parse(result.content[0].text).problems, [
			"features[0] (alpha): goal names a plan file that does not exist (plan/2026-11-18_missing-plan.md)",
		]);
	} finally { await cleanup(); }
});

test("ledger_check reports a workspace that does not exist, and one that is not inside a git repository", async () => {
	// A session root that is not a repository, so the only repository is the item's own.
	const root = await mkdtemp(join(tmpdir(), "feature-ledger-ws-"));
	const api = createFakeApi();
	featureLedger(api);
	const ctx = createFakeContext(root);
	const call = async () => JSON.parse((await api.tools.ledger_check.execute(null, {}, null, null, ctx)).content[0].text);
	const ws = join(root, "sub-repo-1");
	try {
		await ensureParent(join(root, "plan", "ledger.yaml"));
		await writeFile(join(root, "plan", "ledger.yaml"), itemLedger(["      workspace: sub-repo-1"]));
		assert.deepEqual((await call()).problems, [`features[0] (alpha): workspace does not exist (${ws})`]);
		await mkdir(ws);
		assert.deepEqual((await call()).problems, [`features[0] (alpha): workspace is not inside a git repository (${ws})`]);
		// Inside a repository the check is quiet.
		await exec("git", ["init", "-q"], ws);
		assert.deepEqual((await call()).problems, []);
	} finally { await rm(root, { recursive: true }); }
});

test("ledger_check reports a files.in entry that does not exist as a warning, not a problem", async () => {
	const text = itemLedger([
		"      files:",
		"        in:",
		"          - sub-repo-1/notes.md",
		"        out: []",
		]).replace("      files: { in: [], out: [] }", "");
	const { dir, path, cleanup } = await setupRepo(text);
	const api = createFakeApi();
	featureLedger(api);
	const ctx = createFakeContext(dir);
	const call = async () => {
		const result = await api.tools.ledger_check.execute(null, {}, null, null, ctx);
		return { ...JSON.parse(result.content[0].text), isError: result.isError };
	};
	const line = (target: string) => `features[0] (alpha): files.in names a path that does not exist yet (${target})`;
	try {
		// A draft ledger may name a file an earlier step will create, so this is reported as a
		// warning: the check still passes, and isError is not set.
		const missing = await call();
		assert.deepEqual(missing.warnings, [line(join(dir, "sub-repo-1/notes.md"))]);
		assert.deepEqual(missing.problems, []);
		assert.ok(missing.ok);
		assert.ok(!missing.isError);
		// A problem still fails the check with a warning present, so the two lists stay separate.
		await writeFile(path, text.replace("      short_goal: Do the thing.", "      short_goal: \"\""));
		const mixed = await call();
		assert.deepEqual(mixed.problems, ["features[0] (alpha): missing short_goal"]);
		assert.deepEqual(mixed.warnings, [line(join(dir, "sub-repo-1/notes.md"))]);
		assert.ok(!mixed.ok);
		assert.ok(mixed.isError);
		// Once the file exists the warning is gone.
		await writeFile(path, text);
		await ensureParent(join(dir, "sub-repo-1/notes.md"));
		await writeFile(join(dir, "sub-repo-1/notes.md"), "note\n");
		const clean = await call();
		assert.deepEqual(clean.problems, []);
		assert.deepEqual(clean.warnings, []);
		assert.ok(clean.ok);
		// An absolute entry resolves as given, not under the session root.
		const elsewhere = await mkdtemp(join(tmpdir(), "feature-ledger-abs-"));
		try {
			await writeFile(join(elsewhere, "notes.md"), "note\n");
			const absolute = itemLedger(["      files:", "        in:", `          - ${join(elsewhere, "notes.md")}`, "        out: []"]).replace("      files: { in: [], out: [] }", "");
			await writeFile(path, absolute);
			const abs = await call();
			assert.deepEqual(abs.problems, []);
			assert.deepEqual(abs.warnings, []);
		} finally { await rm(elsewhere, { recursive: true }); }
	} finally { await cleanup(); }
});

test("a plan reference resolves against the session root, not the repository root", async () => {
	const text = itemLedger(["      goal: Option 1 of plan/named-plan.md. Do the thing."]).replace("      goal: Do the thing.", "");
	const { dir, path, cleanup } = await setupRepo(text);
	try {
		// The session root is a directory inside the repository, so the two roots differ.
		const session = join(dir, "sub");
		await ensureParent(join(session, "plan", "named-plan.md"));
		await writeFile(join(session, "plan", "named-plan.md"), "plan\n");
		const api = createFakeApi();
		featureLedger(api);
		// The same file, read from two roots: the plan reference follows the session root.
		const call = async (cwd: string) => JSON.parse((await api.tools.ledger_check.execute(null, { path }, null, null, createFakeContext(cwd))).content[0].text);
		assert.deepEqual((await call(session)).problems, []);
		// The same file is not found from the repository root, so a session root without it is reported.
		assert.deepEqual((await call(dir)).problems, ["features[0] (alpha): goal names a plan file that does not exist (plan/named-plan.md)"]);
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

// An item written by hand for the workspace tests. Fields go after short_goal, the order
// serializeLedger uses.
function itemLedger(fields: string[]): string {
	return [
		"ledger:",
		"  branch: feature-x",
		"  features:",
		"    - id: alpha",
		"      status: todo",
		"      goal: Do the thing.",
		"      short_goal: Do the thing.",
		...fields,
		"      acceptance_criteria: [],",
		"      constraints: [],",
		"      files: { in: [], out: [] }",
		"      tests: [],",
		"      limitations: [],",
		"      summary: ''",
		"      commits: {}",
	].join("\n");
}

const commitIn = (cwd: string, message: string) => exec("git", ["-c", "user.email=test@example.com", "-c", "user.name=Ledger Test", "commit", "-q", "-m", message], cwd);

async function initWorkspace(cwd: string): Promise<void> {
	for (const args of [["init", "-q"], ["config", "user.email", "ledger-test@localhost"], ["config", "user.name", "Ledger Test"]]) {
		const result = await exec("git", args, cwd);
		assert.equal(result.code, 0, result.stderr);
	}
}

test("isInside tells the item's own repository from the rest of the session", () => {
	const root = "/session/sub-repo-1";
	assert.ok(isInside(join(root, "notes.md"), root));
	assert.ok(isInside(root, root));
	// A path above the repository is outside it, so the change is reported, not committed.
	assert.ok(!isInside("/session/outside.txt", root));
	assert.ok(!isInside("/session/../outside.txt", root));
	// A name that only starts with two dots is inside.
	assert.ok(isInside(join(root, "..notes"), root));
	// An absolute path on another tree is not inside.
	assert.ok(!isInside("/other/sub-repo-1/x", root));
});

test("the read views report the workspace per item and echo a branch only when the file has it", () => {
	const withItem = parseLedger(itemLedger(["      workspace: sub-repo-1", "      branch: feature-x"])).ledger!;
	assert.equal(listItems(withItem).items[0].workspace, "sub-repo-1");
	assert.equal(nextItem(withItem).next!.workspace, "sub-repo-1");
	assert.equal(listItems(withItem).branch, "feature-x");
	// The ledger default is used when the item has no workspace; with no default either, the session root.
	const plain = parseLedger(itemLedger([])).ledger!;
	assert.equal(listItems(plain).items[0].workspace, ".");
	assert.equal(nextItem(plain).next!.workspace, ".");
	// A ledger with no branch field reports none: the branch is an author label, not a git read.
	const noBranch = parseLedger(itemLedger([]).replace("  branch: feature-x", "")).ledger!;
	assert.equal(listItems(noBranch).branch, undefined);
});

test("a per-item branch that does not match the repository is an error at ledger_start", async () => {
	const { dir, branch, cleanup } = await setupRepo(itemLedger(["      branch: other-branch"]));
	try {
		const api = createFakeApi();
		featureLedger(api);
		const result = await api.tools.ledger_start.execute(null, { id: "alpha" }, null, null, createFakeContext(dir));
		assert.ok(result.isError);
		assert.match(result.content[0].text, new RegExp(`item alpha says branch other-branch, but .* is on ${branch}`));
	} finally { await cleanup(); }
});

test("an item works in its own workspace: files.out reads from the session root and outside changes are a warning", async () => {
	const { dir, cleanup } = await setupRepo(itemLedger(["      workspace: sub-repo-1", "      validation_scripts:", "        - test -e ws-marker"]));
	try {
		const api = createFakeApi();
		featureLedger(api);
		const ctx = createFakeContext(dir);
		const ws = join(dir, "sub-repo-1");
		await mkdir(ws);
		await initWorkspace(ws);
		await writeFile(join(ws, "ws-marker"), "x\n");
		await writeFile(join(ws, "seed.txt"), "s\n");
		await exec("git", ["add", "-A"], ws);
		await commitIn(ws, "seed");

		const brief = await api.tools.ledger_start.execute(null, { id: "alpha" }, null, null, ctx);
		assert.ok(!brief.isError, brief.content[0].text);
		assert.match(brief.content[0].text, new RegExp(`Workspace: ${ws}`));

		await writeFile(join(ws, "notes.md"), "note\n");
		await writeFile(join(dir, "outside.txt"), "not committed\n");
		const result = await api.tools.ledger_submit.execute(null, { id: "alpha", commit_message: "test: work in the item workspace", summary: "Recorded the workspace." }, null, null, ctx);
		assert.ok(!result.isError, result.content[0].text);
		// The validation script only passes from the workspace, so its success shows where it ran.
		assert.match(result.content[0].text, /files\.out:\n- sub-repo-1\/notes\.md/);
		assert.match(result.content[0].text, /warning: changes outside .*sub-repo-1 are not committed:\n- outside\.txt/);
		const committed = await exec("git", ["ls-files"], ws);
		assert.ok(committed.stdout.includes("notes.md"));
		// Nothing outside the item's repository is committed.
		const outside = await exec("git", ["ls-files", "outside.txt"], dir);
		assert.equal(outside.stdout.trim(), "");
	} finally { await cleanup(); }
});

test("nothing is claimed about out-of-repo changes when the session root is not a git repository", async () => {
	const root = await mkdtemp(join(tmpdir(), "feature-ledger-session-"));
	const ws = join(root, "sub-repo-1");
	try {
		await mkdir(ws);
		await initWorkspace(ws);
		await writeFile(join(ws, "seed.txt"), "s\n");
		await exec("git", ["add", "-A"], ws);
		await commitIn(ws, "seed");
		const api = createFakeApi();
		featureLedger(api);
		const ctx = createFakeContext(root);
		await ensureParent(join(root, "plan", "ledger.yaml"));
		await writeFile(join(root, "plan", "ledger.yaml"), itemLedger(["      workspace: sub-repo-1"]));
		await api.tools.ledger_start.execute(null, { id: "alpha" }, null, null, ctx);
		await writeFile(join(root, "outside.txt"), "x\n");
		await writeFile(join(ws, "notes.md"), "note\n");
		const result = await api.tools.ledger_submit.execute(null, { id: "alpha", commit_message: "test: no claim outside a repository", summary: "Recorded nothing." }, null, null, ctx);
		assert.ok(!result.isError, result.content[0].text);
		assert.ok(!result.content[0].text.includes("warning"), result.content[0].text);
		assert.match(result.content[0].text, /files\.out:\n- sub-repo-1\/notes\.md/);
	} finally { await rm(root, { recursive: true }); }
});

test("the tool names the workspace when it is not inside a git repository", async () => {
	const root = await mkdtemp(join(tmpdir(), "feature-ledger-nowork-"));
	try {
		await mkdir(join(root, "sub-repo-1"));
		await ensureParent(join(root, "plan", "ledger.yaml"));
		await writeFile(join(root, "plan", "ledger.yaml"), itemLedger(["      workspace: sub-repo-1"]));
		const api = createFakeApi();
		featureLedger(api);
		const result = await api.tools.ledger_start.execute(null, { id: "alpha" }, null, null, createFakeContext(root));
		assert.ok(result.isError);
		assert.match(result.content[0].text, new RegExp(`no git repository at .*sub-repo-1`));
	} finally { await rm(root, { recursive: true }); }
});

test("the start brief names the commit the write path recorded", async () => {
	const { dir, path, cleanup } = await setupRepo(itemLedger([]));
	try {
		const api = createFakeApi();
		featureLedger(api);
		const result = await api.tools.ledger_start.execute(null, { id: "alpha" }, null, null, createFakeContext(dir));
		assert.ok(!result.isError, result.content[0].text);
		// The line must name the item startItem returned, not the one found before the write: the
		// earlier object has no commits.start, so the line would read (commit undefined).
		const recorded = parseLedger(await readFile(path, "utf8")).ledger!.features[0].commits.start;
		assert.ok(recorded, "the write path recorded no commit");
		assert.match(result.content[0].text, new RegExp(`is in-progress \\(commit ${recorded}\\)`));
		assert.ok(!result.content[0].text.includes("commit undefined"), result.content[0].text);
	} finally { await cleanup(); }
});

test("prefixFromRoot converts a repository-root path to the workspace before prefixing it", () => {
	// git prints paths relative to the repository root even from a subdirectory, so the conversion comes
	// first. A workspace that is a subdirectory of the session root must not be prefixed twice.
	assert.deepEqual(prefixFromRoot("/session", "/session/sub", "/session", ["sub/notes.md", "root.txt"]), ["sub/notes.md", "root.txt"]);
	// A workspace that is the session root needs no prefix, but the path is still converted when the
	// repository root is above it.
	assert.deepEqual(prefixFromRoot("/session/sub", "/session/sub", "/session", ["root.txt", "sub/notes.md"]), ["../root.txt", "notes.md"]);
	// A workspace above the session root cannot be expressed as a path from it, so entries are absolute.
	assert.deepEqual(prefixFromRoot("/session", "/work/other", "/work/other", ["file.ts"]), ["/work/other/file.ts"]);
});

test("files.out reads from the session root when the workspace is a subdirectory of its repository", async () => {
	const { dir, cleanup } = await setupRepo(itemLedger(["      workspace: sub"]));
	try {
		const api = createFakeApi();
		featureLedger(api);
		const ctx = createFakeContext(dir);
		await mkdir(join(dir, "sub"));
		await api.tools.ledger_start.execute(null, { id: "alpha" }, null, null, ctx);
		await writeFile(join(dir, "sub", "notes.md"), "note\n");
		await writeFile(join(dir, "root.txt"), "root\n");
		const result = await api.tools.ledger_submit.execute(null, { id: "alpha", commit_message: "test: paths read from the session root", summary: "Recorded the workspace." }, null, null, ctx);
		assert.ok(!result.isError, result.content[0].text);
		// The workspace entry is prefixed once, and a file at the repository root is not attributed to
		// the workspace.
		assert.match(result.content[0].text, /- sub\/notes\.md/);
		assert.match(result.content[0].text, /- root\.txt/);
	} finally { await cleanup(); }
});

test("the out-of-repo warning reads from the session root, not from the repository root", async () => {
	// The session root is a subdirectory of the repository setupRepo creates. The item works in a
	// separate repository, so a change at the repository root is outside the item.
	const { dir, branch, cleanup } = await setupRepo(itemLedger(["      workspace: ../item-repo"]));
	const ledger = itemLedger(["      workspace: ../item-repo"]).replace("{BRANCH}", branch);
	try {
		const session = join(dir, "session");
		const ws = join(dir, "item-repo");
		await mkdir(session);
		await mkdir(ws);
		await initWorkspace(ws);
		await writeFile(join(ws, "seed.txt"), "s\n");
		await exec("git", ["add", "-A"], ws);
		await commitIn(ws, "seed");
		const path = join(session, "plan", "ledger.yaml");
		await ensureParent(path);
		await writeFile(path, ledger);
		const api = createFakeApi();
		featureLedger(api);
		const ctx = createFakeContext(session);
		await api.tools.ledger_start.execute(null, { id: "alpha", path }, null, null, ctx);
		await writeFile(join(ws, "notes.md"), "note\n");
		await writeFile(join(dir, "root.txt"), "root\n");
		const result = await api.tools.ledger_submit.execute(null, { id: "alpha", path, commit_message: "test: the warning reads from the session root", summary: "Recorded the workspace." }, null, null, ctx);
		assert.ok(!result.isError, result.content[0].text);
		assert.match(result.content[0].text, /are not committed:\n- \.\./);
	} finally { await rm(dir, { recursive: true }); }
});
