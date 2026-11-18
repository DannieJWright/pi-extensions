import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureParent, ledgerPath, parseLedger, serializeLedger, startItem, submitItem, type Exec } from "./ledger.ts";

const run = promisify(execFile);

const exec: Exec = async (command, args, cwd) => {
	try {
		const { stdout, stderr } = await run(command, args, { cwd });
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
	}
};

async function setupRepo(ledgerText: string): Promise<{ dir: string; branch: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "feature-ledger-"));
	await exec("git", ["-c", "init.defaultBranch=feature-x", "init", "-q"], dir);
	await exec("git", ["config", "user.email", "test@example.com"], dir);
	await exec("git", ["config", "user.name", "Ledger Test"], dir);
	// The ledger lives under plan/, which the repo gitignores; mirror that here.
	await writeFile(join(dir, ".gitignore"), "plan/\n");
	const branch = (await exec("git", ["symbolic-ref", "--short", "HEAD"], dir)).stdout.trim();
	await writeFile(join(dir, "README.md"), "seed\n");
	await exec("git", ["add", "-A"], dir);
	await exec("git", ["commit", "-q", "-m", "seed"], dir);
	await ensureParent(ledgerPath(dir, branch));
	await writeFile(ledgerPath(dir, branch), ledgerText.replace("{BRANCH}", branch));
	return { dir, branch, cleanup: () => rm(dir, { recursive: true }) };
}

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
	const path = fileURLToPath(new URL("../../schema/ledger.yaml", import.meta.url));
	const { ledger, problems } = parseLedger(await readFile(path, "utf8"));
	assert.deepEqual(problems, []);
	assert.equal(ledger!.branch, "chat-ui");
	assert.deepEqual(ledger!.validation_scripts, ["just test all"]);
	assert.equal(ledger!.features.length, 2);
	const item = ledger!.features[0];
	assert.equal(item.id, "search-result-labels");
	assert.equal(item.status, "done");
	assert.match(item.goal, /Option 4\.a of plan\/chat-ui\/agent-improvement-ideas-1\.md/);
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
	const path = fileURLToPath(new URL("../../schema/ledger.yaml", import.meta.url));
	const first = parseLedger(await readFile(path, "utf8")).ledger!;
	const again = parseLedger(serializeLedger(first)).ledger!;
	assert.deepEqual(again, first);
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
