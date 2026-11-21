// Disposable subprocess fixture: exercises the background launch builder and hooks,
// not pi-subagents' detached runner entrypoint or a model-driven agent run.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [cwd, agentDir, piRoot, subRoot] = process.argv.slice(2);
assert.equal(process.env.USERPROFILE, process.env.HOME);
assert.equal(homedir(), process.env.HOME);
const pi = await import(pathToFileURL(join(piRoot, "dist/index.js")).href);
const permissions = await import(pathToFileURL(join(subRoot, "src/runs/shared/permissions.js")).href);
const runner = await import(pathToFileURL(join(subRoot, "src/runs/background/runner-child-launch.js")).href);
const worker = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")).subagents.agentOverrides.worker;
const rules = permissions.resolvePermissionRules(undefined, worker.permissions);
const step = JSON.parse(JSON.stringify({ agent: "worker", cwd, tools: worker.tools,
  subagentOnlyExtensions: worker.subagentOnlyExtensions, permissionRules: rules }));
const launch = runner.buildRunnerChildLaunch(step, { cwd, id: "probe", flatIndex: 0 }, { sessionEnabled: false });
assert.equal(launch.session.ambientExtensions, true);
const settingsManager = pi.SettingsManager.create(cwd, agentDir);
const loader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true,
  noPromptTemplates: true, noThemes: true, noContextFiles: true,
  additionalExtensionPaths: launch.session.extensionPaths, extensionFactories: launch.session.hooks });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await pi.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader,
  sessionManager: pi.SessionManager.inMemory(cwd), tools: launch.session.tools });
try {
  pi.initTheme(settingsManager.getTheme());
  session.extensionRunner.onError((error: unknown) => { throw error; });
  await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
  await new Promise(resolve => setTimeout(resolve, 100));
  for (const name of ["ledger_check", "ledger_list", "ledger_next", "ledger_start", "ledger_submit", "git_r_status"]) {
    assert.ok(session.getActiveToolNames().includes(name), name);
    const decision = await session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: name, toolName: name, input: {} });
    assert.notEqual(decision?.block, true, name);
  }
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
} finally { session.dispose(); }
