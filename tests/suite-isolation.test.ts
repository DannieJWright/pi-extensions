import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));

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

test("the entire suite ignores and never accesses personal Pi configuration", { timeout: 240_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "repository-isolation-"));
	try {
		const guard = join(dir, "guard.mjs");
		await writeFile(guard, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const forbidden = process.env.ISOLATION_GUARD_HOME + '/.pi';
const wrap = (object, name) => { const original = object[name]; object[name] = function(path, ...args) { const p = String(path); if (p === forbidden || p.startsWith(forbidden + '/')) throw new Error('personal Pi access: ' + p); return original.call(this, path, ...args); }; };
for (const name of ['existsSync', 'readFileSync', 'writeFileSync', 'statSync', 'lstatSync', 'accessSync', 'mkdirSync', 'openSync']) wrap(fs, name);
for (const name of ['readFile', 'writeFile', 'stat', 'lstat', 'access', 'mkdir', 'open']) wrap(fs.promises, name);
syncBuiltinESMExports();\n`);
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
			const env = { ...process.env, HOME: home, XDG_RUNTIME_DIR: runtime, PI_LEDGER_PATH: join(home, ".pi", "agent", "ledger.yaml"), ISOLATION_GUARD_HOME: home, NODE_OPTIONS: `--import=${guard}` };
			delete env.NODE_TEST_CONTEXT;
			const result = spawnSync("just", ["-f", join(repo, "justfile"), "test"], {
				cwd: repo, encoding: "utf8", timeout: 75_000, maxBuffer: 8 * 1024 * 1024,
				env,
			});
			assert.equal(result.status, 0, `${scenario}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
			assert.deepEqual(await snapshot(home), before, `${scenario}: personal files changed`);
			const current = result.stdout.slice(result.stdout.lastIndexOf("summary:"));
			assert.match(current, /perm check pass=1 fail=0/);
			assert.match(current, /provider-rules check pass=1 fail=0/);
			if (summary === undefined) summary = current;
			else assert.equal(current, summary, `${scenario}: group results changed`);
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});
