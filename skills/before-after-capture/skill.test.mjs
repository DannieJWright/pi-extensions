import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseSpec } from "../../extensions/ui-capture/spec.ts";

const skill = await readFile(new URL("./SKILL.md", import.meta.url), "utf8");

test("skill triggers for visual evidence and its example is a valid capture spec", () => {
	assert.match(skill, /description: >-[\s\S]*visible UI change[\s\S]*screenshots or visual evidence/);
	const example = skill.match(/```yaml\n([\s\S]*?)```/)[1];
	const spec = parseSpec(example);
	assert.equal(spec.feature, "search-result-labels");
	assert.equal(spec.server.url, "http://127.0.0.1:3000");
	assert.ok(spec.steps.some(step => step.verb === "screenshot"));
});

test("skill requires the ordered pair workflow and preserves review evidence", () => {
	const before = skill.indexOf("`phase: before`");
	const implement = skill.indexOf("Implement the change", before);
	const after = skill.indexOf("`phase: after`", implement);
	const inspect = skill.indexOf("Look at both returned images", after);
	const check = skill.indexOf("`capture_check`", inspect);
	assert.ok(before >= 0 && before < implement && implement < after && after < inspect && inspect < check);
	for (const rule of ["conditions_match", "only_difference_is_the_feature", "same_target", "preserved", "measurements", "sidecar path", "not ignored", "remove the artifacts", "no artifact files remain tracked", "Never delete another server's lock"]) {
		assert.ok(skill.includes(rule), rule);
	}
	assert.doesNotMatch(skill, /scripts\/|capture\.mjs|node .*capture/);
});
