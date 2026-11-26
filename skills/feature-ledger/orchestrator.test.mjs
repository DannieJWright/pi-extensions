import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = await readFile(new URL("./references/agents/orchestrator-workflow.md", import.meta.url), "utf8");
const workerWorkflow = await readFile(new URL("./references/agents/worker-workflow.md", import.meta.url), "utf8");
const dispatchPrompt = await readFile(new URL("./subagents/worker.md", import.meta.url), "utf8");
const uiWorker = await readFile(new URL("../../agents/ui-worker.md", import.meta.url), "utf8");

// The seven fields come from the backticked list in the worker workflow's "Return contract" prose.
const returnContract = workerWorkflow.slice(workerWorkflow.indexOf("## Return contract"), workerWorkflow.indexOf("Use `none`"));
const expectedFields = [...returnContract.matchAll(/`(\w+)`/g)].map(match => match[1]);

test("orchestrator routes todo and in-progress items on the exact UI evidence marker", () => {
	assert.match(workflow, /For `todo` or eligible `in-progress`, read `acceptance_criteria` from the `next` result/);
	assert.match(workflow, /contains the exact text `UI evidence required`, select `ui-worker`[\s\S]*`<feature-id>-<failed-reviews>-ui-worker`; no other text decides the route/);
	assert.match(workflow, /Otherwise select the normal worker with `<feature-id>-<failed-reviews>-worker`/);
	assert.match(workflow, /Do not call `ledger_work` start to route/);
	assert.match(workflow, /`<feature-id>-<failed-reviews>-<worker\|ui-worker\|reviewer>`/);
});

test("UI worker follows the worker workflow and the same seven-field contract", () => {
	assert.deepEqual(expectedFields, ["item_id", "outcome", "known_state", "tests", "commit", "warnings", "blocker"]);
	assert.match(dispatchPrompt, /directly instruct you to read and follow `references\/agents\/worker-workflow\.md`/);
	assert.match(uiWorker, /feature-ledger orchestration assignment[\s\S]*worker-workflow\.md[\s\S]*instead of the standalone handoff[\s\S]*exactly one JSON object[\s\S]*no other text/);
	assert.match(uiWorker, /both fresh and resumed assignments/);
	assert.match(uiWorker, /For standalone work[\s\S]*Implemented X\.[\s\S]*Recommended next step: N\./);
	for (const field of expectedFields) {
		assert.ok(uiWorker.includes(`\`${field}\``), `ui-worker must name ${field}`);
		assert.ok(workflow.includes(`\`${field}\``), `orchestrator must name ${field}`);
	}
});
