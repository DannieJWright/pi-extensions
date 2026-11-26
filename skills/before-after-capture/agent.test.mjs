import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Computed at module load from the real home; a test below replaces HOME, which must not move this path.
const harness = process.env.PI_SUBAGENTS_ROOT ?? join(homedir(), ".pi/agent/npm/node_modules/pi-subagents");
const moduleAt = path => import(pathToFileURL(join(harness, path)).href);
const skipMessage = path => `pi-subagents module not found or could not be read at ${join(harness, path)}; set PI_SUBAGENTS_ROOT for the integration test`;

// The seven fields come from the backticked list in the worker workflow's "Return contract" prose.
async function handoffExample() {
	const workflow = await readFile(join(root, "skills/feature-ledger/references/agents/worker-workflow.md"), "utf8");
	const contract = workflow.slice(workflow.indexOf("## Return contract"), workflow.indexOf("Use `none`"));
	const fields = [...contract.matchAll(/`(\w+)`/g)].map(match => match[1]);
	assert.deepEqual(fields, ["item_id", "outcome", "known_state", "tests", "commit", "warnings", "blocker"]);
	return Object.fromEntries(fields.map(field => [field, "x"]));
}

test("installed subagent harness discovers the worker and keeps late tools eligible", async t => {
	try { await access(join(harness, "src/agents/agents.js")); }
	catch { t.skip(skipMessage("src/agents/agents.js")); return; }
	const { discoverAgents } = await moduleAt("src/agents/agents.js");
	const { resolveSkills } = await moduleAt("src/agents/skills.js");
	const { resolvePiLaunchToolPlan } = await moduleAt("src/runs/shared/child-tool-plan.js");

	// Discovery reads settings.json, the agents directories and ~/.agents/skills from HOME and PI_CODING_AGENT_DIR.
	const dir = await mkdtemp(join(tmpdir(), "ui-worker-tools-"));
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousProfile = process.env.USERPROFILE;
	try {
		const home = join(dir, "home");
		await mkdir(home);
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
		// pi-subagents stops its project-root walk at any home directory it knows. HOME is now temporary, so name the
		// repository root as one; otherwise the walk climbs into the real home and reads its settings.
		process.env.USERPROFILE = root;
		const found = discoverAgents(root, "project", undefined, { globalNpmRoot: null });
		const agent = found.agents.find(item => item.name === "ui-worker");
		assert.ok(agent, JSON.stringify(found.agentDiagnostics));
		assert.equal(agent.filePath, join(root, "agents/ui-worker.md"));
		assert.match(agent.systemPrompt, /feature-ledger orchestration assignment[\s\S]*worker-workflow\.md[\s\S]*instead of the standalone handoff[\s\S]*exactly one JSON object[\s\S]*`item_id`, `outcome`, `known_state`, `tests`, `commit`, `warnings` and `blocker`[\s\S]*no other text/);
		assert.match(agent.systemPrompt, /runtime requires a separate acceptance report, follow its instructions as well/);
		assert.match(agent.systemPrompt, /both fresh and resumed assignments; do not infer authorization to orchestrate/);
		assert.match(agent.systemPrompt, /For standalone work[\s\S]*Implemented X\.[\s\S]*Changed files: Y\.[\s\S]*Validation: Z\.[\s\S]*Open risks\/questions: R\.[\s\S]*Recommended next step: N\./);
		assert.equal(agent.tools, undefined);
		assert.deepEqual(agent.extensions, ["ui-capture", "feature-ledger", "just-tools"].map(name => join(root, `extensions/${name}/index.ts`)));
		const skills = resolveSkills(agent.skills, root, agent.skillPath, dirname(agent.filePath));
		assert.deepEqual(skills.missing, []);
		assert.deepEqual(skills.resolved.map(item => item.path), ["before-after-capture", "feature-ledger"].map(name => join(root, `skills/${name}/SKILL.md`)));
		const plan = resolvePiLaunchToolPlan({ tools: agent.tools, extensions: agent.extensions, cwd: root });
		assert.equal(plan.explicitToolAllowlist, false);
		assert.equal(plan.disableAmbientExtensions, true);
		assert.deepEqual(plan.configuredExtensions, agent.extensions);

		// Exercise the actual selected providers at session start, with deterministic recipe metadata.
		await writeFile(join(dir, "justfile"), "test:\n    @echo ok\n");
		const handlers = [];
		const tools = [];
		const warnings = [];
		const api = {
			on(event, handler) { if (event === "session_start") handlers.push(handler); },
			registerTool(tool) { tools.push(tool); },
			getAllTools() { return tools; },
			async exec(_command, args) {
				return { code: 0, stdout: args.includes("--json") ? JSON.stringify({ recipes: { test: { private: false, parameters: [] } }, modules: {} }) : "test", stderr: "" };
			},
		};
		for (const path of plan.configuredExtensions) (await import(pathToFileURL(path).href)).default(api);
		for (const handler of handlers) await handler({}, { cwd: dir, ui: { notify: message => warnings.push(message) } });
		assert.deepEqual(warnings, []);
		for (const name of ["capture_run", "capture_check", "capture_server", "ledger_work", "ledger_orchestrate", "ledger_get_feature", "just_test"]) {
			assert.ok(tools.some(tool => tool.name === name), name);
		}
	} finally {
		if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
		await rm(dir, { recursive: true, force: true });
	}
});

test("runtime delivers the UI worker's ledger JSON without its separate acceptance report", async t => {
	try { await access(join(harness, "src/runs/shared/acceptance.js")); }
	catch { t.skip(skipMessage("src/runs/shared/acceptance.js")); return; }
	const { stripAcceptanceReport } = await moduleAt("src/runs/shared/acceptance.js");
	const example = await handoffExample();
	const success = { ...example, item_id: "ui-change", outcome: "submitted", known_state: "done", tests: "passed", commit: "abc123", warnings: "none", blocker: "none" };
	const report = '\n```acceptance-report\n{"criteriaSatisfied":[],"residualRisks":[]}\n```';
	const delivered = stripAcceptanceReport(JSON.stringify(success) + report);
	assert.deepEqual(JSON.parse(delivered), success);
	assert.throws(() => JSON.parse(stripAcceptanceReport('{"item_id":' + report)), SyntaxError);
	assert.throws(() => JSON.parse(stripAcceptanceReport(JSON.stringify(success) + "\nextra text" + report)), SyntaxError);
});
