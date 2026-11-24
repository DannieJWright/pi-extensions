import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveRepoRoot } from "./ledger.ts";
import { exec, setupRepo } from "./test-harness.ts";

const fixture = `ledger:
  branch: {BRANCH}
  validation_scripts: []
  features: []
`;

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

test("fixture Git operations stay within the temporary repository", async () => {
	const { dir, branch, cleanup } = await setupRepo(fixture);
	try {
		assert.equal(branch, "feature-x");
		const canonicalDir = await realpath(dir);
		const root = await exec("git", ["rev-parse", "--show-toplevel"], dir);
		assert.equal(root.code, 0, root.stderr);
		assert.equal(root.stdout.trim(), canonicalDir);
		const script = await exec("sh", ["-c", "git rev-parse --show-toplevel"], dir);
		assert.equal(script.code, 0, script.stderr);
		assert.equal(script.stdout.trim(), canonicalDir);
		await writeFile(join(dir, "work.txt"), "fixture work\n");
		const add = await exec("git", ["add", "work.txt"], dir);
		assert.equal(add.code, 0, add.stderr);
		const commit = await exec("git", ["commit", "-m", "fixture work"], dir);
		assert.equal(commit.code, 0, commit.stderr);
		const author = await exec("git", ["log", "-1", "--format=%an"], dir);
		assert.equal(author.stdout.trim(), "Ledger Test");
	} finally { await cleanup(); }
});

test("fixture Git discovery stops before TMPDIR while nested repositories work", async () => {
	const root = await mkdtemp(join(tmpdir(), "outside-repo-"));
	try {
		assert.equal(await resolveRepoRoot(root, exec), "");
		const rootResult = await exec("git", ["rev-parse", "--show-toplevel"], root);
		assert.notEqual(rootResult.code, 0);
		assert.match(rootResult.stderr, /not a git repository/i);
		const localConfig = await exec("git", ["config", "--local", "--get", "test.ancestor"], root);
		assert.notEqual(localConfig.code, 0);
		await writeFile(join(root, "outside.txt"), "not in a repository\n");
		const commit = await exec("git", ["commit", "--allow-empty", "-m", "outside"], root);
		assert.notEqual(commit.code, 0);
		assert.match(commit.stderr, /not a git repository/i);

		const nested = join(root, "nested-repo");
		const subdir = join(nested, "subdir");
		await mkdir(subdir, { recursive: true });
		for (const args of [["init", "-q"], ["config", "user.name", "Ledger Test"], ["config", "user.email", "ledger-test@localhost"]]) {
			const result = await exec("git", args, nested);
			assert.equal(result.code, 0, result.stderr);
		}
		const canonicalNested = await realpath(nested);
		assert.equal(await resolveRepoRoot(subdir, exec), canonicalNested);
		const script = await exec("sh", ["-c", "git rev-parse --show-toplevel"], subdir);
		assert.equal(script.code, 0, script.stderr);
		assert.equal(script.stdout.trim(), canonicalNested);
		const nestedCommit = await exec("git", ["commit", "--allow-empty", "-m", "nested"], subdir);
		assert.equal(nestedCommit.code, 0, nestedCommit.stderr);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("fixture Git discovery cannot reach a hostile ancestor of TMPDIR", async () => {
	const ancestor = await mkdtemp(join(tmpdir(), "hostile ancestor "));
	try {
		const temp = join(ancestor, "temp with spaces");
		const home = join(ancestor, "home");
		const hooks = join(ancestor, "hooks");
		const probe = join(temp, "probe");
		await Promise.all([probe, home, hooks].map(path => mkdir(path, { recursive: true })));
		for (const args of [["init", "-q"], ["config", "test.ancestor", "hostile"], ["config", "core.hooksPath", hooks]]) {
			const result = await exec("git", args, ancestor);
			assert.equal(result.code, 0, result.stderr);
		}
		const marker = join(ancestor, "hook-ran");
		await writeFile(join(hooks, "pre-commit"), "#!/bin/sh\nprintf 'hook ran\\n' >> \"$HOOK_MARKER\"\n", { mode: 0o755 });
		const config = join(ancestor, "hostile-config");
		await writeFile(config, `[core]\n\thooksPath = ${hooks}\n[test]\n\tancestor = hostile\n`);
		const env = {
			...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
			HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), TMPDIR: temp, HOOK_MARKER: marker,
			GIT_CEILING_DIRECTORIES: "/", GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config,
			GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooks,
		};
		delete env.NODE_TEST_CONTEXT;
		// Confirm the fake setup would discover the ancestor without the harness ceiling.
		const probeEnv = { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
		const discovery = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: probe, env: probeEnv, encoding: "utf8" });
		assert.equal(discovery.status, 0, discovery.stderr);
		assert.equal(discovery.stdout.trim(), await realpath(ancestor));
		await rm(probe, { recursive: true });
		const before = await snapshot(ancestor);
		const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern=^fixture Git discovery stops", fileURLToPath(import.meta.url)], {
			env, encoding: "utf8", timeout: 30_000,
		});
		assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /^ok \d+ - fixture Git discovery stops before TMPDIR while nested repositories work/m);
		assert.deepEqual(await snapshot(ancestor), before, "hostile fake ancestor was modified");
	} finally { await rm(ancestor, { recursive: true, force: true }); }
});

test("Git fixture assertions work with a symlinked TMPDIR", async () => {
	const dir = await mkdtemp(join(tmpdir(), "symlinked temp fixture "));
	try {
		const temp = join(dir, "real temp");
		const link = join(dir, "temp link");
		const home = join(dir, "home");
		await Promise.all([temp, home].map(path => mkdir(path)));
		await symlink(temp, link, "dir");
		assert.notEqual(link, await realpath(link));
		const env = {
			...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
			HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), TMPDIR: link, PI_LEDGER_PATH: join(home, "ledger.yaml"),
		};
		delete env.NODE_TEST_CONTEXT;
		const pattern = "^(fixture Git operations stay|fixture Git discovery stops|fixture Git discovery cannot reach|resolveRepoRoot reads the repository)";
		const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", `--test-name-pattern=${pattern}`,
			fileURLToPath(import.meta.url), fileURLToPath(new URL("./ledger.test.ts", import.meta.url))], {
			env, encoding: "utf8", timeout: 60_000,
		});
		assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
		for (const name of ["fixture Git operations stay", "fixture Git discovery stops", "fixture Git discovery cannot reach", "resolveRepoRoot reads the repository"]) {
			assert.match(result.stdout, new RegExp(`^ok \\d+ - ${name}`, "m"));
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("fixture subprocesses reject the temporary root and paths outside it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fixture cwd boundary "));
	try {
		const temp = join(dir, "temp");
		const outside = join(dir, "outside");
		const home = join(dir, "home");
		const inside = join(temp, "inside");
		const escape = join(temp, "escape");
		await Promise.all([inside, outside, home].map(path => mkdir(path, { recursive: true })));
		await symlink(outside, escape, "dir");
		const env = {
			...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
			HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), TMPDIR: temp, PI_LEDGER_PATH: join(home, "ledger.yaml"),
		};
		delete env.NODE_TEST_CONTEXT;
		const harness = pathToFileURL(fileURLToPath(new URL("./test-harness.ts", import.meta.url))).href;
		const code = `
import assert from "node:assert/strict";
import { exec } from ${JSON.stringify(harness)};
const [root, outside, escape, inside] = process.argv.slice(1);
for (const cwd of [root, outside, escape]) {
  const result = await exec("sh", ["-c", "printf invoked > marker"], cwd);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /fixture subprocess cwd must be inside the temporary directory/);
}
const allowed = await exec("sh", ["-c", "printf invoked > marker"], inside);
assert.equal(allowed.code, 0, allowed.stderr);
`;
		const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, temp, outside, escape, inside], {
			env, encoding: "utf8", timeout: 30_000,
		});
		assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
		for (const path of [join(temp, "marker"), join(outside, "marker")]) {
			await assert.rejects(readFile(path), { code: "ENOENT" });
		}
		assert.equal(await readFile(join(inside, "marker"), "utf8"), "invoked");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("fixture Git ignores inherited hostile repository, config, and hooks", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hostile git fixture "));
	try {
		const home = join(dir, "home");
		const xdg = join(dir, "xdg");
		const other = join(dir, "other-repo");
		const hooks = join(dir, "hooks");
		const template = join(dir, "template");
		await Promise.all([home, join(xdg, "git"), other, hooks, join(template, "hooks")].map(path => mkdir(path, { recursive: true })));
		const init = await exec("git", ["init", "-q"], other);
		assert.equal(init.code, 0, init.stderr);
		const hook = "#!/bin/sh\nprintf 'hook ran\\n' >> \"$HOOK_MARKER\"\n";
		await writeFile(join(hooks, "pre-commit"), hook, { mode: 0o755 });
		await writeFile(join(template, "hooks", "pre-commit"), hook, { mode: 0o755 });
		const config = `[core]\n\thooksPath = ${hooks}\n[commit]\n\tgpgSign = true\n[init]\n\tdefaultBranch = hostile\n`;
		await writeFile(join(home, ".gitconfig"), config);
		await writeFile(join(xdg, "git", "config"), config);
		await writeFile(join(xdg, "git", "ignore"), "work.txt\n");
		await writeFile(join(dir, "global-config"), config);
		await writeFile(join(dir, "system-config"), config);
		const before = await snapshot(dir);
		const env = {
			...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
			HOME: home, XDG_CONFIG_HOME: xdg, HOOK_MARKER: join(dir, "hook-ran"),
			GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other,
			GIT_INDEX_FILE: join(dir, "injected-index"), GIT_OBJECT_DIRECTORY: join(other, ".git", "objects"),
			GIT_CONFIG_GLOBAL: join(dir, "global-config"), GIT_CONFIG_SYSTEM: join(dir, "system-config"),
			GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooks,
			GIT_TEMPLATE_DIR: template, GIT_AUTHOR_NAME: "hostile author", GIT_COMMITTER_NAME: "hostile committer",
		};
		delete env.NODE_TEST_CONTEXT;
		const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern=^fixture Git operations stay", fileURLToPath(import.meta.url)], {
			env, encoding: "utf8", timeout: 30_000,
		});
		assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /^ok \d+ - fixture Git operations stay within the temporary repository/m);
		assert.deepEqual(await snapshot(dir), before, "hostile fake state was modified");
	} finally { await rm(dir, { recursive: true, force: true }); }
});
