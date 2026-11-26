// Manual integration probe for the real pi-permission-modes composition. It never runs inside `just test`:
// the unit layer lists its files explicitly, and this file is run only by `just cwd-guard probe`.
// Only package code is read from PI_CWD_GUARD_PERMISSION_MODES_ROOT; the session root, agent dir, HOME and the
// mode config are temporary fixtures. The ported commands keep their text but run against the temporary root,
// so the crossing path is only text that names a directory outside that root: a per-fixture sibling of it.
// Expected outcomes are facts about the package's boundary semantics, not agreement with stubs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRuntimeLoader, makeToolCallHandler, PERMISSION_MODES_ROOT_ENV, type CwdGuardDeps, type PackageRuntime } from "./index.ts";
import { boundaryBlock, boundaryFindings, boundaryReason, parseCommands, type BoundaryFinding, type ModeDef, type PackageFunctions } from "./rules.ts";

const packageRoot = process.env[PERMISSION_MODES_ROOT_ENV];
const enabled = Boolean(packageRoot);

/** A mode that denies every path outside the session root. */
const GUARDED = "probe-guarded";
/** A mode that allows every path outside the session root. */
const OPEN = "probe-open";

const sandbox = { enabled: true, writable: true, allowWrite: ["."], denyWrite: [], denyRead: [], network: { allowedDomains: [], deniedDomains: [] } };

function modeConfig(): unknown {
	return {
		defaultMode: OPEN,
		modes: {
			[GUARDED]: { label: "Probe guarded", color: "muted", sandbox, permission: { path: { "*": "allow" }, external_directory: "deny", bash: { "*": "allow" } } },
			[OPEN]: { label: "Probe open", color: "muted", sandbox, permission: { path: { "*": "allow" }, external_directory: "allow", bash: { "*": "allow" } } },
		},
	};
}

interface Fixture {
	root: string;
	/** A directory beside the session root that need not exist; no prefix collision with `root`. */
	outside: string;
	agentDir: string;
	runtime: PackageRuntime;
	functions: PackageFunctions;
	guarded: ModeDef;
	warnings: string[];
}

/** Runs `body` with HOME, PI_CODING_AGENT_DIR and PI_PERMISSION_MODE under test control, and restores all
 * three afterwards. `mode` undefined leaves PI_PERMISSION_MODE unset. */
async function withFixture(mode: string | undefined, body: (fixture: Fixture) => Promise<void>): Promise<void> {
	const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_PERMISSION_MODE: process.env.PI_PERMISSION_MODE };
	const temp = await mkdtemp(join(tmpdir(), "cwd-guard-probe-"));
	try {
		const base = await realpath(temp);
		const root = join(base, "session");
		const agentDir = join(base, "agent");
		const home = join(base, "home");
		const outside = join(base, "outside");
		await mkdir(root);
		await mkdir(join(agentDir, "permission-mode"), { recursive: true });
		await mkdir(home);
		await writeFile(join(agentDir, "permission-mode", "permission-mode.json"), JSON.stringify(modeConfig()));
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		if (mode === undefined) delete process.env.PI_PERMISSION_MODE;
		else process.env.PI_PERMISSION_MODE = mode;
		const warnings: string[] = [];
		const runtime = await makeRuntimeLoader(() => process.env, () => agentDir, (message) => warnings.push(message))();
		assert.ok(runtime, `the package loads from ${PERMISSION_MODES_ROOT_ENV}: ${warnings.join("; ")}`);
		const config = runtime.loadModeConfig(root, agentDir);
		assert.deepEqual(warnings, []);
		await body({ root, outside, agentDir, runtime, functions: runtime.functions, guarded: config.modes[GUARDED], warnings });
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await rm(temp, { recursive: true, force: true });
	}
}

async function judge(fixture: Fixture, command: string, pkg: PackageFunctions = fixture.functions): Promise<{ findings: BoundaryFinding[]; reason: string | undefined }> {
	const findings = await boundaryFindings(command, fixture.root, fixture.guarded, pkg);
	return { findings, reason: boundaryBlock(findings, fixture.root)?.reason };
}

/** The same package functions with tree-sitter reported unavailable, which forces the documented fallback split. */
function withoutTreeSitter(pkg: PackageFunctions): PackageFunctions {
	return { ...pkg, getTreeSitterParser: () => undefined };
}

test("probe fixture: the package loads from the configured root and tree-sitter is available", { skip: !enabled }, async () => {
	await withFixture(GUARDED, async ({ functions, guarded }) => {
		assert.ok(await functions.getTreeSitterParser(), "tree-sitter loads; the wrapper-descent case depends on it");
		assert.equal((guarded.permission as { external_directory: unknown }).external_directory, "deny");
	});
});

test("ported: `cd <outside> && pwd` is a crossing the guarded mode denies, and blocks", { skip: !enabled }, async () => {
	await withFixture(GUARDED, async (fixture) => {
		const { findings, reason } = await judge(fixture, `cd ${fixture.outside} && pwd`);
		assert.deepEqual(findings, [{ name: "cd", argument: fixture.outside, target: fixture.outside, crossing: true, action: "deny" }]);
		assert.equal(reason, boundaryReason(fixture.root, fixture.outside));
	});
});

test("ported: `ls ./plan` names no directory command, so nothing is judged", { skip: !enabled }, async () => {
	await withFixture(GUARDED, async (fixture) => {
		assert.deepEqual(await judge(fixture, "ls ./plan"), { findings: [], reason: undefined });
	});
});

test("ported: `bash -c 'cd /tmp && ls'` is descended into and the inner cd is a denied crossing", { skip: !enabled }, async () => {
	await withFixture(GUARDED, async (fixture) => {
		const { findings, reason } = await judge(fixture, "bash -c 'cd /tmp && ls'");
		assert.deepEqual(findings, [{ name: "cd", argument: "/tmp", target: "/tmp", crossing: true, action: "deny" }]);
		assert.equal(reason, boundaryReason(fixture.root, "/tmp"));
	});
});

test("ported: `cd -` is reported as a stack reference, never guessed, and does not block", { skip: !enabled }, async () => {
	await withFixture(GUARDED, async (fixture) => {
		assert.deepEqual(await judge(fixture, "cd -"), { findings: [{ name: "cd", argument: "", stackTarget: true }], reason: undefined });
	});
});

test("ported: `git worktree list` and `git rev-parse --show-toplevel` are never read as escapes", { skip: !enabled }, async () => {
	await withFixture(GUARDED, async (fixture) => {
		assert.deepEqual(await judge(fixture, "git worktree list"), { findings: [], reason: undefined });
		assert.deepEqual(await judge(fixture, "git rev-parse --show-toplevel"), { findings: [], reason: undefined });
	});
});

test('ported: the unterminated quote `cd "<outside>` through the parser yields only cd findings and a block only for that path', { skip: !enabled }, async () => {
	await withFixture(GUARDED, async (fixture) => {
		const command = `cd "${fixture.outside}`;
		const { findings, reason } = await judge(fixture, command);
		// The package's tree-sitter recovery for a broken quote is not specified here: record what the parser path does.
		console.log(`unterminated quote, parser path: findings=${JSON.stringify(findings)} blocked=${reason !== undefined}`);
		for (const finding of findings) {
			assert.equal(finding.name, "cd");
			if (finding.target !== undefined) assert.equal(finding.target, fixture.outside);
		}
		if (reason !== undefined) assert.equal(reason, boundaryReason(fixture.root, fixture.outside));
		assert.ok((await parseCommands(command, fixture.functions)).every((c) => typeof c.name === "string"));
	});
});

test("ported: `((` never blocks", { skip: !enabled }, async () => {
	await withFixture(GUARDED, async (fixture) => {
		const { findings, reason } = await judge(fixture, "((");
		assert.equal(reason, undefined);
		assert.ok(findings.every((f) => f.action === undefined));
	});
});

test("ported: `cd ${UNKNOWN_DIR} && pwd` names no judgeable path, so it does not block", { skip: !enabled }, async () => {
	await withFixture(GUARDED, async (fixture) => {
		const { findings, reason } = await judge(fixture, "cd ${UNKNOWN_DIR} && pwd");
		assert.equal(reason, undefined);
		assert.ok(findings.length >= 1 && findings.every((f) => f.name === "cd" && f.target === undefined && f.action === undefined));
	});
});

test('ported: the fallback split judges the unterminated quote `cd "<outside>` as a denied crossing', { skip: !enabled }, async () => {
	await withFixture(GUARDED, async (fixture) => {
		const { findings, reason } = await judge(fixture, `cd "${fixture.outside}`, withoutTreeSitter(fixture.functions));
		assert.deepEqual(findings, [{ name: "cd", argument: fixture.outside, target: fixture.outside, crossing: true, action: "deny" }]);
		assert.equal(reason, boundaryReason(fixture.root, fixture.outside));
	});
});

test("new: with tree-sitter unavailable `cd <outside> && pwd` still blocks, and `bash -c 'cd /tmp && ls'` is not descended into", { skip: !enabled }, async () => {
	await withFixture(GUARDED, async (fixture) => {
		const noParser = withoutTreeSitter(fixture.functions);
		assert.equal((await judge(fixture, `cd ${fixture.outside} && pwd`, noParser)).reason, boundaryReason(fixture.root, fixture.outside));
		// The fallback split keeps a quoted script as one word, so the inner cd is invisible to the gate; the
		// package's own permission flow still sees it.
		assert.deepEqual(await judge(fixture, "bash -c 'cd /tmp && ls'", noParser), { findings: [], reason: undefined });
	});
});

/** The tool_call handler wired to the real package and the fixture, reading the live PI_PERMISSION_MODE. */
function liveHandler(fixture: Fixture) {
	const deps: CwdGuardDeps = { loadRuntime: async () => fixture.runtime, agentDir: () => fixture.agentDir, env: () => process.env, warn: (message) => fixture.warnings.push(message) };
	return makeToolCallHandler(deps);
}

const crossingCall = (fixture: Fixture) => ({ toolName: "bash", input: { command: `cd ${fixture.outside} && pwd` } });

test("new: live mode lookup — PI_PERMISSION_MODE naming the guarded mode wins over the open defaultMode and blocks", { skip: !enabled }, async () => {
	await withFixture(GUARDED, async (fixture) => {
		const result = await liveHandler(fixture)(crossingCall(fixture), { cwd: fixture.root });
		assert.deepEqual(result, { block: true, reason: boundaryReason(fixture.root, fixture.outside) });
		assert.deepEqual(fixture.warnings, []);
	});
});

test("new: live mode lookup — PI_PERMISSION_MODE naming the open mode lets the same command through", { skip: !enabled }, async () => {
	await withFixture(OPEN, async (fixture) => {
		assert.equal(await liveHandler(fixture)(crossingCall(fixture), { cwd: fixture.root }), undefined);
	});
});

test("new: live mode lookup — an unset PI_PERMISSION_MODE falls back to defaultMode (open) and lets it through", { skip: !enabled }, async () => {
	await withFixture(undefined, async (fixture) => {
		assert.equal(process.env.PI_PERMISSION_MODE, undefined);
		assert.equal(await liveHandler(fixture)(crossingCall(fixture), { cwd: fixture.root }), undefined);
	});
});

test("new: live mode lookup — an unknown PI_PERMISSION_MODE falls back to defaultMode (open) and lets it through", { skip: !enabled }, async () => {
	await withFixture("probe-no-such-mode", async (fixture) => {
		assert.equal(await liveHandler(fixture)(crossingCall(fixture), { cwd: fixture.root }), undefined);
	});
});

test("new: the probe restores PI_PERMISSION_MODE, HOME and PI_CODING_AGENT_DIR after a fixture run", { skip: !enabled }, async () => {
	const before = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_PERMISSION_MODE: process.env.PI_PERMISSION_MODE };
	await withFixture(GUARDED, async (fixture) => {
		assert.equal(process.env.PI_PERMISSION_MODE, GUARDED);
		assert.equal(process.env.PI_CODING_AGENT_DIR, fixture.agentDir);
	});
	assert.deepEqual({ HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_PERMISSION_MODE: process.env.PI_PERMISSION_MODE }, before);
});
