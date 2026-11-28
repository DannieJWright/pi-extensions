import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = await readFile(new URL("./references/agents/orchestrator-workflow.md", import.meta.url), "utf8");
const workerWorkflow = await readFile(new URL("./references/agents/worker-workflow.md", import.meta.url), "utf8");
const dispatchPrompt = await readFile(new URL("./subagents/worker.md", import.meta.url), "utf8");
const uiWorkerDispatchTemplate = await readFile(new URL("./subagents/ui-worker.md", import.meta.url), "utf8");
const skillMain = await readFile(new URL("./SKILL.md", import.meta.url), "utf8");
const writingFlow = await readFile(new URL("./references/writing-flow.md", import.meta.url), "utf8");
const uiWorker = await readFile(new URL("../../agents/ui-worker.md", import.meta.url), "utf8");

// The seven fields come from the backticked list in the worker workflow's "Return contract" prose.
const returnContract = workerWorkflow.slice(workerWorkflow.indexOf("## Return contract"), workerWorkflow.indexOf("Use `none`"));
const expectedFields = [...returnContract.matchAll(/`(\w+)`/g)].map(match => match[1]);

test("orchestrator routes todo and in-progress items on the route field", () => {
	assert.match(workflow, /For `todo` or eligible `in-progress`, read `acceptance_criteria` from the `next` result/);
	assert.match(workflow, /when `route` is `ui`, select `ui-worker` with the agent ID `<feature-id>-<failed-reviews>-ui-worker`; otherwise select the normal worker with `<feature-id>-<failed-reviews>-worker`/);
	assert.match(workflow, /`agent_id` may end in `-ui-worker` while `assignment.id` stays `-worker`/);
	assert.match(workflow, /done only after `capture_check` verifies the before and after pair/);
	assert.match(workflow, /Read `subagents\/ui-worker\.md` for a UI item/);
	assert.match(workflow, /Do not call `ledger_work` start to route/);
	assert.match(workflow, /`<feature-id>-<failed-reviews>-<worker\|reviewer>`/);
});

test("orchestrator stops and reports a missing ui-worker instead of falling back", () => {
	assert.match(workflow, /defines no `ui-worker`, stop and report the missing role; never fall back to a worker without capture tools/);
});

test("the deprecation of the old criterion phrase belongs to the authoring flow, not the routing rule", () => {
	assert.ok(writingFlow.includes("`UI evidence required` no longer routes anything"), "writing-flow.md states it for authors");
	assert.equal(workflow.split("UI evidence required").length - 1, 0, "the routing rule does not restate it");
});

test("orchestrator accepts test results only from submit validation and delegate reports; this is the rule's only guard", () => {
	assert.match(workflow, /Accept test results only from validation run by the submit tool and from the delegate's reported tests/);
});

test("orchestrator never runs project test suites and accepting a report is not re-running it; this is the rule's only guard", () => {
	assert.match(workflow, /Never run project test suites yourself; accepting a report is not re-running it/);
});

test("orchestrator stops and reports unknown tests instead of verifying them; this is the rule's only guard", () => {
	assert.match(workflow, /When tests are unknown, stop and report instead of verifying them/);
});

test("the test-scope rule lives once in the orchestrator workflow, which SKILL.md points to", () => {
	assert.equal(workflow.split("Never run project test suites yourself").length - 1, 1);
	assert.equal(skillMain.split("never runs project test suites itself").length - 1, 0);
	assert.match(skillMain, /read `references\/agents\/orchestrator-workflow\.md` and delegate sequentially/);
});

test("UI worker follows the worker workflow and the same seven-field contract", () => {
	assert.deepEqual(expectedFields, ["item_id", "outcome", "known_state", "tests", "commit", "warnings", "blocker"]);
	assert.match(dispatchPrompt, /directly instruct you to read and follow `references\/agents\/worker-workflow\.md`/);
	assert.match(uiWorker, /feature-ledger orchestration assignment[\s\S]*worker-workflow\.md[\s\S]*instead of the standalone handoff[\s\S]*exactly one JSON object[\s\S]*no other text/);
	assert.match(uiWorker, /both fresh and resumed assignments/);
	assert.match(uiWorker, /For standalone work[\s\S]*Implemented X\.[\s\S]*Recommended next step: N\./);
	assert.match(uiWorker, /fields defined in the Return contract of `references\/agents\/worker-workflow\.md`/);
	assert.match(workflow, /fields defined in the Return contract of `references\/agents\/worker-workflow\.md`/);
});

test("ui-worker dispatch template mirrors the worker template variables and is in the SKILL.md table", () => {
	for (const variable of ["ITEM_ID", "LEDGER_PATH", "SESSION_ROOT", "AGENT_ID"]) {
		const token = `(\`${variable}\`)`;
		assert.ok(dispatchPrompt.includes(token), `subagents/worker.md has ${variable}`);
		assert.ok(uiWorkerDispatchTemplate.includes(token), `subagents/ui-worker.md has ${variable}`);
	}
	assert.match(uiWorkerDispatchTemplate, /Return contract of `references\/agents\/worker-workflow\.md`/);
	assert.match(skillMain, /^\| `subagents\/ui-worker\.md` \|.*\|$/m);
	assert.match(uiWorker, /sent through `subagents\/ui-worker\.md`/);
});
