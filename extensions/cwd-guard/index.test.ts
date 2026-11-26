import { test } from "node:test";
import assert from "node:assert/strict";
import cwdGuard, {
	PERMISSION_MODES_ROOT_ENV,
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

test("runtime loader logs once when the root is unset", async () => {
	const warnings: string[] = [];
	const load = makeRuntimeLoader(() => ({}), (m) => warnings.push(m));
	assert.equal(await load(), undefined);
	assert.equal(await load(), undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], new RegExp(PERMISSION_MODES_ROOT_ENV));
});

test("runtime loader logs once and does not throw when the root is moved", async () => {
	const warnings: string[] = [];
	const load = makeRuntimeLoader(() => ({ [PERMISSION_MODES_ROOT_ENV]: "/nonexistent/pi-permission-modes" }), (m) => warnings.push(m));
	assert.equal(await load(), undefined);
	assert.equal(await load(), undefined);
	assert.equal(warnings.length, 1);
});

test("the default export registers both handlers without reading the package", () => {
	const events: string[] = [];
	cwdGuard({ on: (name: string) => events.push(name) } as never);
	assert.deepEqual(events, ["before_agent_start", "tool_call"]);
});
