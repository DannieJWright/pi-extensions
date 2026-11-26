import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// A body line from `just --json` is a list of text parts, and an interpolated variable is itself a nested list.
function lineText(line: unknown): string {
	if (typeof line === "string") return line;
	return (line as unknown[]).map(lineText).join("");
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

test("the guard blocks accesses under the guarded home while allowing paths outside it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "guard scope "));
	try {
		const home = join(dir, "home");
		const otherHome = join(dir, "other-home");
		const log = join(dir, "violations.log");
		for (const d of [join(home, ".pi", "agent"), join(otherHome, ".pi", "agent")]) {
			await mkdir(d, { recursive: true });
			await writeFile(join(d, "settings.json"), "{}");
		}
		await writeFile(log, "");
		const base = { ...guardEnv(home, log, guardSource), TMPDIR: dir };
		const run = async (env: NodeJS.ProcessEnv, attempts: string[]) => (await exec(process.execPath, ["--input-type=module", "--eval", `import fs from 'node:fs';\n${attempts.join("\n")}`], { env })).stdout.trim().split("\n").map(line => JSON.parse(line));
		const attempt = (operation: string, target: string, ...rest: unknown[]) => `{ const outcome = { path: ${JSON.stringify(target)} }; try { fs.${operation}(${[JSON.stringify(target), ...rest.map(value => JSON.stringify(value))].join(", ")}); outcome.allowed = true; } catch (error) { outcome.message = error.message; } console.log(JSON.stringify(outcome)); }`;
		const inside = join(home, ".pi", "agent", "settings.json");
		const outside = join(dir, "outside.txt");
		const elsewhere = join(otherHome, ".pi", "agent", "settings.json");

		assert.deepEqual(await run(base, [attempt("readFileSync", inside)]), [{ path: inside, message: `personal Pi access: ${inside}` }]);
		assert.deepEqual(await run(base, [attempt("writeFileSync", outside, "ok")]), [{ path: outside, allowed: true }]);
		assert.equal(await readFile(outside, "utf8"), "ok");

		// The guarded root is resolved at import time, so changing HOME does not move it.
		const moved = { ...base, HOME: otherHome };
		assert.deepEqual(await run(moved, [attempt("readFileSync", inside), attempt("readFileSync", elsewhere)]), [
			{ path: inside, message: `personal Pi access: ${inside}` },
			{ path: elsewhere, allowed: true },
		]);

		const violations = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
		assert.deepEqual(violations, [
			{ operation: "readFileSync", path: inside },
			{ operation: "readFileSync", path: inside },
		]);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("the test recipe installs the isolation guard for every group without running anything", async () => {
	const json = JSON.parse((await exec("just", ["--justfile", join(repo, "justfile"), "--json"])).stdout);
	const recipe = json.recipes["test"];
	assert.deepEqual(recipe.parameters, [], "the test recipe takes no arguments");
	const lines = recipe.body.map(lineText);
	const exported = new Map<string, string>();
	for (const line of lines) {
		const match = /^export ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
		if (match) exported.set(match[1], match[2]);
	}
	assert.ok(exported.has("ISOLATION_GUARD_HOME"));
	assert.ok(exported.has("ISOLATION_GUARD_LOG"));
	assert.match(exported.get("NODE_OPTIONS")!, /\$\{guard_href\}/);
	assert.ok(lines.some(line => line.startsWith("guard_href=") && line.includes("tests/suite-isolation-guard.mjs")));

	const groups = lines.filter(line => line.startsWith('run_group "'));
	assert.ok(groups.length > 0, "the test recipe has no groups to install the guard for");
	for (const group of groups) {
		assert.doesNotMatch(group.replace(/^run_group "[^"]*" /, ""), /^just(?: -f "[^"]*")* test(?=\s|$)/, group);
	}
});

test("the cwd-guard group exists and its test arm lists explicit unit files, never the probe", async () => {
	const json = JSON.parse((await exec("just", ["--justfile", join(repo, "justfile"), "--json"])).stdout);
	const recipe = json.recipes["cwd-guard"];
	assert.ok(recipe, "the cwd-guard recipe is missing");
	assert.equal(recipe.attributes.some((attribute: any) => attribute.group === "test"), true);
	const arm = cwdGuardTestArm(recipe.body.map(lineText));
	assert.ok(arm.length > 0, "the test) arm is empty");
	assert.ok(!arm.join("\n").includes("probe.integration.test.ts"));
	assert.ok(!arm.join("\n").includes("*.test.ts"), "the test) arm must list files explicitly");
	assert.ok(cwdGuardUnitFiles(arm).includes("rules.test.ts"));
});

test("the aggregate test recipe runs the cwd-guard unit group", async () => {
	const json = JSON.parse((await exec("just", ["--justfile", join(repo, "justfile"), "--json"])).stdout);
	const lines: string[] = json.recipes["test"].body.map(lineText);
	assert.ok(lines.includes('run_group "cwd-guard test" just -f "${justfile}" cwd-guard test'));
});

// The lines between `test)` and the next `;;` of the cwd-guard recipe.
function cwdGuardTestArm(lines: string[]): string[] {
	const start = lines.findIndex(line => line.trim() === "test)");
	assert.ok(start >= 0, "no test) arm");
	const arm: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (line.trim() === ";;") break;
		arm.push(line);
	}
	return arm;
}

function cwdGuardUnitFiles(arm: string[]): string[] {
	return [...arm.join("\n").matchAll(/\$\{ext_dir\}\/([A-Za-z0-9._-]+\.ts)/g)].map(match => match[1]);
}

test("no cwd-guard unit test or unit under test imports a pi-permission-modes or ~/.pi path", async () => {
	const json = JSON.parse((await exec("just", ["--justfile", join(repo, "justfile"), "--json"])).stdout);
	const tests = cwdGuardUnitFiles(cwdGuardTestArm(json.recipes["cwd-guard"].body.map(lineText)));
	assert.ok(tests.length > 0);
	const files = new Set<string>();
	for (const name of tests) {
		files.add(name);
		files.add(name.replace(/\.test\.ts$/, ".ts"));
	}
	const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'`])([^"'`]+)\1/g;
	for (const name of files) {
		const source = await readFile(join(repo, "extensions/cwd-guard", name), "utf8");
		for (const match of source.matchAll(specifier)) {
			assert.doesNotMatch(match[2], /pi-permission-modes|(^|\/)\.pi(\/|$)|^~/, `${name} imports ${match[2]}`);
		}
	}
});

// Limits of this case: the fs wrappers in tests/suite-isolation-guard.mjs do not see ESM import, and injected
// seams never reach the guarded .pi directory, so it only catches direct fs access made by the unit tests.
test("the cwd-guard unit tests make no guarded fs access under a fake home (cannot catch ESM import or injected seams)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cwd-guard isolation "));
	try {
		const home = join(dir, "home");
		const log = join(dir, "violations.log");
		await mkdir(join(home, ".pi"), { recursive: true });
		await writeFile(log, "");
		const env = { ...guardEnv(home, log, guardSource), TMPDIR: dir, USERPROFILE: home, PI_LEDGER_PATH: join(dir, "ledger.yaml") };
		delete env.PI_CODING_AGENT_DIR;
		const ext = join(repo, "extensions", "cwd-guard");
		await exec(process.execPath, ["--test", join(ext, "index.test.ts"), join(ext, "rules.test.ts")], { env });
		await assertNoGuardViolations(log);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

async function filesUnder(dir: string): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...await filesUnder(path));
		else found.push(path);
	}
	return found;
}

test("cwd-guard sources and the docs name no literal personal home path", async () => {
	// Built from fragments so this file does not match its own pattern.
	const personalHome = new RegExp(`(?:${["/ho", "me/"].join("")}|${["/Us", "ers/"].join("")})[A-Za-z]`);
	assert.doesNotMatch("/home/<name>", personalHome);
	assert.doesNotMatch("/Users/<name>", personalHome);
	assert.match(["/ho", "me/", "x"].join(""), personalHome);
	const files = [
		...await filesUnder(join(repo, "extensions", "cwd-guard")),
		join(repo, "README.md"), join(repo, "justfile"), join(repo, "AGENTS.md"),
		fileURLToPath(import.meta.url),
	];
	assert.ok(files.length > 5);
	for (const file of files) assert.doesNotMatch(await readFile(file, "utf8"), personalHome, file);
});
