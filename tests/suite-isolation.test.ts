import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const repo = fileURLToPath(new URL("../", import.meta.url));
const guardSource = fileURLToPath(new URL("./suite-isolation-guard.mjs", import.meta.url));
const exec = promisify(execFile);

function guardEnv(home: string, log: string, guard: string): NodeJS.ProcessEnv {
	return { ...process.env, HOME: home, ISOLATION_GUARD_HOME: home, ISOLATION_GUARD_LOG: log, NODE_OPTIONS: `--import=${pathToFileURL(guard).href}` };
}

async function assertNoGuardViolations(log: string): Promise<void> {
	const violations = await readFile(log, "utf8");
	assert.equal(violations, "", `personal Pi access was attempted:\n${violations}`);
}

async function snapshot(dir: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	async function visit(path: string): Promise<void> {
		for (const entry of await readdir(path, { withFileTypes: true })) {
			const file = join(path, entry.name);
			if (entry.isDirectory()) await visit(file);
			else files[relative(dir, file)] = (await readFile(file)).toString("base64");
		}
	}
	await visit(dir);
	return files;
}

test("guard records swallowed forbidden accesses from parallel children even when its path contains spaces", async () => {
	const dir = await mkdtemp(join(tmpdir(), "guard with spaces "));
	try {
		const home = join(dir, "home");
		const guard = join(dir, "guard with spaces.mjs");
		const log = join(dir, "violations.log");
		await mkdir(join(home, ".pi"), { recursive: true });
		await writeFile(join(home, ".pi", "sentinel"), "fake personal data");
		await writeFile(log, "");
		await copyFile(guardSource, guard);
		const env = { ...guardEnv(home, log, guard), TMPDIR: dir };
		const code = `import fs from 'node:fs'; import { join } from 'node:path';
const file = join(process.env.HOME, '.pi', 'sentinel');
try { fs.readFileSync(file); } catch {}
try { await fs.promises.readFile(file); } catch {}`;
		await Promise.all([1, 2].map(() => exec(process.execPath, ["--input-type=module", "--eval", code], { env })));
		const violations = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
		assert.equal(violations.length, 4);
		assert.ok(violations.every(item => item.path === join(home, ".pi", "sentinel")));
		assert.equal(violations.filter(item => item.operation === "readFileSync").length, 2);
		assert.equal(violations.filter(item => item.operation === "readFile").length, 2);
		await assert.rejects(assertNoGuardViolations(log), /personal Pi access was attempted/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("the repository check and test groups ignore and never access personal Pi configuration", { timeout: 240_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "repository isolation "));
	try {
		const guard = join(dir, "guard.mjs");
		await copyFile(guardSource, guard);
		let summary: string | undefined;
		for (const scenario of ["absent", "malformed", "different"]) {
			const home = join(dir, scenario);
			await mkdir(home);
			if (scenario !== "absent") {
				const contents = scenario === "malformed" ? "not json {" : '{"different":true}';
				for (const name of ["agent/permission-mode/permission-mode.src.jsonc", "agent/permission-mode/permission-mode.json", "agent/permission-mode/.last-generated.json", "agent/provider-rules.jsonc", "agent/provider-prompt-rules.jsonc", "just-tools.jsonc", "agent/ledger.yaml"]) {
					const file = join(home, ".pi", name);
					await mkdir(dirname(file), { recursive: true });
					await writeFile(file, contents);
				}
			}
			const before = await snapshot(home);
			const runtime = join(dir, `runtime-${scenario}`);
			await mkdir(runtime);
			const log = join(dir, `${scenario}-violations.log`);
			await writeFile(log, "");
			const env = { ...guardEnv(home, log, guard), XDG_RUNTIME_DIR: runtime, PI_LEDGER_PATH: join(home, ".pi", "agent", "ledger.yaml") };
			delete env.NODE_TEST_CONTEXT;
			// Run every ordinary group without re-entering this suite-isolation test.
			const result = spawnSync("just", ["-f", join(repo, "justfile"), "test", "groups"], {
				cwd: repo, encoding: "utf8", timeout: 75_000, maxBuffer: 8 * 1024 * 1024,
				env,
			});
			await assertNoGuardViolations(log);
			assert.equal(result.status, 0, `${scenario}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
			assert.deepEqual(await snapshot(home), before, `${scenario}: personal files changed`);
			const current = result.stdout.slice(result.stdout.lastIndexOf("summary:"));
			assert.match(current, /perm check pass=1 fail=0/);
			assert.match(current, /provider-rules check pass=1 fail=0/);
			assert.match(current, /feature-ledger test pass=[1-9]\d* fail=0/);
			assert.doesNotMatch(current, /suite isolation/);
			assert.match(result.stdout, /ledger_orchestrate prioritizes review/);
			assert.match(result.stdout, /orchestration fixture wins over an inherited ledger path/);
			if (summary === undefined) summary = current;
			else assert.equal(current, summary, `${scenario}: group results changed`);
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});
