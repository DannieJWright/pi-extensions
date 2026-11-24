import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { devNull, homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveFiles, run } from "./generate.ts";
import { checkReadScope, isInScope, repositoryRoot, resolveWithinScope, standInHomeRoot, withEnv } from "./test-harness.ts";

const repo = repositoryRoot;
const sample = join(repo, "configs/permissions.example.src.jsonc");
const gitTools = ["git_r_diff", "git_r_status", "git_r_log", "git_r_show"];
const ledgerTools = ["ledger_check", "ledger_list", "ledger_next", "ledger_start", "ledger_submit"];

// The example source resolves its prompt references relative to itself, so generation runs on the source in place and
// writes every output into the disposable directory. No prompt body is copied anywhere, and nothing here reads an installed package.
async function deploy(dir: string) {
  const options = { src: sample, out: join(dir, "modes.json"), state: join(dir, "state.json"), settings: join(dir, "settings.json"), subagentsState: join(dir, "subagents-state.json"), subagentConfig: join(dir, "extensions/subagent/config.json") };
  assert.equal((await run({ ...options, action: "gen" })).status, "wrote");
  assert.equal((await run({ ...options, action: "check" })).status, "clean");
  return options;
}

// Golden-fixture comparison. The fixture records a digest marker plus the reference exactly as authored in the source
// configuration instead of a prompt body, so no layer holds duplicated text. This replaces the former perm check group:
// `just test` runs this module as the "perm sample test" group because it reads configuration files, separately from the
// pure generator tests, which are reported as "perm generator test".
const fixture = new URL("./sample.expected.json", import.meta.url);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isMarker = (value: unknown) => isObject(value) && typeof value["$digest"] === "string";
/** Hash a value verbatim when it is a string, otherwise through its JSON form. */
const digestOf = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

/** Collect the fixture's markers with their key paths, so a test can say which value form each recorded position uses. */
function markersIn(expected: unknown, keyPath = ""): Array<{ keyPath: string; marker: Record<string, unknown> }> {
	if (isMarker(expected)) return [{ keyPath: keyPath || "(root)", marker: expected }];
	if (Array.isArray(expected)) return expected.flatMap((item, index) => markersIn(item, `${keyPath}[${index}]`));
	if (isObject(expected)) return Object.entries(expected).flatMap(([key, child]) => markersIn(child, keyPath ? `${keyPath}.${key}` : key));
	return [];
}

/** Compare the generated output with the fixture. Normalization follows the fixture's markers, not a length heuristic. Every recorded reference must stay inside the repository or the declared stand-in home root. */
function compareFixture(actual: unknown, expected: unknown, sourceFile: string, homeRoot: string, keyPath = ""): void {
  const here = keyPath || "(root)";
  if (isMarker(expected)) {
    assert.ok(expected["$reference"] !== undefined, `${here}: marker does not record the reference as authored`);
    // A marked key path present in the fixture but absent from the generated output has nothing to hash; name the key path and the recorded reference instead of hashing undefined.
    if (actual === undefined) assert.fail(`${here}: the generated output has no value at this key path; the fixture records ${JSON.stringify(expected["$reference"])}.`);
    checkReadScope(expected["$reference"], sourceFile, here, homeRoot);
    // A stored digest must match what the recorded reference resolves to through the resolver, so a changed reference list fails too.
    const fromReference = digestOf(resolveFiles(expected["$reference"], sourceFile, here, homeRoot));
    const fromOutput = digestOf(actual);
    if (fromOutput !== expected["$digest"] || fromReference !== expected["$digest"]) {
      assert.fail(`${here}: digest mismatch for ${JSON.stringify(expected["$reference"])}. The fixture records ${expected["$digest"]}, the reference resolves to a value hashing to ${fromReference}, and the generated output at this key path hashes to ${fromOutput}.`);
    }
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${here}: expected an array`);
    assert.equal(actual.length, expected.length, `${here}: different number of entries`);
    expected.forEach((item, index) => compareFixture(actual[index], item, sourceFile, homeRoot, `${here}[${index}]`));
    return;
  }
  if (isObject(expected)) {
    assert.ok(isObject(actual), `${here}: expected an object`);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${here}: different keys`);
    for (const [key, child] of Object.entries(expected)) compareFixture(actual[key], child, sourceFile, homeRoot, keyPath ? `${keyPath}.${key}` : key);
    return;
  }
  assert.equal(actual, expected, `${here}: differs from the fixture`);
}

test("golden fixture compares prompt bodies by digest marker and keeps every other value exact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "permissions-sample-fixture-"));
  try {
    const paths = await deploy(dir); // gen then check, both asserted inside deploy
    const generated = JSON.parse(await readFile(paths.out, "utf8")) as Record<string, unknown>;
    // The header assertion stays exact-equality: nothing new is written to $comment.
    assert.equal(generated.$comment, "Generated from permissions.src.jsonc. Do not edit this file by hand.");
    const { $comment, ...actual } = generated;
    // The comparison resolves through this group's own stand-in root instead of the machine's home.
    const home = standInHomeRoot(dir);
    const expected = JSON.parse(await readFile(fixture, "utf8"));
    compareFixture(actual, expected, sample, home);
    // Coverage for the object value form must come from the committed fixture itself, not only from unit tests: a compared position records an object reference whose entry strips frontmatter, and its stored digest reproduces through the stand-in root.
    const objectForm = markersIn(expected).filter(({ marker }) => isObject(marker["$reference"]) && Array.isArray(marker["$reference"]["files"]) && marker["$reference"]["files"].some((entry) => isObject(entry) && entry["stripFrontmatter"] === true));
    assert.ok(objectForm.length > 0, "the committed fixture records no object-form reference with stripFrontmatter true at a compared position");
    for (const { keyPath, marker } of objectForm) {
      checkReadScope(marker["$reference"], sample, keyPath, home);
      assert.equal(digestOf(resolveFiles(marker["$reference"], sample, keyPath, home)), marker["$digest"], `${keyPath}: the stored digest does not reproduce from the stand-in root`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("markers are driven by the fixture and fail on a wrong digest or a changed reference list", async () => {
  // This test authors its own fixture files; only the committed-fixture comparison reads sample.expected.json.
  const dir = await mkdtemp(join(tmpdir(), "permissions-marker-"));
  try {
    // Fixture content is authored inside this group's declared stand-in root, so nothing here depends on the real user home.
    const home = standInHomeRoot(dir, { "prompts/first.md": "first prompt\n", "prompts/second.md": "---\ntitle: second\n---\nsecond prompt\n" });
    const src = join(home, "marker.src.jsonc");
    const first = { "$file": "prompts/first.md" };
    const second = { "$file": "prompts/second.md", stripFrontmatter: true };
    const keyPath = "modes.plan.systemPrompt";
    const resolvedFirst = resolveFiles(first, src, keyPath, home) as string;
    const marker = { "$digest": digestOf(resolvedFirst), "$reference": first };
    checkReadScope(first, src, keyPath, home);
    compareFixture(resolvedFirst, marker, src, home, keyPath);
    // A wrong digest names the key path, the recorded reference, and both digests.
    const wrongDigest = `${resolvedFirst}extra text`;
    let failure = "";
    try { compareFixture(wrongDigest, marker, src, home, keyPath); } catch (error) { failure = (error as Error).message; }
    for (const part of [keyPath, JSON.stringify(first), marker["$digest"], digestOf(wrongDigest)]) assert.ok(failure.includes(part), `the failure must name ${part}: ${failure}`);
    // A plain value authored inline in the source is recorded verbatim as its own reference.
    const inline = "prompt written inline in the source configuration";
    const inlineMarker = { "$digest": digestOf(inline), "$reference": inline };
    compareFixture(inline, inlineMarker, src, home, keyPath);
    assert.throws(() => compareFixture(`${inline}changed`, inlineMarker, src, home, keyPath), /digest mismatch/);
    // The stored digest can still be right while the reference list has changed to another file.
    assert.throws(() => compareFixture(resolvedFirst, { "$digest": digestOf(resolvedFirst), "$reference": second }, src, home, keyPath), /digest mismatch/);
    // An object-form reference that mixes a file and inline text is recorded as its own reference, and its failure names the same three things.
    const objectForm = { files: [{ path: "prompts/second.md", stripFrontmatter: true }], text: "inline text in the same value" };
    const resolvedObjectForm = resolveWithinScope(objectForm, src, keyPath, home) as string;
    const objectMarker = { "$digest": digestOf(resolvedObjectForm), "$reference": objectForm };
    compareFixture(resolvedObjectForm, objectMarker, src, home, keyPath);
    let objectFailure = "";
    try { compareFixture(`${resolvedObjectForm}changed`, objectMarker, src, home, keyPath); } catch (error) { objectFailure = (error as Error).message; }
    for (const part of [keyPath, JSON.stringify(objectForm), objectMarker["$digest"], digestOf(`${resolvedObjectForm}changed`)]) assert.ok(objectFailure.includes(part), `the object-form failure must name ${part}: ${objectFailure}`);
    assert.throws(() => compareFixture(resolvedFirst, { "$digest": digestOf(resolvedFirst) }, src, home, keyPath), /does not record the reference/);
    // A marker whose key path is absent from the generated output fails naming the key path and the recorded reference instead of hashing undefined.
    let absentFailure = "";
    try { compareFixture(undefined, marker, src, home, keyPath); } catch (error) { absentFailure = (error as Error).message; }
    for (const part of [keyPath, JSON.stringify(first)]) assert.ok(absentFailure.includes(part), `the absence failure must name ${part}: ${absentFailure}`);
    // A recorded reference outside both roots fails naming the key path and the reference before any comparison happens.
    for (const raw of ["/outside-this-run/outside.md", "../outside-the-stand-in-root.md"]) {
      let scopeFailure = "";
      try { compareFixture("anything", { "$digest": digestOf("anything"), "$reference": { $file: raw } }, src, home, keyPath); } catch (error) { scopeFailure = (error as Error).message; }
      for (const part of [keyPath, JSON.stringify(raw)]) assert.ok(scopeFailure.includes(part), `the read-scope failure must name ${part}: ${scopeFailure}`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("deployed sample composes agents, prompt, and mode policies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "permissions-sample-"));
  try {
    const paths = await deploy(dir);
    const modes = JSON.parse(await readFile(paths.out, "utf8")).modes;
    const overrides = JSON.parse(await readFile(paths.settings, "utf8")).subagents.agentOverrides;
    const builtin = {
      reviewer: ["read", "grep", "find", "ls", "watchdog_diff", "contact_supervisor"],
      scout: ["read", "grep", "find", "ls", "bash", "write", "contact_supervisor"],
      worker: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"],
    };
    for (const [name, tools] of Object.entries(builtin)) {
      assert.deepEqual(new Set(overrides[name].tools), new Set([...tools, ...gitTools, ...(name === "worker" ? ledgerTools : [])]));
      assert.ok(overrides[name].subagentOnlyExtensions.some((p: string) => p.endsWith("/git-tools/index.ts")));
    }
    assert.deepEqual(overrides.worker.mutationTools, ["ledger_start", "ledger_submit"]);
    assert.ok(overrides.worker.subagentOnlyExtensions.some((p: string) => p.endsWith("/feature-ledger/index.ts")));
    // Each required phrase is asserted on its own, so order inside a line does not matter, and no full body is asserted.
    // Every message names the referenced file the phrase comes from, so the run shows which part contributed what.
    const prompt = overrides.reviewer.systemPrompt;
    const agentFixture = join(repo, "extensions/permission-mode-generator/test-fixtures/agents/agent-with-frontmatter.md");
    const addendum = join(repo, "configs/prompts/reviewer-addendum.md");
    for (const [phrase, origin] of [["test fixture", agentFixture], ["git_r_diff", addendum], ['mode: "range"', addendum]] as const) {
      assert.ok(prompt.includes(phrase), `${origin}: the assembled prompt must contain ${JSON.stringify(phrase)}`);
    }
    // Every entry in the sample carries stripFrontmatter, so no frontmatter block reaches the assembled prompt; the
    // group below proves that an entry without the flag keeps it, which is why the flag is needed here.
    assert.ok(!prompt.includes("name: illustrative-agent"), `${agentFixture}: frontmatter appears only for entries without the flag`);
    for (const name of ["default", "plan", "plan-local", "build", "build-local", "build-yolo"]) {
      assert.equal(modes[name].permission.tool["git_r_*"], "allow");
      for (const tool of ["ledger_check", "ledger_list", "ledger_next"]) assert.equal(modes[name].permission.tool[tool], "allow");
    }
    for (const name of ["plan", "plan-local"]) for (const tool of ["ledger_start", "ledger_submit"]) assert.equal(modes[name].permission.tool[tool], "deny");
    for (const name of ["build", "build-local", "build-yolo"]) for (const tool of ["ledger_start", "ledger_submit"]) assert.equal(modes[name].permission.tool[tool], "allow");
    for (const tool of ["ledger_start", "ledger_submit"]) assert.equal(modes.default.permission.tool[tool], undefined);
    assert.equal(modes.default.permission.tool["*"], "ask");
    assert.equal(modes.yolo.permission.tool, "allow");
    await assert.rejects(readFile(paths.subagentConfig, "utf8"), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// The prompt-assembly groups read only the agent fixtures this repository owns or content inside their own declared stand-in root, so results do not depend on what is installed.
test("frontmatter appears only for entries without the flag, using the fixtures the sample references", async () => {
  // Entries name the fixtures relative to the source file, as the sample configuration does.
  const dir = await mkdtemp(join(tmpdir(), "permissions-read-scope-"));
  const home = standInHomeRoot(dir, { "in-scope.md": "inside the declared root\n" });
  const sourceFile = join(repo, "configs", "permissions.example.src.jsonc");
  const assemble = (files: unknown[]) => (resolveWithinScope({ subagents: { agents: { worker: { systemPrompt: { files } } } } }, sourceFile, "", home) as Record<string, any>).subagents.agents.worker.systemPrompt;
  const trimmed = (text: string) => text.replace(/\s+$/, ""); // trailing whitespace at a join boundary is normalized
  const relWith = "../extensions/permission-mode-generator/test-fixtures/agents/agent-with-frontmatter.md";
  const relWithout = "../extensions/permission-mode-generator/test-fixtures/agents/agent-without-frontmatter.md";
  const withFrontmatter = resolve(dirname(sourceFile), relWith);
  const withoutFrontmatter = resolve(dirname(sourceFile), relWithout);
  const rawWith = await readFile(withFrontmatter, "utf8");
  const rawWithout = await readFile(withoutFrontmatter, "utf8");
  assert.ok(rawWith.startsWith("---\n"));     // one fixture really has a frontmatter block
  assert.ok(!rawWithout.startsWith("---\n")); // and the other does not

  const reads: string[] = [];
  const originalRead = fs.readFileSync;
  fs.readFileSync = ((file: unknown, ...args: unknown[]) => { if (typeof file === "string") reads.push(file); return (originalRead as any)(file, ...args); }) as typeof fs.readFileSync;
  try {
    // The same real file through two entries: the flagged entry loses its --- block, the unflagged entry keeps it.
    const kept = assemble([{ path: relWith }]);
    const stripped = assemble([{ path: relWith, stripFrontmatter: true }]);
    assert.equal(kept, trimmed(rawWith));
    assert.ok(kept.startsWith("---\nname: illustrative-agent"));
    assert.equal(stripped, trimmed(rawWith.slice(rawWith.indexOf("\n---\n", 1) + 5)));
    assert.ok(!stripped.includes("name: illustrative-agent"));
    // A fixture with no frontmatter is returned verbatim either way.
    assert.equal(assemble([{ path: relWithout, stripFrontmatter: true }]), trimmed(rawWithout));
    // Every reference resolved into this repository's own fixture directory, which is inside the allowed roots.
    for (const read of reads) assert.ok(isInScope(read, [repo, home]), `the resolver opened ${read} outside the repository or the declared stand-in root`);
    assert.deepEqual([...new Set(reads)].sort(), [withFrontmatter, withoutFrontmatter].sort());
  } finally { fs.readFileSync = originalRead; await rm(dir, { recursive: true, force: true }); }
});

const piRoot = process.env.PI_PACKAGE_DIR;
const subRoot = process.env.PI_GIT_TOOLS_SUBAGENTS_ROOT;
const permRoot = process.env.PI_GIT_TOOLS_PERMISSION_MODES_ROOT;

test("foreground child launch without ambient extension does not impose sample mode rules", { skip: !(piRoot && subRoot) && "set PI_PACKAGE_DIR and PI_GIT_TOOLS_SUBAGENTS_ROOT" }, async () => {
  const pi = await import(pathToFileURL(join(piRoot!, "dist/index.js")).href);
  const launchApi = await import(pathToFileURL(join(subRoot!, "src/runs/shared/child-launch.js")).href);
  const permissions = await import(pathToFileURL(join(subRoot!, "src/runs/shared/permissions.js")).href);
  const dir = await mkdtemp(join(tmpdir(), "permissions-foreground-"));
  let session: any;
  try {
    const cwd = join(dir, "repo"), agentDir = join(dir, "agent"), home = join(dir, "home");
    await mkdir(cwd); await mkdir(agentDir); await mkdir(home);
    // An opt-in runtime probe needs an environment root, so it uses the shared env helper rather than a declared home root.
    await withEnv({ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir }, async () => {
      assert.equal(homedir(), home);   // the settings default paths follow the disposable home
      const paths = await deploy(agentDir);
      const worker = JSON.parse(await readFile(paths.settings, "utf8")).subagents.agentOverrides.worker;
      const rules = permissions.resolvePermissionRules(undefined, worker.permissions);
      const target = join(home, ".pi/agent/git/github.com/DannieJWright/pi-extensions/extensions");
      await mkdir(target, { recursive: true });
      await symlink(join(repo, "extensions/git-tools"), join(target, "git-tools"), "junction");
      await symlink(join(repo, "extensions/feature-ledger"), join(target, "feature-ledger"), "junction");
      const launch = launchApi.buildInProcessChildLaunch({ host: "parent", cwd, childAgentName: "worker", childIndex: 0, sessionEnabled: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, tools: worker.tools, subagentOnlyExtensions: worker.subagentOnlyExtensions, permissionRules: rules });
      assert.equal(launch.session.ambientExtensions, false);
      assert.equal(launch.config.permissions, undefined);
      const settingsManager = pi.SettingsManager.create(cwd, agentDir);
      const loader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: launch.session.extensionPaths, extensionFactories: launch.session.hooks });
      await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
      ({ session } = await pi.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: pi.SessionManager.inMemory(cwd), tools: launch.session.tools }));
      pi.initTheme(settingsManager.getTheme()); session.extensionRunner.onError((error: unknown) => { throw error; });
      await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
      for (const name of ledgerTools) {
        assert.ok(session.getActiveToolNames().includes(name), name);
        const decision = await session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: name, toolName: name, input: { path: join(cwd, "ledger.yaml") } });
        assert.notEqual(decision?.block, true, name);
      }
      const readDecision = await session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "git_r_status", toolName: "git_r_status", input: {} });
      assert.notEqual(readDecision?.block, true);
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); session = undefined;
    });
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("detached subprocess exercises background launch and generated Build permissions", { skip: !(piRoot && subRoot && permRoot) && "set all three runtime package roots" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "permissions-detached-probe-"));
  try {
    const cwd = join(dir, "repo"), agentDir = join(dir, "agent"), home = join(dir, "home");
    await mkdir(cwd); await mkdir(agentDir); await mkdir(home);
    const paths = await deploy(agentDir);
    const settings = JSON.parse(await readFile(paths.settings, "utf8"));
    settings.extensions = [join(repo, "extensions/git-tools/index.ts"), join(repo, "extensions/feature-ledger/index.ts"), join(permRoot!, "src/index.ts")];
    await writeFile(paths.settings, JSON.stringify(settings));
    await mkdir(join(agentDir, "permission-mode"));
    const modeConfig = JSON.parse(await readFile(paths.out, "utf8"));
    for (const mode of Object.values(modeConfig.modes) as any[]) mode.sandbox.enabled = false;
    await writeFile(join(agentDir, "permission-mode/permission-mode.json"), JSON.stringify(modeConfig));
    const target = join(home, ".pi/agent/git/github.com/DannieJWright/pi-extensions/extensions");
    await mkdir(target, { recursive: true });
    await symlink(join(repo, "extensions/git-tools"), join(target, "git-tools"), "junction");
    await symlink(join(repo, "extensions/feature-ledger"), join(target, "feature-ledger"), "junction");
    execFileSync(process.execPath, [join(repo, "extensions/permission-mode-generator/detached-hook-probe.ts"), cwd, agentDir, piRoot!, subRoot!], {
      cwd, detached: process.platform !== "win32", timeout: 30000, stdio: "pipe",
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_PACKAGE_DIR: piRoot!, PI_PERMISSION_MODE: "build", PI_PERMISSION_TMPDIR: dir, TMPDIR: dir, TMP: dir, TEMP: dir },
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("permission-mode loader and direct ledger provider calls use disposable ledger", { skip: !(piRoot && subRoot && permRoot) && "set all three runtime package roots (see README)" }, async () => {
  const pi = await import(pathToFileURL(join(piRoot!, "dist/index.js")).href);
  const sub = await import(pathToFileURL(join(subRoot!, "src/runs/shared/child-tool-plan.js")).href);
  const dir = await mkdtemp(join(tmpdir(), "permissions-worker-"));
  const cwd = join(dir, "repo"), agentDir = join(dir, "agent"), home = join(dir, "home"), scratch = join(dir, "scratch");
  const names = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_PERMISSION_MODE", "PI_PERMISSION_TMPDIR", "PI_LEDGER_PATH", "CLAUDE_CODE_TMPDIR", "CLAUDE_TMPDIR"];
  // Ledger provider subprocesses inherit process.env as well as direct fixture Git calls.
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("GIT_")));
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  let session: any;
  try {
    await mkdir(cwd); await mkdir(agentDir); await mkdir(home); await mkdir(scratch); await mkdir(join(agentDir, "permission-mode"));
    for (const name of Object.keys(gitEnv)) delete process.env[name];
    delete process.env.PI_LEDGER_PATH;
    process.env.HOME = home; process.env.USERPROFILE = home; process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_PERMISSION_TMPDIR = scratch;
    assert.equal(homedir(), home);
    const paths = await deploy(agentDir);
    const settings = JSON.parse(await readFile(paths.settings, "utf8"));
    const worker = settings.subagents.agentOverrides.worker;
    settings.extensions = [join(repo, "extensions/git-tools/index.ts"), join(repo, "extensions/feature-ledger/index.ts")];
    await writeFile(paths.settings, JSON.stringify(settings));
    Object.assign(process.env, { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@localhost", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@localhost", GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" });
    const target = join(home, ".pi/agent/git/github.com/DannieJWright/pi-extensions/extensions");
    await mkdir(target, { recursive: true });
    await symlink(join(repo, "extensions/git-tools"), join(target, "git-tools"), "junction");
    await symlink(join(repo, "extensions/feature-ledger"), join(target, "feature-ledger"), "junction");
    const modeConfig = JSON.parse(await readFile(paths.out, "utf8"));
    for (const mode of Object.values(modeConfig.modes) as any[]) mode.sandbox.enabled = false;
    await writeFile(join(agentDir, "permission-mode/permission-mode.json"), JSON.stringify(modeConfig));
    const git = (...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@localhost", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@localhost" } });
    const template = join(dir, "empty-git-template");
    await mkdir(template);
    git("init", "-q", `--template=${template}`); await writeFile(join(cwd, "file"), "first\n"); git("add", "."); git("commit", "-qm", "initial");
    const ledger = join(cwd, "ledger.yaml");
    await writeFile(ledger, "ledger:\n  workspace: .\n  validation_scripts: []\n  features:\n    - id: example\n      status: todo\n      goal: Example\n      short_goal: Example\n      acceptance_criteria: []\n      constraints: []\n      files: { in: [], out: [] }\n      tests: []\n      limitations: []\n      summary: ''\n      commits: {}\n");
    const plan = sub.resolvePiLaunchToolPlan({ tools: worker.tools, subagentOnlyExtensions: worker.subagentOnlyExtensions, cwd, agentName: "worker" });
    assert.equal(plan.disableAmbientExtensions, false);
    for (const mode of ["default", "build", "plan"]) {
      process.env.PI_PERMISSION_MODE = mode;
      const settingsManager = pi.SettingsManager.create(cwd, agentDir);
      const loader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [join(permRoot!, "src/index.ts"), ...worker.subagentOnlyExtensions] });
      await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
      ({ session } = await pi.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: pi.SessionManager.inMemory(cwd), tools: plan.effectiveToolAllowlist }));
      pi.initTheme(settingsManager.getTheme()); session.extensionRunner.onError((error: unknown) => { throw error; });
      await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
      await new Promise(resolve => setTimeout(resolve, 100));
      for (const name of [...gitTools, ...ledgerTools]) assert.ok(session.getActiveToolNames().includes(name), `${mode}: ${name}`);
      for (const name of gitTools) {
        const decision = await session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: name, toolName: name, input: {} });
        assert.notEqual(decision?.block, true, `${mode}: ${name}`);
      }
      for (const name of ledgerTools) for (const input of [{ path: ledger }, { path: join(home, ".pi/agent/rehydra/records/records.sqlite") }, {}]) {
        const decision = await session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: name, toolName: name, input });
        const blocked = (mode === "plan" || mode === "default") && ["ledger_start", "ledger_submit"].includes(name);
        assert.equal(decision?.block === true, blocked, `${mode}: ${name} ${JSON.stringify(input)}`);
      }
      const providers = loader.getExtensions().extensions.filter((e: any) => e.tools.has("ledger_list"));
      assert.equal(providers.length, 1);
      assert.equal(loader.getExtensions().extensions.filter((e: any) => e.tools.has("git_r_diff")).length, 1);
      // Direct provider calls below bypass the permission gate and test only ledger functionality.
      const provider = providers[0];
      for (const name of ["ledger_check", "ledger_list", "ledger_next"]) {
        const result = await provider.tools.get(name).definition.execute("id", { path: ledger }, undefined, undefined, { cwd });
        assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result)}`);
      }
      if (mode === "build") {
        const start = await provider.tools.get("ledger_start").definition.execute("id", { id: "example", path: ledger }, undefined, undefined, { cwd });
        assert.equal(start.isError, undefined, JSON.stringify(start));
        await writeFile(join(cwd, "changed"), "only in disposable repo\n");
        const submit = await provider.tools.get("ledger_submit").definition.execute("id", { id: "example", path: ledger, commit_message: "example", summary: "tested" }, undefined, undefined, { cwd });
        assert.equal(submit.isError, undefined, JSON.stringify(submit));
        assert.match(submit.content[0].text, /is done/);
      }
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); session = undefined;
    }
  } finally {
    session?.dispose();
    for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
    for (const name of Object.keys(process.env)) if (name.startsWith("GIT_")) delete process.env[name];
    Object.assign(process.env, gitEnv);
    await rm(dir, { recursive: true, force: true });
  }
});
