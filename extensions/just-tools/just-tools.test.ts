import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import extension from "./index.ts";
import { parseConfig, collectRecipes, mergeConfig, selectRecipes, toolName, type Recipe, type RecipeParameter } from "./recipes.ts";
import { argvFor, schemaFor } from "./arguments.ts";

const exec = promisify(execFile);
const parameter = (name: string, patch: Partial<RecipeParameter> = {}): RecipeParameter => ({
	name, default: null, kind: "singular", flag: false, long: null, short: null, value: null,
	help: null, multiple: false, pattern: null, min: null, max: null, ...patch,
});
const recipe = (parameters: RecipeParameter[] = [], path = "build"): Recipe => ({ name: path, path, doc: null, parameters });

async function fixture(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "just-tools-test-"));
	try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function mock(cwd: string, run?: (command: string, args: string[], options: any) => Promise<any>, home = join(cwd, ".test-home")) {
	let start: any;
	const tools: any[] = [];
	const notifications: string[] = [];
	const calls: { command: string; args: string[]; options: any }[] = [];
	const api = {
		on(event: string, handler: any) { if (event === "session_start") start = handler; },
		getAllTools() { return tools; },
		registerTool(tool: any) { tools.push(tool); },
		async exec(command: string, args: string[], options: any) {
			calls.push({ command, args, options });
			if (run) return run(command, args, options);
			try {
				const result = await exec(command, args, options);
				return { ...result, code: 0, killed: false, truncated: false };
			} catch (error: any) {
				if (typeof error.code === "string") throw error;
				return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code, killed: error.killed ?? false, truncated: false };
			}
		},
	};
	extension(api as any, { outputDir: join(cwd, "output-logs") });
	return { tools, notifications, calls, start: async () => {
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		try { await start({}, { cwd, ui: { notify: (message: string) => notifications.push(message) } }); }
		finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; }
	} };
}

const JUSTFILE = `set positional-arguments
mod public
[private]
mod secret
alias b := build
# Build the project.
[arg('opt', long='opt', help='An option')]
[arg('force', long='force', value='true')]
build target="default" opt="unset" force="false" *rest:
    @printf '<%s>\\n' "$@"
[private]
hidden:
    @echo hidden
plain value:
    @printf '<%s>\\n' "$@"
fail:
    @echo bad >&2; exit 7
`;
const MODULE = `# Module documentation.
run value="module-default":
    @echo {{value}}
`;
async function populate(dir: string) {
	await writeFile(join(dir, "justfile"), JUSTFILE);
	await writeFile(join(dir, "public.just"), MODULE);
	await writeFile(join(dir, "secret.just"), MODULE);
}

test("JSONC and selection are strict and private recipes stay private", () => {
	assert.deepEqual(parseConfig('{/* comment */ "include": ["public::run",], "exclude": [],}', "config"), { include: ["public::run"], exclude: [] });
	assert.throws(() => parseConfig('{"include": ["x"], /*', "config"), /config/);
	assert.throws(() => parseConfig('{"x": tru/* comment */e}', "config"));
	assert.throws(() => parseConfig('{"include": "x"}', "config"));
	assert.throws(() => parseConfig('{"includes": []}', "config"));
	assert.deepEqual(mergeConfig({ include: ["global"], exclude: ["hidden"] }, { include: ["local"] }), { include: ["local"], exclude: ["hidden"] });
	const raw = { recipes: { run: { private: false, parameters: [] }, hidden: { private: true, parameters: [] } }, modules: { public: { recipes: { run: { private: false, parameters: [] } }, modules: {} }, secret: { recipes: { run: { private: false, parameters: [] } }, modules: {} } } };
	const recipes = collectRecipes(raw, new Set(["run", "public::run"]));
	assert.deepEqual(recipes.map((r) => r.path), ["run", "public::run"]);
	assert.deepEqual(selectRecipes(recipes, { include: [] }), []);
	assert.deepEqual(selectRecipes(recipes, { include: ["run", "public::run"], exclude: ["run"] }).map((r) => r.path), ["public::run"]);
	assert.throws(() => selectRecipes(recipes, { include: ["hidden"] }), /private/);
	assert.throws(() => selectRecipes(recipes, { exclude: ["secret::run"] }), /private/);
	assert.equal(toolName("test"), "just_test");
	assert.equal(toolName("just-tools"), "just_just_tools");
	assert.equal(toolName("bash-args"), "just_bash_args");
	assert.equal(toolName("x_y"), "just_x_x5f_uy");
	assert.notEqual(toolName("x-y"), toolName("x_y"));
	assert.notEqual(toolName("foo::bar"), toolName("foo_mbar"));
	assert.equal(toolName("public::run"), "just_public_mrun");
	assert.match(toolName("public::run"), /^[A-Za-z0-9_]{1,64}$/);
	assert.throws(() => toolName("x".repeat(60)), /too long/);
});

test("normalized recipe names are registered and collisions fail safely", async () => fixture(async (dir) => {
	await writeFile(join(dir, "justfile"), `just-tools:\n    @echo works\n`);
	const named = mock(dir); await named.start();
	assert.deepEqual(named.tools.map((tool) => tool.name), ["just_just_tools"]);
	assert.match((await named.tools[0].execute("id", {})).content[0].text, /works/);
	await writeFile(join(dir, "justfile"), `x-x5f-uy:\n    @echo one\nx_y:\n    @echo two\n`);
	const collision = mock(dir); await collision.start();
	assert.equal(collision.tools.length, 0);
	assert.match(collision.notifications[0], /Tool name conflict: just_x_x5f_uy/);
	assert.match(collision.notifications[0], /x-x5f-uy/);
	assert.match(collision.notifications[0], /x_y/);
}));

test("schema and argv preserve optional defaults, flags, and argument boundaries", () => {
	const r = recipe([parameter("first", { default: "default" }), parameter("force", { long: "force", value: "true", default: "false" }), parameter("opt", { long: "opt", default: "default" }), parameter("rest", { kind: "star" })]);
	const schema = schemaFor(r);
	assert.deepEqual(schema.required, []);
	assert.equal(schema.properties.force.type, "boolean");
	assert.deepEqual(argvFor("/project/justfile", r, {}), ["--justfile", "/project/justfile", "build"]);
	assert.deepEqual(argvFor("f", r, { first: "-x", force: true, opt: "a b;$(x)", rest: ["--foo", ""] }), ["--justfile", "f", "build", "--force", "--opt=a b;$(x)", "--", "-x", "--foo", ""]);
	assert.throws(() => argvFor("f", r, { rest: ["later"] }), /Cannot supply rest/);
	assert.throws(() => argvFor("f", r, { extra: "x" }), /Unknown/);
	assert.deepEqual(argvFor("f", recipe([parameter("x")]), { x: "--" }), ["--justfile", "f", "build", "--"]);
	assert.throws(() => schemaFor(recipe([parameter("bad", { kind: "star", long: "bad" })])), /Unsupported/);
	const plus = recipe([parameter("items", { kind: "plus" })]);
	assert.throws(() => argvFor("f", plus, { items: [] }), /at least/);
	const booleanFlag = recipe([parameter("verbose", { flag: true, long: "verbose" })]);
	assert.deepEqual(schemaFor(booleanFlag).required, []);
	assert.deepEqual(argvFor("f", booleanFlag, { verbose: true }), ["--justfile", "f", "build", "--verbose"]);
	assert.deepEqual(argvFor("f", booleanFlag, { verbose: false }), ["--justfile", "f", "build"]);
});

test("Pi validates the conditional show schema and normal required arguments", async () => {
	const version = (await readFile(new URL("../../install/current-version", import.meta.url), "utf8")).trim();
	const validation = await import(new URL(`../../install/releases/${version}/node_modules/@earendil-works/pi-ai/dist/utils/validation.js`, import.meta.url).href);
	const definition = { name: "just_build", parameters: schemaFor(recipe([parameter("target")])) };
	const validate = (args: unknown) => validation.validateToolArguments(definition, { name: definition.name, arguments: args });
	assert.deepEqual(validate({ target: "release" }), { target: "release" });
	assert.deepEqual(validate({ just_options: { show: true } }), { just_options: { show: true } });
	assert.throws(() => validate({}), /Validation failed/);
	assert.throws(() => validate({ just_options: {} }), /Validation failed/);
	assert.throws(() => validate({ just_options: { show: false } }), /Validation failed/);
	assert.throws(() => validate({ just_options: { grep: "target" } }), /Validation failed/);
	assert.throws(() => validate({ target: "release", just_options: { unknown: true } }), /Validation failed/);
	assert.deepEqual(validate({ target: "release", just_options: { tail: 100 } }), { target: "release", just_options: { tail: 100 } });
	for (const tail of [0, -1, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
		assert.deepEqual(validate({ target: "release", just_options: { tail } }), { target: "release", just_options: { tail } });
	}
	for (const tail of [1.5, Number.MIN_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(() => validate({ target: "release", just_options: { tail } }), /Validation failed/);
	}
	const google = await import(new URL(`../../install/releases/${version}/node_modules/@earendil-works/pi-ai/dist/api/google-shared.js`, import.meta.url).href);
	const sent = google.convertTools([definition])[0].functionDeclarations[0].parametersJsonSchema;
	assert.deepEqual(sent.anyOf[1].properties.just_options.properties.show.enum, [true]);
	assert.equal(sent.properties.just_options.properties.tail.minimum, Number.MIN_SAFE_INTEGER);
	assert.equal(sent.properties.just_options.properties.tail.multipleOf, 1);
});

test("real just discovery, registration, execution, errors, and reload", async () => fixture(async (dir) => {
	await populate(dir);
	const pi = mock(dir);
	await pi.start();
	assert.deepEqual(pi.notifications, []);
	assert.equal(pi.tools.length, 4);
	const build = pi.tools.find((t) => t.label === "just build");
	assert.ok(build.description.includes("Build the project."));
	assert.ok(build.parameters.properties.opt.description.includes("An option"));
	const moduleTool = pi.tools.find((t) => t.label === "just public::run");
	assert.ok(moduleTool);
	assert.match((await moduleTool.execute("id", {})).content[0].text, /module-default/);
	assert.ok(!pi.tools.some((t) => /secret|hidden|just b$/.test(t.label)));
	const result = await build.execute("id", { target: "-hello", force: true, opt: "a b;$(echo bad)", rest: ["--value", "last"] });
	assert.equal(result.isError, false);
	assert.match(result.content[0].text, /<-hello>\n<a b;\$\(echo bad\)>\n<true>\n<--value>\n<last>/);
	assert.equal(pi.calls.at(-1)?.options.cwd, dir);
	assert.deepEqual((await build.execute("id", {})).isError, false);
	const plain = pi.tools.find((t) => t.label === "just plain");
	assert.match((await plain.execute("id", { value: "--" })).content[0].text, /<-->/);
	const failure = await pi.tools.find((t) => t.label === "just fail").execute("id", {});
	assert.equal(failure.isError, true);
	assert.equal(failure.details.exitCode, 7);
	assert.match(failure.content[0].text, /bad/);
	const controller = new AbortController(); controller.abort();
	assert.equal((await build.execute("id", {}, controller.signal)).details.cancelled, true);
	await mkdir(join(dir, ".pi"));
	await writeFile(join(dir, ".pi", "just-tools.jsonc"), '{"include":["public::run"],}');
	const reloaded = mock(dir); await reloaded.start();
	assert.deepEqual(reloaded.tools.map((t) => t.label), ["just public::run"]);
	await writeFile(join(dir, ".pi", "just-tools.jsonc"), '{"include":["secret::run"]}');
	const invalid = mock(dir); await invalid.start();
	assert.equal(invalid.tools.length, 0);
	assert.match(invalid.notifications[0], /private/);
}));

function toolOptionsName(tool: any): string {
	const names = Object.entries(tool.parameters.properties).filter(([, property]: [string, any]) =>
		property.type === "object" && property.properties?.grep && property.properties?.show).map(([name]) => name);
	assert.equal(names.length, 1, "each tool must expose one options object");
	return names[0];
}

test("grep filters stdout without hiding stderr or changing the recipe status", async () => fixture(async (dir) => {
	await writeFile(join(dir, "justfile"), `output:
    @touch executed; printf 'skip\\nmatch one\\nmatch two\\n' ; printf 'important error\\n' >&2
fail:
    @printf 'nothing\\n'; printf 'failure details\\n' >&2; exit 7
`);
	const pi = mock(dir); await pi.start();
	const output = pi.tools.find((t) => t.label === "just output");
	const name = toolOptionsName(output);
	const filtered = await output.execute("id", { [name]: { grep: "^match (one|two)$" } });
	assert.equal(filtered.isError, false);
	assert.match(filtered.content[0].text, /match one\nmatch two/);
	assert.doesNotMatch(filtered.content[0].text, /skip/);
	assert.match(filtered.content[0].text, /important error/);
	const noMatch = await output.execute("id", { [name]: { grep: "absent" } });
	assert.equal(noMatch.isError, false);
	assert.match(noMatch.content[0].text, /no match/i);
	assert.match(noMatch.content[0].text, /important error/);
	const fail = pi.tools.find((t) => t.label === "just fail");
	const failed = await fail.execute("id", { [toolOptionsName(fail)]: { grep: "absent" } });
	assert.equal(failed.isError, true);
	assert.equal(failed.details.exitCode, 7);
	assert.match(failed.content[0].text, /failure details/);
	assert.match(failed.content[0].text, /no match/i);
	await rm(join(dir, "executed"));
	for (const options of [null, "bad", { grep: 1 }, { show: "yes" }, { tail: 1.5 }, { tail: "1" }, { tail: Number.MIN_SAFE_INTEGER - 1 }, { tail: Number.MAX_SAFE_INTEGER + 1 }, { other: true }]) {
		assert.equal((await output.execute("id", { [name]: options })).isError, true);
	}
	const invalid = await output.execute("id", { [name]: { grep: "[" } });
	assert.equal(invalid.isError, true);
	assert.match(invalid.content[0].text, /regular expression|regex|regexp/i);
	await assert.rejects(readFile(join(dir, "executed")), { code: "ENOENT" }, "invalid options must fail before recipe execution");
}));

test("show inspects current recipes without executing them or requiring recipe arguments", async () => fixture(async (dir) => {
	const file = join(dir, "justfile");
	await writeFile(file, `mod public
run value:
    @echo {{value}} > side-effect
`);
	await writeFile(join(dir, "public.just"), `run value:
    @echo {{value}} > module-side-effect
`);
	const pi = mock(dir); await pi.start();
	const run = pi.tools.find((t) => t.label === "just run");
	const name = toolOptionsName(run);
	const shown = await run.execute("id", { [name]: { show: true } });
	assert.equal(shown.isError, false);
	assert.match(shown.content[0].text, /echo.*side-effect/);
	await assert.rejects(readFile(join(dir, "side-effect")), { code: "ENOENT" });
	const shownWithArg = await run.execute("id", { value: "unused", [name]: { show: true } });
	assert.equal(shownWithArg.isError, false);
	assert.match(shownWithArg.content[0].text, /echo.*side-effect/);
	const controller = new AbortController(); controller.abort();
	const cancelled = await run.execute("id", { [name]: { show: true } }, controller.signal);
	assert.equal(cancelled.details.cancelled, true);
	assert.equal(cancelled.details.fullOutputPath, undefined);
	const nested = pi.tools.find((t) => t.label === "just public::run");
	const nestedShown = await nested.execute("id", { [toolOptionsName(nested)]: { show: true, grep: "module-side-effect" } });
	assert.equal(nestedShown.isError, false);
	assert.match(nestedShown.content[0].text, /module-side-effect/);
	await assert.rejects(readFile(join(dir, "module-side-effect")), { code: "ENOENT" });
	await writeFile(file, `mod public
run value:
    @echo changed-body
`);
	const changed = await run.execute("id", { [name]: { show: true } });
	assert.match(changed.content[0].text, /changed-body/);
	await writeFile(file, `other:
    @echo other
`);
	const missing = await run.execute("id", { [name]: { show: true } });
	assert.equal(missing.isError, true);
	assert.match(missing.content[0].text, /error|not contain/i);
	const missingArg = await run.execute("id", {});
	assert.equal(missingArg.isError, true);
	assert.match(missingArg.content[0].text, /missing|required/i);
}));

test("options cannot collide with recipe parameters or become just arguments", async () => fixture(async (dir) => {
	await writeFile(join(dir, "justfile"), `collision just_options _just_options:
    @printf '<%s> <%s>\\n' '{{just_options}}' '{{_just_options}}'
`);
	const pi = mock(dir); await pi.start();
	assert.deepEqual(pi.notifications, []);
	const tool = pi.tools.find((t) => t.label === "just collision");
	const name = toolOptionsName(tool);
	assert.notEqual(name, "just_options");
	assert.notEqual(name, "_just_options");
	const result = await tool.execute("id", { just_options: "a", _just_options: "b", [name]: { grep: "<a>" } });
	assert.equal(result.isError, false);
	assert.match(result.content[0].text, /<a> <b>/);
	assert.doesNotMatch(result.content[0].text, /Unknown argument/);
}));

test("global config defaults and local keys override matching global keys", async () => fixture(async (dir) => {
	await populate(dir);
	const home = join(dir, "home");
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(join(home, ".pi", "just-tools.jsonc"), '{"include":["build","plain"],"exclude":["plain"]}');
	const globalOnly = mock(dir, undefined, home); await globalOnly.start();
	assert.deepEqual(globalOnly.tools.map((tool) => tool.label), ["just build"]);
	await mkdir(join(dir, ".pi"));
	await writeFile(join(dir, ".pi", "just-tools.jsonc"), '{"include":["plain"],"exclude":[]}');
	const local = mock(dir, undefined, home); await local.start();
	assert.deepEqual(local.tools.map((tool) => tool.label), ["just plain"]);
}));

test("no parent lookup; missing executable and conflicts are reported", async () => fixture(async (dir) => {
	const empty = mock(dir); await empty.start(); assert.equal(empty.tools.length, 0); assert.equal(empty.calls.length, 0);
	await populate(dir);
	const childDir = join(dir, "child"); await mkdir(childDir);
	const child = mock(childDir); await child.start(); assert.equal(child.tools.length, 0); assert.equal(child.calls.length, 0);
	const missing = mock(dir, async () => { throw new Error("spawn just ENOENT"); });
	await missing.start(); assert.match(missing.notifications[0], /ENOENT/); assert.equal(missing.tools.length, 0);
	const collision = mock(dir); collision.tools.push({ name: toolName("build") });
	await collision.start(); assert.match(collision.notifications[0], /conflict/); assert.equal(collision.tools.length, 1);
}));
