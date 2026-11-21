// Deterministic checks of the authored skill contract, not model-routing or delegate runs.
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseYaml } from "../../lib/yaml.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills/feature-ledger");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const main = read("SKILL.md");
const worker = read("references/agents/worker-workflow.md");
const reviewer = read("references/agents/reviewer-workflow.md");
const orchestrator = read("references/agents/orchestrator-workflow.md");
const implementation = read("references/implementation-flow.md");

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : path.endsWith(".test.mjs") ? [] : [relative(root, path)];
	});
}

test("feature-ledger skill frontmatter, referenced resources and template variables", () => {
	const match = /^---\n([\s\S]*?)\n---\n/.exec(main);
	assert.ok(match, "frontmatter delimiters");
	const frontmatter = parseYaml(match[1]);
	assert.equal(frontmatter.name, "feature-ledger");
	assert.match(String(frontmatter.name), /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
	assert.doesNotMatch(String(frontmatter.name), /claude|anthropic/);
	assert.ok(typeof frontmatter.description === "string" && frontmatter.description.length < 1024);
	assert.doesNotMatch(match[1], /[<>]/);
	const bundled = files(root);
	assert.ok(!bundled.some((path) => path.endsWith("README.md")));
	for (const path of bundled.filter((path) => path !== "SKILL.md")) assert.ok(main.includes(`\`${path}\``), `${path} in resource map`);
	for (const path of bundled.filter((path) => path.endsWith(".md"))) {
		for (const [, ref] of read(path).matchAll(/`((?:references|subagents)\/[^`]+)`/g)) {
			assert.ok(bundled.includes(ref), `${path} links to missing ${ref}`);
		}
	}
	for (const role of ["worker", "reviewer"]) {
		const template = read(`subagents/${role}.md`);
		for (const variable of ["ITEM_ID", "LEDGER_PATH", "SESSION_ROOT", "AGENT_ID"]) assert.ok(template.includes(`(${"`"}${variable}${"`"})`));
		for (const field of ["item_id", "outcome", "known_state", "tests", "commit", "warnings", "blocker"]) assert.ok((role === "worker" ? worker : reviewer).includes(`\`${field}\``));
	}
});

test("trigger phrases and negative scope are represented in the description", () => {
	// Lexical coverage of representative requests; actual model skill routing requires a live comparison.
	const description = String(parseYaml(/^---\n([\s\S]*?)\n---\n/.exec(main)![1]).description).toLowerCase();
	for (const phrase of ["inspect a feature ledger", "turn a plan into a ledger", "work a ledger item", "orchestrate ledger work"]) assert.ok(description.includes(phrase), phrase);
	for (const excluded of ["ordinary task lists", "code review unrelated to a feature ledger", "direct user request"]) assert.ok(description.includes(excluded), excluded);
});

test("Given inspection or direct work, when choosing a route, then reading does not claim or delegate", () => {
	assert.match(main, /Inspect: use `ledger_get_feature`[\s\S]*without claiming work/);
	assert.match(main, /Direct work:[^\n]*no delegation is required/);
	assert.match(implementation, /ledger_work` start/);
});

test("Given an orchestration request, when selecting work, then check, list, delegate and verify sequentially", () => {
	assert.match(main, /only on a direct user request/);
	assert.match(orchestrator, /ledger_check[\s\S]*action: list[\s\S]*action: next/);
	assert.match(orchestrator, /Wait for that one run to finish/);
	assert.match(orchestrator, /Verify the delegate's result with `ledger_get_feature`/);
	assert.match(orchestrator, /Do not implement items, conduct reviews, or run validation yourself/);
});

test("Given failed review, when findings remain open, then fix and re-review unless capped", () => {
	assert.match(reviewer, /Any open finding, including a nit, fails the review/);
	assert.match(reviewer, /required_checks/);
	assert.match(orchestrator, /if uncapped, loop to `next` for a worker fix, then review again/);
	assert.match(orchestrator, /If capped, stop unless the user authorizes resolution/);
});

test("Given unavailable tools or an interrupted run, when recovery is considered, then stop or release only a stopped matching claim", () => {
	assert.match(main, /required ledger or delegation tool is unavailable, stop and report/);
	assert.match(orchestrator, /inability to establish this means stop and report, not release/);
	assert.match(orchestrator, /verify(?:ing)? those match the stopped run/i);
	assert.match(orchestrator, /inspect Git HEAD, index and ledger state/);
});
