import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	boundaryAction,
	boundaryBlock,
	boundaryFindings,
	boundaryReason,
	commandsWithoutParser,
	judgeCommands,
	promptSectionText,
	resolveMode,
	type Action,
	type BashCommand,
	type BoundaryFinding,
	type ModeConfig,
	type ModeDef,
	type PackageFunctions,
} from "./rules.ts";

// Every package function here is a canned fake: these tests prove this repository's glue only. Boundary
// semantics and wrapper descent belong to the package and are checked by the manual probe.
const RANK: Record<Action, number> = { allow: 0, ask: 1, deny: 2 };

function cannedPackage(overrides: Partial<PackageFunctions> = {}, commands: BashCommand[] | undefined = undefined): PackageFunctions {
	return {
		getTreeSitterParser: () => (commands ? { parse: () => commands } : undefined),
		expandShellCommands: (_parse, tree) => tree as BashCommand[],
		unwrapCommand: (command) => command,
		normalizeBashToken: (token) => token.replace(/^["']|["']$/g, ""),
		tokenTarget: (token) => (token.startsWith("/") ? token : undefined),
		isOutside: (root, target) => !target.startsWith(root),
		sandboxAllowedRoots: () => [],
		insideRoots: () => [],
		resolveSurfaceDetailed: () => undefined,
		mostRestrictive: (...actions) => actions.filter((a): a is Action => a !== undefined).sort((a, b) => RANK[b] - RANK[a])[0],
		...overrides,
	};
}

const mode: ModeDef = { permission: { path: "base-path", external_directory: "base-external" } };
const cmd = (name: string, ...args: string[]): BashCommand => ({ name, args, isNested: false });

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "cwd-guard-rules-"));
	try { await body(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("canned parser: cd - and popd +2 are reported as stack references, never guessed", async () => {
	await withRoot(async (root) => {
		const pkg = cannedPackage({}, [cmd("cd", "-"), cmd("popd", "+2"), cmd("pushd", "-1")]);
		const findings = await boundaryFindings("ignored", root, mode, pkg);
		assert.deepEqual(findings.map((f) => [f.name, f.stackTarget, f.argument, f.target]), [
			["cd", true, "", undefined],
			["popd", true, "", undefined],
			["pushd", true, "", undefined],
		]);
	});
});

test("canned parser: flags are skipped and popd is never judged as a path", async () => {
	await withRoot(async (root) => {
		const judged: string[] = [];
		const pkg = cannedPackage({ tokenTarget: (token) => { judged.push(token); return token.startsWith("/") ? token : undefined; } });
		const findings = judgeCommands([cmd("cd", "-L", "-P", "/elsewhere/dir"), cmd("popd", "/elsewhere/other"), cmd("chdir", "-n", "relative")], root, mode, pkg);
		assert.deepEqual(judged, ["/elsewhere/dir", "relative"]);
		assert.equal(findings[0].argument, "/elsewhere/dir");
		assert.equal(findings[0].crossing, true);
		assert.equal(findings[1].argument, "");
		assert.equal(findings[1].target, undefined);
		assert.equal(findings[2].target, undefined);
	});
});

test("canned parser: non-directory heads are ignored and the unwrapped head is judged", async () => {
	await withRoot(async (root) => {
		const pkg = cannedPackage({ unwrapCommand: (c) => (c.name === "env" ? cmd("cd", "/elsewhere") : c) });
		const findings = judgeCommands([cmd("ls", "/elsewhere"), cmd("env", "cd", "/elsewhere"), cmd("/usr/bin/cd", "/x")], root, mode, pkg);
		assert.deepEqual(findings.map((f) => f.name), ["cd", "cd"]);
	});
});

test("null parser: stack references and popd go through the fallback splitter", async () => {
	await withRoot(async (root) => {
		const pkg = cannedPackage();
		const findings = await boundaryFindings("cd - && popd +2; popd /elsewhere", root, mode, pkg);
		assert.deepEqual(findings.map((f) => [f.name, f.stackTarget === true, f.argument]), [
			["cd", true, ""],
			["popd", true, ""],
			["popd", false, ""],
		]);
	});
});

test("fallback splitter tracks quote spans, including an unterminated quote", () => {
	assert.deepEqual(commandsWithoutParser('echo "a; cd /x" ; cd /y').map((c) => c.name), ["echo", "cd"]);
	assert.deepEqual(commandsWithoutParser('echo "a; cd /x" ; cd /y')[1].args, ["/y"]);
	assert.deepEqual(commandsWithoutParser('cd "/srv/git'), [{ name: "cd", args: ['"/srv/git'], isNested: false }]);
});

test("fallback splitter skips heredoc bodies and keeps the command after them", () => {
	const commands = commandsWithoutParser("cat <<EOF\ncd /inside-body\nEOF\ncd /after");
	assert.deepEqual(commands.map((c) => [c.name, c.args]), [["cat", ["<<EOF"]], ["cd", ["/after"]]]);
	const tabbed = commandsWithoutParser("cat <<-EOF\n\tcd /body\n\tEOF\nls");
	assert.deepEqual(tabbed.map((c) => c.name), ["cat", "ls"]);
	assert.deepEqual(commandsWithoutParser("cat <<< cd").map((c) => c.name), ["cat"]);
});

test("fallback splitter skips redirection-leading segments and assignment prefixes", () => {
	assert.deepEqual(commandsWithoutParser(">out cd /x; 2>/dev/null ls").map((c) => c.name), []);
	assert.deepEqual(commandsWithoutParser("A=1 B=2 cd /x").map((c) => [c.name, c.args]), [["cd", ["/x"]]]);
	assert.deepEqual(commandsWithoutParser("A=1").map((c) => c.name), []);
});

test("canned action: only a denied crossing blocks; ask, allow and non-crossings pass", () => {
	const root = "/session/root";
	const finding = (action: Action | undefined, crossing = true): BoundaryFinding => ({ name: "cd", argument: "/out", target: "/out", crossing, action });
	assert.deepEqual(boundaryBlock([finding("deny")], root), { block: true, reason: boundaryReason(root, "/out") });
	assert.equal(boundaryBlock([finding("ask")], root), undefined);
	assert.equal(boundaryBlock([finding("allow")], root), undefined);
	assert.equal(boundaryBlock([finding(undefined, false)], root), undefined);
	assert.equal(boundaryBlock([{ name: "cd", argument: "", action: "deny" }], root), undefined);
	assert.equal(boundaryBlock([finding("allow"), finding("deny")], root)?.block, true);
});

test("canned decision: a crossing gets an action and a non-crossing does not", async () => {
	await withRoot(async (root) => {
		const pkg = cannedPackage({ resolveSurfaceDetailed: () => ({ action: "deny" }) });
		const [outside, inside] = judgeCommands([cmd("cd", "/elsewhere"), cmd("cd", join(root, "sub"))], root, mode, pkg);
		assert.equal(outside.crossing, true);
		assert.equal(outside.action, "deny");
		assert.equal(inside.crossing, false);
		assert.equal(inside.action, undefined);
	});
});

test("reason text and prompt-section text are stable for a fixed root", () => {
	const root = "/fixed/root";
	assert.equal(boundaryReason(root, "/fixed/out"), "outside the session working directory /fixed/root; run this with an absolute path inside it (/fixed/out is outside). A cd affects only this command.");
	assert.equal(promptSectionText(root), promptSectionText(root));
	const lines = promptSectionText(root).split("\n");
	assert.equal(lines.length, 4);
	assert.equal(lines[0], "The session working directory is /fixed/root. When the session started in .worktrees/<branch>, that worktree is the session working directory.");
	assert.equal(lines[1], "Shell cwd never persists between calls: a cd applies to that one command.");
	assert.equal(lines[2], "Relative paths resolve from the session working directory. Use absolute paths inside it.");
});

test("prompt statement 4 is original wording, not the awareness.ts:270 sentence", () => {
	const statement4 = promptSectionText("/r").split("\n")[3];
	for (const phrase of ["Commands beyond these boundaries", "still fine to issue", "permission is asked for them automatically", "run outside the sandbox", "out-of-boundary work"]) {
		assert.ok(!statement4.includes(phrase), phrase);
	}
	assert.match(statement4, /guard refuses/);
});

test("resolveMode with fakes: the PI_PERMISSION_MODE name wins", () => {
	const a: ModeDef = { permission: {} };
	const b: ModeDef = { permission: {} };
	const config: ModeConfig = { modes: { build: a, plan: b }, defaultMode: "build" };
	assert.equal(resolveMode({ PI_PERMISSION_MODE: "plan" }, config), b);
});

test("resolveMode with fakes: unset or unknown name falls back to config.defaultMode", () => {
	const a: ModeDef = { permission: {} };
	const config: ModeConfig = { modes: { build: a }, defaultMode: "build" };
	assert.equal(resolveMode({}, config), a);
	assert.equal(resolveMode({ PI_PERMISSION_MODE: "nope" }, config), a);
	assert.equal(resolveMode({ PI_PERMISSION_MODE: "" }, config), a);
	assert.equal(resolveMode({ PI_PERMISSION_MODE: "toString" }, config), a);
});

test("resolveMode with fakes: a missing mode returns nothing", () => {
	assert.equal(resolveMode({ PI_PERMISSION_MODE: "x" }, { modes: {}, defaultMode: "build" }), undefined);
	assert.equal(resolveMode({}, { modes: { other: { permission: {} } }, defaultMode: "build" }), undefined);
});

test("canned mostRestrictive: project overlay ordering is deny > ask > none across base policy and overlay", () => {
	const surfaces: Record<string, Action | undefined> = {};
	const pkg = cannedPackage({ resolveSurfaceDetailed: (surface) => { const action = surfaces[surface as string]; return action ? { action } : undefined; } });
	const withOverlay: ModeDef = { permission: { path: "bp", external_directory: "be" }, projectOverlay: { path: "op", external_directory: "oe" } };
	const set = (values: Record<string, Action | undefined>) => { for (const key of ["bp", "be", "op", "oe"]) surfaces[key] = values[key]; };

	set({});
	assert.equal(boundaryAction(withOverlay, "/t", pkg), undefined);
	set({ be: "ask" });
	assert.equal(boundaryAction(withOverlay, "/t", pkg), "ask");
	set({ be: "ask", oe: "deny" });
	assert.equal(boundaryAction(withOverlay, "/t", pkg), "deny");
	set({ bp: "deny", oe: "ask" });
	assert.equal(boundaryAction(withOverlay, "/t", pkg), "deny");
	set({ op: "ask" });
	assert.equal(boundaryAction(withOverlay, "/t", pkg), "ask");
	set({ op: "deny" });
	assert.equal(boundaryAction({ permission: { path: "bp", external_directory: "be" } }, "/t", pkg), undefined, "no overlay: overlay surfaces are not consulted");
});
