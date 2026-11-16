import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { collectRecipes, toolName } from "./recipes.ts";
import { argvFor, schemaFor } from "./arguments.ts";
import extension from "./index.ts";

const exec = promisify(execFile);

test("real just supports expression defaults, option terminators, and repeatable options", async () => {
	const dir = await mkdtemp(join(tmpdir(), "just-tools-argv-"));
	try {
		const file = join(dir, "justfile");
		await writeFile(file, `set unstable
set lists
set positional-arguments
[arg('mode', long)]
with-option first=env_var_or_default('JUST_TOOLS_TEST_VALUE', 'computed') mode="normal" *rest:
    @printf '<%s>\\n' "$@"
[arg('item', long, multiple)]
repeated item:
    @echo {{item}}
`);
		const json = JSON.parse((await exec("just", ["--justfile", file, "--json"])).stdout);
		const recipes = collectRecipes(json, new Set(["with-option", "repeated"]));
		const option = recipes.find((r) => r.path === "with-option")!;
		assert.match((await exec("just", argvFor(file, option, {}), { env: { ...process.env, JUST_TOOLS_TEST_VALUE: "computed" } })).stdout, /<computed>/);
		const special = await exec("just", argvFor(file, option, { first: "--first", mode: "-value", rest: ["--", "two words"] }));
		assert.match(special.stdout, /<--first>\n<-value>\n<-->\n<two words>/);
		const repeat = recipes.find((r) => r.path === "repeated")!;
		assert.equal(schemaFor(repeat).properties.item.type, "array");
		assert.match((await exec("just", argvFor(file, repeat, { item: ["one", "two"] }))).stdout, /one two/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("project just-tools recipe exposes the validated test action", async () => {
	const file = fileURLToPath(new URL("../../../justfile", import.meta.url));
	const json = JSON.parse((await exec("just", ["--justfile", file, "--json"])).stdout);
	const recipe = collectRecipes(json, new Set(["just-tools"]))[0];
	assert.equal(recipe.path, "just-tools");
	assert.equal(toolName(recipe.path), "just_just_tools");
	assert.equal(recipe.parameters[0].name, "action");
	assert.deepEqual(recipe.parameters[0].pattern, ["test"]);
	assert.equal(recipe.parameters[0].default, "test");
	const dryRun = await exec("just", ["--justfile", file, "-n", "just-tools", "test"]);
	assert.match(dryRun.stdout + dryRun.stderr, /just-tools\/execution\.test\.ts/);
	await assert.rejects(exec("just", ["--justfile", file, "just-tools", "invalid"]), /does not match pattern/);
});

async function fixture(justfile: string, fn: (tool: any, dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "just-tools-output-"));
	try {
		await writeFile(join(dir, "justfile"), justfile);
		let start: any; const tools: any[] = [];
		const pi = {
			on(_name: string, handler: any) { start = handler; },
			getAllTools() { return []; },
			registerTool(tool: any) { tools.push(tool); },
			async exec(command: string, args: string[], options: any) {
				const result = await exec(command, args, options);
				return { ...result, code: 0, killed: false, truncated: false };
			},
		};
		extension(pi as any, { outputDir: join(dir, "logs") });
		const home = process.env.HOME;
		process.env.HOME = join(dir, "home");
		try { await start({}, { cwd: dir, ui: { notify: (message: string) => assert.fail(message) } }); }
		finally { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; }
		assert.equal(tools.length, 1);
		await fn(tools[0], dir);
	} finally { await rm(dir, { recursive: true, force: true }); }
}

test("tail follows grep, applies to stderr, and saves unfiltered output privately", async () => fixture(`output:
    @printf 'skip\\nmatch 1\\nmatch 2\\nmatch 3\\n'; printf 'err 1\\nerr 2\\nerr 3\\n' >&2
`, async (tool, dir) => {
	const result = await tool.execute("id", { just_options: { grep: "^match", tail: 2 } });
	assert.equal(result.isError, false);
	assert.match(result.content[0].text, /match 2\nmatch 3/);
	assert.doesNotMatch(result.content[0].text, /match 1|skip|err 1/);
	assert.match(result.content[0].text, /err 2\nerr 3/);
	assert.ok(result.details.truncated);
	assert.match(result.details.fullOutputPath, /\.out$/);
	assert.ok(result.details.fullOutputPath.startsWith(join(dir, "logs")));
	const saved = await readFile(result.details.fullOutputPath, "utf8");
	assert.match(saved, /skip\nmatch 1\nmatch 2\nmatch 3/);
	assert.match(saved, /err 1\nerr 2\nerr 3/);
	assert.equal((await stat(result.details.fullOutputPath)).mode & 0o777, 0o600);
	assert.match(result.content[0].text, /Full output:/);
	const other = await tool.execute("id", {});
	assert.notEqual(other.details.fullOutputPath, result.details.fullOutputPath);
	assert.match(other.content[0].text, /skip\nmatch 1/);
}));

test("tail defaults to 25, supports overrides and disabling, and preserves full output", async () => fixture(`output:
    @node -e "for (let i = 1; i <= 60; i++) { const n = String(i).padStart(2, '0'); console.log('out ' + n); console.error('err ' + n); }"
`, async (tool) => {
	assert.match(tool.description, /defaults to 25/);
	assert.match(tool.description, /0 or a negative/);
	assert.match(tool.parameters.properties.just_options.properties.tail.description, /Defaults to 25/);
	for (const args of [{}, { just_options: {} }]) {
		const result = await tool.execute("id", args);
		assert.equal(result.isError, false);
		assert.equal(result.details.truncated, true);
		assert.match(result.content[0].text, /\[Output truncated\. Read the full unfiltered output in the log file below\.\]/);
		assert.ok(result.content[0].text.includes(`Full output: ${result.details.fullOutputPath}`));
		assert.doesNotMatch(result.content[0].text, /out 35\b|err 35\b/);
		assert.match(result.content[0].text, /out 36\b/);
		assert.match(result.content[0].text, /out 60\b/);
		assert.match(result.content[0].text, /err 36\b/);
		assert.match(result.content[0].text, /err 60\b/);
		const saved = await readFile(result.details.fullOutputPath, "utf8");
		assert.match(saved, /out 01\n/);
		assert.match(saved, /err 01\n/);
	}
	const filtered = await tool.execute("id", { just_options: { grep: "^out [0-9][02468]$" } });
	assert.doesNotMatch(filtered.content[0].text, /out 10\b/);
	assert.match(filtered.content[0].text, /out 12\b/);
	assert.match(filtered.content[0].text, /out 60\b/);
	assert.match(filtered.content[0].text, /err 36\b/);
	const short = await tool.execute("id", { just_options: { tail: 2 } });
	assert.doesNotMatch(short.content[0].text, /out 58\b|err 58\b/);
	assert.match(short.content[0].text, /out 59\n.*out 60/s);
	assert.match(short.content[0].text, /err 59\n.*err 60/s);
	const longer = await tool.execute("id", { just_options: { tail: 40 } });
	assert.doesNotMatch(longer.content[0].text, /out 20\b|err 20\b/);
	assert.match(longer.content[0].text, /out 21\b/);
	assert.match(longer.content[0].text, /err 21\b/);
	for (const tail of [0, -1, Number.MIN_SAFE_INTEGER]) {
		const result = await tool.execute("id", { just_options: { tail } });
		assert.equal(result.isError, false);
		assert.equal(result.details.truncated, false);
		assert.doesNotMatch(result.content[0].text, /\[Output truncated\./);
		assert.match(result.content[0].text, /out 01\b/);
		assert.match(result.content[0].text, /out 60\b/);
		assert.match(result.content[0].text, /err 01\b/);
		assert.match(result.content[0].text, /err 60\b/);
	}
}));

test("disabled tail returns the start of each stream within existing limits", async () => fixture(`output:
    @node -e "for (let i = 1; i <= 1010; i++) { console.log('out ' + i); console.error('err ' + i); }"
`, async (tool) => {
	for (const tail of [0, -2]) {
		const result = await tool.execute("id", { just_options: { tail } });
		assert.equal(result.isError, false);
		assert.equal(result.details.truncated, true);
		assert.match(result.content[0].text, /out 1\n/);
		assert.match(result.content[0].text, /out 1000\n/);
		assert.doesNotMatch(result.content[0].text, /out 1001\n/);
		assert.match(result.content[0].text, /err 1\n/);
		assert.match(result.content[0].text, /err 1000\n/);
		assert.doesNotMatch(result.content[0].text, /err 1001\n/);
		const saved = await readFile(result.details.fullOutputPath, "utf8");
		assert.match(saved, /out 1010\n/);
		assert.match(saved, /err 1010\n/);
	}
}));

test("reported log line count includes headers, separators, and unfiltered output", async () => {
	await fixture(`output:
    @printf 'first\\n\\nlast'; printf 'error\\nlast error' >&2
`, async (tool) => {
		const result = await tool.execute("id", { just_options: { grep: "first|last", tail: 1 } });
		assert.equal(result.isError, false);
		const saved = await readFile(result.details.fullOutputPath, "utf8");
		assert.equal(result.details.fullOutputLines, 7);
		assert.equal(result.details.fullOutputLines, (saved.match(/\n/g) ?? []).length);
		assert.ok(result.content[0].text.includes(`Full output: ${result.details.fullOutputPath} (7 lines)`));
	});
	await fixture(`output:
    @printf '\\377\\r\\n'; printf 'larger error\\r\\nsecond\\n' >&2
`, async (tool) => {
		const result = await tool.execute("id", {});
		const saved = await readFile(result.details.fullOutputPath);
		assert.ok(saved.includes(0xff));
		assert.equal(result.details.fullOutputLines, 7);
		assert.equal(result.details.fullOutputLines, saved.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0));
	});
	await fixture(`output:
    @true
`, async (tool) => {
		const result = await tool.execute("id", {});
		const saved = await readFile(result.details.fullOutputPath, "utf8");
		assert.equal(result.details.fullOutputLines, 4);
		assert.equal(result.details.fullOutputLines, (saved.match(/\n/g) ?? []).length);
		assert.ok(result.content[0].text.includes(`Full output: ${result.details.fullOutputPath} (4 lines)`));
	});
});

test("show mode uses the default tail and permits disabling it", async () => {
	const commands = Array.from({ length: 40 }, (_, i) => `    @echo show-line-${String(i + 1).padStart(2, "0")}`).join("\n");
	await fixture(`output:\n${commands}\n`, async (tool) => {
		const shown = await tool.execute("id", { just_options: { show: true } });
		assert.equal(shown.isError, false);
		assert.equal(shown.details.truncated, true);
		assert.match(shown.content[0].text, /Output truncated\. Read the full unfiltered output in the log file below/);
		assert.ok(shown.content[0].text.includes(`Full output: ${shown.details.fullOutputPath}`));
		assert.doesNotMatch(shown.content[0].text, /show-line-01/);
		assert.match(shown.content[0].text, /show-line-40/);
		assert.match(await readFile(shown.details.fullOutputPath, "utf8"), /show-line-01/);
		const filtered = await tool.execute("id", { just_options: { show: true, grep: "show-line" } });
		assert.doesNotMatch(filtered.content[0].text, /show-line-15/);
		assert.match(filtered.content[0].text, /show-line-16/);
		const longer = await tool.execute("id", { just_options: { show: true, tail: 30 } });
		assert.match(longer.content[0].text, /show-line-11/);
		assert.doesNotMatch(longer.content[0].text, /show-line-10/);
		const full = await tool.execute("id", { just_options: { show: true, tail: 0 } });
		assert.equal(full.isError, false);
		assert.equal(full.details.truncated, false);
		assert.match(full.content[0].text, /show-line-01/);
		assert.match(full.content[0].text, /show-line-40/);
	});
});

test("terminal controls are removed from display but kept in the raw log", async () => fixture(`output:
    @printf '\\033]52;c;dGVzdA==\\007safe\\033[31mred\\033[0m\\n'; printf 'err\\033[2Jdone\\n' >&2
`, async (tool) => {
	const result = await tool.execute("id", {});
	assert.equal(result.isError, false);
	assert.match(result.content[0].text, /safered/);
	assert.match(result.content[0].text, /errdone/);
	assert.doesNotMatch(result.content[0].text, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
	const saved = await readFile(result.details.fullOutputPath);
	assert.ok(saved.includes(Buffer.from("\x1b]52;c;dGVzdA==\x07")));
	assert.ok(saved.includes(Buffer.from("err\x1b[2Jdone")));
}));

test("large output does not stop the process and grep selects late matches", async () => fixture(`output:
    @node -e "process.stdout.write('discard\\\\n'.repeat(50000) + 'needle\\\\n'); process.stderr.write('diagnostic\\\\n')"
`, async (tool) => {
	const result = await tool.execute("id", { just_options: { grep: "needle", tail: 1 } });
	assert.equal(result.isError, false);
	assert.match(result.content[0].text, /needle/);
	assert.match(result.content[0].text, /diagnostic/);
	const saved = await readFile(result.details.fullOutputPath, "utf8");
	assert.ok(Buffer.byteLength(saved) > 256 * 1024);
	assert.match(saved, /needle/);
	const noMatch = await tool.execute("id", { just_options: { grep: "not present" } });
	assert.equal(noMatch.isError, false);
	assert.match(noMatch.content[0].text, /no matches/i);
}));

test("grep finds matches beyond 64 MiB without stopping the recipe", { timeout: 30_000 }, async () => fixture(`output:
    @node -e "const f = require('fs'); const b = Buffer.from('discard\\\\n'.repeat(8192)); for (let i = 0; i < 1025; i++) f.writeSync(1, b); f.writeSync(1, 'needle\\\\n')"
`, async (tool) => {
	const result = await tool.execute("id", { just_options: { grep: "needle", tail: 1 } });
	assert.equal(result.isError, false);
	assert.match(result.content[0].text, /needle/);
	assert.doesNotMatch(result.content[0].text, /(?:grep|filter).*incomplete|incomplete.*(?:grep|filter)/i);
	assert.equal(result.details.fullOutputLines, 1025 * 8192 + 5);
	assert.ok((await stat(result.details.fullOutputPath)).size > 64 * 1024 * 1024);
}));

test("tail keeps UTF-8 output and applies byte limits to long lines", async () => fixture(`output:
    @node -e "process.stdout.write('first\\\\n' + 'é'.repeat(20000) + '\\\\nlast\\\\n')"
`, async (tool) => {
	const result = await tool.execute("id", { just_options: { tail: 2 } });
	assert.equal(result.isError, false);
	assert.equal(result.details.truncated, true);
	assert.match(result.content[0].text, /last/);
	assert.doesNotMatch(result.content[0].text, /�/);
	assert.match(await readFile(result.details.fullOutputPath, "utf8"), /first\né{20000}\nlast/);
}));

test("failure status survives grep and tail, with unfiltered output saved", async () => fixture(`output:
    @printf 'skip\\nmatch 1\\nmatch 2\\n'; printf 'err 1\\nerr 2\\n' >&2; exit 7
`, async (tool) => {
	const result = await tool.execute("id", { just_options: { grep: "^match 2$", tail: 2 } });
	assert.equal(result.isError, true);
	assert.equal(result.details.exitCode, 7);
	assert.match(result.content[0].text, /match 2/);
	assert.match(result.content[0].text, /err 2/);
	assert.doesNotMatch(result.content[0].text, /match 1|err 1|skip/);
	const saved = await readFile(result.details.fullOutputPath, "utf8");
	assert.match(saved, /skip\nmatch 1\nmatch 2/);
	assert.match(saved, /err 1\nerr 2/);
}));

test("an oversized grep line does not stop the recipe or lose the full output", async () => fixture(`output:
    @node -e "process.stdout.write('x'.repeat(9 * 1024 * 1024) + '\\\\nneedle\\\\n'); require('fs').writeFileSync('finished', 'yes')"
`, async (tool, dir) => {
	const result = await tool.execute("id", { just_options: { grep: "needle" } });
	assert.equal(result.isError, false);
	assert.equal(await readFile(join(dir, "finished"), "utf8"), "yes");
	assert.match(result.content[0].text, /(?:grep|filter).*incomplete|incomplete.*(?:grep|filter)/i);
	const saved = await readFile(result.details.fullOutputPath, "utf8");
	assert.match(saved, /x{100}.*needle/s);
	assert.ok(Buffer.byteLength(saved) > 9 * 1024 * 1024);
}));

test("a pathological regular expression does not hang or stop the recipe", { timeout: 20_000 }, async () => {
	if (process.env.JUST_TOOLS_REGEX_CHILD !== "1") {
		// An event-loop timeout cannot interrupt synchronous regex backtracking.
		// Run the check in a separate process group with a parent-enforced deadline.
		await new Promise<void>((resolve, reject) => {
			const env: NodeJS.ProcessEnv = { ...process.env, JUST_TOOLS_REGEX_CHILD: "1" };
			delete env.NODE_TEST_CONTEXT;
			const child = spawn(process.execPath, ["--test", "--test-name-pattern=^a pathological regular expression", fileURLToPath(import.meta.url)], {
				env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
			});
			let output = "";
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				try {
					if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
					else child.kill("SIGKILL");
				} catch { /* The process already exited. */ }
			}, 12_000);
			for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = (output + chunk.toString()).slice(-8192); });
			child.once("error", (error) => { clearTimeout(timer); reject(error); });
			child.once("close", (code) => {
				clearTimeout(timer);
				if (timedOut) reject(new Error("Regex test exceeded the parent deadline"));
				else if (code !== 0) reject(new Error(`Regex test failed (exit ${code}): ${output}`));
				else if (!output.includes("a pathological regular expression")) reject(new Error(`Regex child did not run the test: ${output}`));
				else resolve();
			});
		});
		return;
	}
	await fixture(`output:
    @node -e "process.stdout.write('a'.repeat(35) + 'X\\\\n'); require('fs').writeFileSync('finished', 'yes')"
`, async (tool, dir) => {
		const result = await tool.execute("id", { just_options: { grep: "^(a+)+$" } });
		assert.equal(result.isError, false);
		assert.equal(await readFile(join(dir, "finished"), "utf8"), "yes");
		assert.match(result.content[0].text, /(?:grep|filter).*incomplete|incomplete.*(?:grep|filter)/i);
		assert.match(await readFile(result.details.fullOutputPath, "utf8"), /a{35}X/);

		const controller = new AbortController();
		const execution = tool.execute("id", { just_options: { grep: "^(a+)+$" } }, controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 500));
		controller.abort();
		const cancelled = await execution;
		assert.equal(cancelled.details.cancelled, true);
		assert.match(await readFile(cancelled.details.fullOutputPath, "utf8"), /a{35}X/);
	});
});

test("log finalization failure preserves the captured streams", { skip: typeof process.getuid === "function" && process.getuid() === 0 }, async () => fixture(`output:
    @printf 'standard output\\n'; printf 'standard error\\n' >&2; for i in $(seq 1 30); do echo "line $i"; done; chmod 500 logs
`, async (tool, dir) => {
	try {
		const result = await tool.execute("id", {});
		assert.equal(result.isError, true);
		assert.equal(result.details.incomplete, true);
		assert.equal(result.details.fullOutputPath, undefined);
		assert.equal(result.details.fullOutputLines, undefined);
		assert.match(result.content[0].text, /recoverable captures/i);
		assert.match(result.content[0].text, /Output truncated\. Read the available captured output in the files listed below/);
		assert.doesNotMatch(result.content[0].text, /full unfiltered output/);
		const captures: string[] = result.details.capturePaths;
		assert.equal(captures.length, 2);
		assert.match(await readFile(captures[0], "utf8"), /standard output/);
		assert.match(await readFile(captures[1], "utf8"), /standard error/);
	} finally { await chmod(join(dir, "logs"), 0o700); }
}));

test("deleted output directory is reported as unavailable", { skip: process.platform !== "linux" }, async () => fixture(`output:
    @for i in $(seq 1 30); do echo "line $i"; done; rm -rf logs
`, async (tool) => {
	const result = await tool.execute("id", {});
	assert.equal(result.isError, true);
	assert.equal(result.details.truncated, true);
	assert.equal(result.details.outputUnavailable, true);
	assert.equal(result.details.fullOutputPath, undefined);
	assert.equal(result.details.fullOutputLines, undefined);
	assert.equal(result.details.capturePaths, undefined);
	assert.match(result.content[0].text, /Output truncated\. The saved output files are unavailable/);
	assert.doesNotMatch(result.content[0].text, /Read the|Recoverable captures|Full output:/);
}));

test("cancellation during log finalization is reported", { timeout: 20_000 }, async () => fixture(`output:
    @node -e "const f = require('fs'); const b = Buffer.alloc(65536, 'x'); for (let i = 0; i < 256; i++) f.writeSync(1, b); for (let i = 0; i < 256; i++) f.writeSync(2, b)"
`, async (tool, dir) => {
	const logs = join(dir, "logs");
	await mkdir(logs, { mode: 0o700 });
	const controller = new AbortController();
	const watcher = watch(logs, (_event, name) => {
		if (name?.toString().endsWith(".out")) controller.abort();
	});
	try {
		const result = await tool.execute("id", {}, controller.signal);
		assert.equal(controller.signal.aborted, true);
		assert.equal(result.details.cancelled, true);
		assert.equal(result.isError, true);
		assert.ok((await stat(result.details.fullOutputPath)).size >= 32 * 1024 * 1024);
	} finally { watcher.close(); controller.abort(); }
}));

test("closing idle inherited pipes does not kill a background child", { timeout: 10_000 }, async () => fixture(`output:
    @node -e "require('child_process').spawn('sh', ['-c', 'sleep 3; touch survived'], {stdio: 'inherit'}).unref()"
`, async (tool, dir) => {
	const result = await tool.execute("id", {});
	assert.equal(result.details.incomplete, true);
	const deadline = Date.now() + 6_000;
	for (;;) {
		try { await stat(join(dir, "survived")); break; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
}));

test("cancellation escalates after the parent exits and pipes close", { timeout: 10_000 }, async () => fixture(`output:
    @node parent.cjs
`, async (tool, dir) => {
	await writeFile(join(dir, "parent.cjs"), `require('child_process').spawn(process.execPath, ['child.cjs'], {stdio: 'ignore'}).unref(); setInterval(() => {}, 1000);`);
	await writeFile(join(dir, "child.cjs"), `process.on('SIGTERM', () => {}); require('fs').writeFileSync('child-ready', ''); setTimeout(() => require('fs').writeFileSync('child-survived', ''), 2500);`);
	const controller = new AbortController();
	const execution = tool.execute("id", {}, controller.signal);
	try {
		const deadline = Date.now() + 5_000;
		for (;;) {
			try { await stat(join(dir, "child-ready")); break; }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= deadline) throw error;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		}
		controller.abort();
		const result = await execution;
		assert.equal(result.details.cancelled, true);
		await new Promise((resolve) => setTimeout(resolve, 3_000));
		await assert.rejects(stat(join(dir, "child-survived")), { code: "ENOENT" });
	} finally { controller.abort(); await execution; }
}));

test("cancellation reports a partial saved log", async () => fixture(`output:
    @echo started; for i in $(seq 1 30); do echo "line $i"; done; touch ready; sleep 30
`, async (tool, dir) => {
	const controller = new AbortController();
	const execution = tool.execute("id", {}, controller.signal);
	try {
		const deadline = Date.now() + 10_000;
		for (;;) {
			try { await stat(join(dir, "ready")); break; }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= deadline) throw error;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		}
		controller.abort();
		const result = await execution;
		assert.equal(result.isError, true);
		assert.equal(result.details.cancelled, true);
		assert.equal(result.details.incomplete, true);
		assert.equal(result.details.truncated, true);
		assert.match(result.content[0].text, /Output truncated\. Read the available captured output in the log file below/);
		assert.doesNotMatch(result.content[0].text, /full unfiltered output/);
		assert.ok(result.content[0].text.includes(`Partial output: ${result.details.fullOutputPath} (${result.details.fullOutputLines} lines)`));
		const saved = await readFile(result.details.fullOutputPath, "utf8");
		assert.equal(result.details.fullOutputLines, (saved.match(/\n/g) ?? []).length);
		assert.match(saved, /started/);
	} finally { controller.abort(); await execution; }
}));
