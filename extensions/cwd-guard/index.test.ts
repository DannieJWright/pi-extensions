import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import cwdGuard, {
	PERMISSION_MODES_ROOT_ENV,
	defaultPackageRoot,
	makeBeforeAgentStartHandler,
	makeRuntimeLoader,
	makeToolCallHandler,
	type CwdGuardDeps,
	type PackageRuntime,
} from "./index.ts";
import { PROMPT_SECTION, promptSectionText, type Action, type BashCommand, type ModeConfig } from "./rules.ts";

// Fakes only: nothing here reads an installed package, a real agent dir or the user's environment.
function fakeRuntime(overrides: Partial<PackageRuntime> = {}, action: Action | undefined = "deny"): PackageRuntime {
	const config: ModeConfig = { modes: { build: { permission: {} } }, defaultMode: "build" };
	return {
		loadModeConfig: () => config,
		functions: {
			getTreeSitterParser: () => ({ parse: () => [{ name: "cd", args: ["/elsewhere"], isNested: false }] }),
			expandShellCommands: (_parse, tree) => tree as BashCommand[],
			unwrapCommand: (c) => c,
			normalizeBashToken: (t) => t,
			tokenTarget: (t) => t,
			isOutside: () => true,
			sandboxAllowedRoots: () => [],
			insideRoots: () => [],
			resolveSurfaceDetailed: () => (action ? { action } : undefined),
			mostRestrictive: (...actions) => actions.find((a) => a === "deny") ?? actions.find((a) => a === "ask") ?? actions.find(Boolean),
		},
		...overrides,
	};
}

function fakeDeps(runtime: PackageRuntime | undefined, warnings: string[]): CwdGuardDeps {
	return { loadRuntime: async () => runtime, agentDir: () => "/fake/agent", env: () => ({}), warn: (m) => warnings.push(m) };
}

const bash = (command: string) => ({ toolName: "bash", input: { command } });

test("tool_call returns early for a non-bash tool", async () => {
	let loaded = false;
	const deps = { ...fakeDeps(fakeRuntime(), []), loadRuntime: async () => ((loaded = true), fakeRuntime()) };
	assert.equal(await makeToolCallHandler(deps)({ toolName: "read", input: {} }, { cwd: "/root" }), undefined);
	assert.equal(loaded, false);
});

test("tool_call blocks a denied crossing", async () => {
	const result = await makeToolCallHandler(fakeDeps(fakeRuntime(), []))(bash("cd /elsewhere"), { cwd: "/root" });
	assert.equal(result?.block, true);
});

test("tool_call passes through when the decision is not deny", async () => {
	const result = await makeToolCallHandler(fakeDeps(fakeRuntime({}, "ask"), []))(bash("cd /elsewhere"), { cwd: "/root" });
	assert.equal(result, undefined);
});

test("tool_call passes through with one warning when loadModeConfig throws", async () => {
	const warnings: string[] = [];
	const runtime = fakeRuntime({ loadModeConfig: () => { throw new Error("bad config"); } });
	assert.equal(await makeToolCallHandler(fakeDeps(runtime, warnings))(bash("cd /elsewhere"), { cwd: "/root" }), undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /bad config/);
});

test("tool_call passes through with one warning when parse throws", async () => {
	const warnings: string[] = [];
	const base = fakeRuntime();
	const runtime = fakeRuntime({ functions: { ...base.functions, getTreeSitterParser: () => ({ parse: () => { throw new Error("parse failed"); } }), expandShellCommands: (parse) => parse("x") as BashCommand[] } });
	assert.equal(await makeToolCallHandler(fakeDeps(runtime, warnings))(bash("cd /elsewhere"), { cwd: "/root" }), undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /parse failed/);
});

test("tool_call passes every command through when the package is unavailable", async () => {
	assert.equal(await makeToolCallHandler(fakeDeps(undefined, []))(bash("cd /elsewhere"), { cwd: "/root" }), undefined);
});

test("before_agent_start creates sections and the cwd_boundary key", async () => {
	const event: { systemPromptOptions: { sections?: Record<string, string> } } = { systemPromptOptions: {} };
	await makeBeforeAgentStartHandler(fakeDeps(fakeRuntime(), []))(event, { cwd: "/root" });
	assert.equal(PROMPT_SECTION, "cwd_boundary");
	assert.deepEqual(Object.keys(event.systemPromptOptions.sections ?? {}), ["cwd_boundary"]);
	assert.equal(event.systemPromptOptions.sections?.cwd_boundary, promptSectionText("/root"));
});

test("before_agent_start keeps existing sections and does not collide with permission-modes keys", async () => {
	const sections = { permission_mode: "a", permission_mode_docs: "b", permission_mode_steering: "c" };
	const event = { systemPromptOptions: { sections } };
	await makeBeforeAgentStartHandler(fakeDeps(fakeRuntime(), []))(event, { cwd: "/root" });
	assert.equal(sections.permission_mode, "a");
	assert.equal(sections.permission_mode_docs, "b");
	assert.equal(sections.permission_mode_steering, "c");
	assert.equal(Object.keys(sections).length, 4);
});

test("before_agent_start skips the section when the package is unavailable", async () => {
	const event: { systemPromptOptions: { sections?: Record<string, string> } } = { systemPromptOptions: {} };
	await makeBeforeAgentStartHandler(fakeDeps(undefined, []))(event, { cwd: "/root" });
	assert.equal(event.systemPromptOptions.sections, undefined);
});

test("defaultPackageRoot joins the agent directory with npm/node_modules/pi-permission-modes", () => {
	const agent = join(tmpdir(), "fake-agent");
	assert.equal(defaultPackageRoot(agent), join(agent, "npm", "node_modules", "pi-permission-modes"));
});

const fileFor = (root: string, file: string) => pathToFileURL(join(root, "src", file)).href;

/** Every name the loader checks for. A fake module must supply these as functions. */
const NAMED_EXPORTS = [
	"getTreeSitterParser", "expandShellCommands", "unwrapCommand",
	"loadModeConfig", "normalizeBashToken", "tokenTarget",
	"isOutside", "sandboxAllowedRoots", "insideRoots",
	"resolveSurfaceDetailed", "mostRestrictive",
];

/**
 * A fake module with exactly the given function exports. Do not use a Proxy here: its get trap answers
 * `then` too, so `await` on the fake is treated as a thenable and never settles.
 */
function fakeModule(names: readonly string[]) {
	const module: Record<string, unknown> = {};
	for (const name of names) module[name] = () => undefined;
	return module;
}

function recordingImporter(urls: string[]) {
	return async (fileUrl: string) => {
		urls.push(fileUrl);
		return fakeModule(NAMED_EXPORTS);
	};
}

test("runtime loader: a non-empty explicit root beats the default and never calls agentDir", async () => {
	const urls: string[] = [];
	const warnings: string[] = [];
	const explicit = join(tmpdir(), "explicit-root");
	let called = false;
	const agentDir = () => ((called = true), join(tmpdir(), "unused-agent"));
	const load = makeRuntimeLoader(() => ({ [PERMISSION_MODES_ROOT_ENV]: explicit }), agentDir, (m) => warnings.push(m), recordingImporter(urls));
	assert.ok(await load());
	assert.equal(called, false);
	assert.deepEqual(warnings, []);
	assert.ok(urls.includes(fileFor(explicit, "bash-parse.ts")));
	assert.ok(urls.every((u) => u.startsWith(pathToFileURL(join(explicit, "src")).href)));
});

for (const [label, make] of [
	["sync", (dir: string) => dir],
	["promise", (dir: string) => Promise.resolve(dir)],
] as const) {
	test(`runtime loader: derived default with a ${label} agentDir`, async () => {
		const urls: string[] = [];
		const warnings: string[] = [];
		const agent = join(tmpdir(), "fake-agent");
		const root = defaultPackageRoot(agent);
		const load = makeRuntimeLoader(() => ({}), () => make(agent), (m) => warnings.push(m), recordingImporter(urls));
		assert.ok(await load());
		assert.deepEqual(warnings, []);
		assert.deepEqual([...urls].sort(), ["bash-parse.ts", "config-load.ts", "heuristics.ts", "paths.ts", "resolve.ts"].map((f) => fileFor(root, f)).sort());
	});
}

test("runtime loader: an empty explicit root falls back to the derived default", async () => {
	const urls: string[] = [];
	const agent = join(tmpdir(), "fake-agent");
	const load = makeRuntimeLoader(() => ({ [PERMISSION_MODES_ROOT_ENV]: "" }), () => agent, () => {}, recordingImporter(urls));
	assert.ok(await load());
	assert.ok(urls.includes(fileFor(defaultPackageRoot(agent), "paths.ts")));
});

for (const [label, agentDir] of [
	["throwing", () => { throw new Error("no agent dir"); }],
	["rejecting", () => Promise.reject(new Error("no agent dir"))],
] as const) {
	test(`runtime loader: a ${label} agentDir fails open with one warning`, async () => {
		const warnings: string[] = [];
		const load = makeRuntimeLoader(() => ({}), agentDir, (m) => warnings.push(m), recordingImporter([]));
		assert.equal(await load(), undefined);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /derived default/);
		assert.equal(await load(), undefined);
		assert.equal(warnings.length, 1);
	});
}

test("runtime loader: a throwing importer fails open with one warning naming the derived default", async () => {
	const warnings: string[] = [];
	const load = makeRuntimeLoader(() => ({}), () => join(tmpdir(), "fake-agent"), (m) => warnings.push(m), async () => { throw new Error("boom"); });
	assert.equal(await load(), undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /derived default/);
});

test("runtime loader: a module missing a function export fails open with one warning naming the export and root", async () => {
	const warnings: string[] = [];
	const agent = join(tmpdir(), "fake-agent");
	const importer = async (fileUrl: string) => (fileUrl.endsWith("paths.ts") ? fakeModule(["isOutside"]) : fakeModule(NAMED_EXPORTS));
	const load = makeRuntimeLoader(() => ({}), () => agent, (m) => warnings.push(m), importer);
	assert.equal(await load(), undefined);
	assert.equal(await load(), undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /paths\.ts:sandboxAllowedRoots/);
	assert.match(warnings[0], /paths\.ts:insideRoots/);
	assert.ok(warnings[0].includes(defaultPackageRoot(agent)));
});

test("runtime loader: a module that resolves to a non-object names its exports as missing", async () => {
	const warnings: string[] = [];
	const agent = join(tmpdir(), "fake-agent");
	const importer = async (fileUrl: string) => (fileUrl.endsWith("paths.ts") ? null : fakeModule(NAMED_EXPORTS));
	const load = makeRuntimeLoader(() => ({}), () => agent, (m) => warnings.push(m), importer);
	assert.equal(await load(), undefined);
	// A non-object module must still name the exports, not fall through to the generic load failure.
	assert.match(warnings[0], /paths\.ts:isOutside, paths\.ts:sandboxAllowedRoots, paths\.ts:insideRoots/);
});

test("runtime loader warns once naming the derived root when it does not exist", async () => {
	const warnings: string[] = [];
	const agent = join(tmpdir(), "nonexistent-agent-dir");
	const load = makeRuntimeLoader(() => ({}), () => agent, (m) => warnings.push(m));
	assert.equal(await load(), undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /derived default/);
	assert.ok(warnings[0].includes(defaultPackageRoot(agent)));
	assert.equal(await load(), undefined);
	assert.equal(warnings.length, 1);
});

test("runtime loader warns once naming an explicit root that does not exist", async () => {
	const warnings: string[] = [];
	const explicit = join(tmpdir(), "nonexistent-explicit-root");
	const load = makeRuntimeLoader(() => ({ [PERMISSION_MODES_ROOT_ENV]: explicit }), () => join(tmpdir(), "unused-agent"), (m) => warnings.push(m));
	assert.equal(await load(), undefined);
	assert.equal(await load(), undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /explicit/);
	assert.ok(warnings[0].includes(explicit));
});

test("the default export registers both handlers without reading the package", () => {
	const events: string[] = [];
	cwdGuard({ on: (name: string) => events.push(name) } as never);
	assert.deepEqual(events, ["before_agent_start", "tool_call"]);
});
