// Optional integration probe against the installed Pi and pi-subagents runtimes. No model is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const piRoot = process.env.PI_PACKAGE_DIR;
const subagentsRoot = process.env.PI_GIT_TOOLS_SUBAGENTS_ROOT;
const enabled = Boolean(piRoot && subagentsRoot);

test("installed Pi and subagents child loader: reviewer tools, duplicate provider, and tilde", { skip: !enabled }, async () => {
 const pi = await import(pathToFileURL(join(piRoot!, "dist/index.js")).href);
 const sub = await import(pathToFileURL(join(subagentsRoot!, "src/runs/shared/child-tool-plan.js")).href);
 const temp = await mkdtemp(join(tmpdir(), "git-tools-runtime-"));
 const cwd = join(temp, "repo"), agentDir = join(temp, "agent"), home = join(temp, "home");
 const originalHome = process.env.HOME;
 try {
  await mkdir(cwd); await mkdir(agentDir); await mkdir(home);
  process.env.HOME = home;
  const ext = resolve("extensions/git-tools/index.ts");
  await symlink(ext, join(home, "provider.ts"));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [ext] }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" }, encoding: "utf8" }).trim();
  git("init", "-q"); await writeFile(join(cwd, "file"), "first\n"); git("add", "."); git("commit", "-qm", "first"); const first = git("rev-parse", "HEAD"); await writeFile(join(cwd, "file"), "second\n"); git("commit", "-qam", "second");
  const tools = ["read", "git_r_diff", "git_r_status", "git_r_log", "git_r_show"];
  const plan = sub.resolvePiLaunchToolPlan({ tools, subagentOnlyExtensions: ["~/provider.ts"], cwd, agentName: "reviewer" });
  assert.deepEqual(plan.effectiveToolAllowlist, tools); assert.equal(plan.disableAmbientExtensions, false);
  for (const [ambient, provider] of [[false, "~/provider.ts"], [true, "~/provider.ts"], [true, ext]] as const) {
   const settingsManager = pi.SettingsManager.create(cwd, agentDir);
   const loader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: !ambient, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [provider] });
   await loader.reload(); const data = loader.getExtensions();
   assert.deepEqual(data.errors, []);
   const providers = data.extensions.filter((e: any) => e.tools.has("git_r_diff"));
   console.log(`ambient=${ambient} provider=${provider === ext ? "absolute" : "tilde"} count=${providers.length}`);
   assert.equal(providers.length, 1);
   const diff = providers[0].tools.get("git_r_diff").definition;
   const result = await diff.execute("id", { mode: "range", from: first, to: "HEAD" }, undefined, undefined, { cwd });
   assert.equal(result.isError, false); assert.match(result.content[0].text, /second/);
   const created = await pi.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: pi.SessionManager.inMemory(cwd), tools });
   try { const names = created.session.getActiveToolNames(); assert.ok(tools.every((name: string) => names.includes(name))); assert.ok(!names.includes("bash")); }
   finally { created.session.dispose(); }
  }
 } finally { if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; await rm(temp, { recursive: true, force: true }); }
});

test("permission-mode denies file read while allowing Git to expose committed content", { skip: !enabled || !process.env.PI_GIT_TOOLS_PERMISSION_MODES_ROOT }, async () => {
 const pi = await import(pathToFileURL(join(piRoot!, "dist/index.js")).href);
 const temp = await mkdtemp(join(tmpdir(), "git-tools-policy-"));
 const cwd = join(temp, "repo"), agentDir = join(temp, "agent"), scratch = join(temp, "scratch");
 const names = ["HOME", "PI_CODING_AGENT_DIR", "PI_PERMISSION_MODE", "PI_PERMISSION_TMPDIR", "CLAUDE_CODE_TMPDIR", "CLAUDE_TMPDIR"];
 const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
 let session: any;
 try {
  await mkdir(cwd); await mkdir(agentDir); await mkdir(scratch); await mkdir(join(agentDir, "permission-mode"));
  process.env.HOME = temp; process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_PERMISSION_TMPDIR = scratch; process.env.PI_PERMISSION_MODE = "default";
  const policy = { sandbox: { enabled: false }, permission: { path: { "*secret*": "deny" }, tool: { "git_r_*": "allow" } } };
  await writeFile(join(agentDir, "permission-mode/permission-mode.json"), JSON.stringify({ modes: { default: policy, plan: policy } }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "tester@localhost", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "tester@localhost" }, encoding: "utf8" }).trim();
  git("init", "-q"); await writeFile(join(cwd, "secret.txt"), "first\n"); git("add", "."); git("commit", "-qm", "first"); const first = git("rev-parse", "HEAD"); await writeFile(join(cwd, "secret.txt"), "disposable policy canary\n"); git("commit", "-qam", "secret");
  const permissionExt = join(process.env.PI_GIT_TOOLS_PERMISSION_MODES_ROOT!, "src/index.ts");
  const gitExt = resolve("extensions/git-tools/index.ts");
  for (const mode of ["default", "plan"]) {
   process.env.PI_PERMISSION_MODE = mode;
   const settingsManager = pi.SettingsManager.create(cwd, agentDir);
   const loader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [permissionExt, gitExt] });
   await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
   ({ session } = await pi.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: pi.SessionManager.inMemory(cwd), tools: ["read", "git_r_show", "git_r_diff"] }));
   pi.initTheme(settingsManager.getTheme());
   session.extensionRunner.onError((error: unknown) => { throw error; });
   await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
   await new Promise((resolve) => setTimeout(resolve, 100));
   const readDecision = await session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "read", toolName: "read", input: { path: join(cwd, "secret.txt") } });
   const gitDecision = await session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "git", toolName: "git_r_diff", input: { mode: "range", from: first, to: "HEAD", paths: ["secret.txt"] } });
   assert.equal(readDecision?.block, true); assert.equal(gitDecision?.block, undefined);
   const def = loader.getExtensions().extensions.find((e: any) => e.tools.has("git_r_diff")).tools.get("git_r_diff").definition;
   const result = await def.execute("id", { mode: "range", from: first, to: "HEAD", paths: ["secret.txt"] }, undefined, undefined, { cwd });
   assert.equal(result.isError, false); assert.match(result.content[0].text, /disposable policy canary/);
   assert.ok(!session.getActiveToolNames().includes("bash"));
   console.log(`${mode} mode: read denied; git_r_diff allowed and exposed committed canary`);
   await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
   session.dispose(); session = undefined;
  }
 } finally {
  session?.dispose();
  for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
  await rm(temp, { recursive: true, force: true });
 }
});
