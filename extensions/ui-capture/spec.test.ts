import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseYaml, serializeYaml } from "../../lib/yaml.ts";
import { parseSpec, substitutePort } from "./spec.ts";

const launch = readFileSync(new URL("./fixtures/launch.yaml", import.meta.url), "utf8");
const url = launch.replace(/server:\n[\s\S]*?conditions:/, `server:\n  url: http://127.0.0.1:3002\n  ready:\n    path: /agent\n    selector: 'section[aria-label="Sessions panel"]'\n    not_text: Loading sessions\n    timeout: 60\nconditions:`);
test("complete launch and URL examples parse with nested maps and booleans", () => {
	const a = parseSpec(launch), b = parseSpec(url);
	assert.equal(a.server.detached, true); assert.equal(a.server.keep, false);
	assert.deepEqual(a.server.env, { PORT: "{port}" });
	assert.deepEqual(a.steps[7].target, { name: "dock", target: 'section[aria-label="Sessions panel"]', padding: 16 });
	assert.deepEqual(a.diff?.regions, { "tab row": { target: '[role=tablist][aria-label="Panels"]' } });
	assert.equal(b.server.url, "http://127.0.0.1:3002");
	assert.notEqual(a.hash, b.hash);
});
test("flow nesting, quoted commas, keys, booleans and list-first nested maps round trip", () => {
	const doc = parseYaml(`'quoted key': { "x,y": ["a,b", {inner: 'it''s good'}], flag: true }\nitems:\n  - nested:\n      values: ["1,2", false]\n    next: yes\n`);
	assert.deepEqual(doc, { "quoted key": { "x,y": ["a,b", { inner: "it's good" }], flag: true }, items: [{ nested: { values: ["1,2", false] }, next: "yes" }] });
	assert.deepEqual(parseYaml(serializeYaml(doc)), doc);
});
test("capture specs retain apostrophes in plain values and exclude comments", () => {
	const spec = parseSpec(`feature: selection
subphase: 1
description: Show the user's selection # capture description
server: {url: http://localhost}
conditions: {labels: [user's choice, 'quoted, label']}
steps:
  - assert: Preserve the user's selection # expected result
`);
	assert.equal(spec.description, "Show the user's selection");
	assert.deepEqual(spec.conditions.labels, ["user's choice", "quoted, label"]);
	assert.deepEqual(spec.steps, [{ verb: "assert", target: "Preserve the user's selection" }]);
});
test("server validation, required fields, safe components and verb diagnosis", () => {
	assert.throws(() => parseSpec(launch.replace(/^feature:.*\n/m, "")), /feature/);
	assert.throws(() => parseSpec(launch.replace("start: just run --detached", "url: http://localhost\n  start: just run --detached")), /exactly one/);
	assert.throws(() => parseSpec(launch.replace("start: just run --detached", "other: nope")), /exactly one/);
	assert.throws(() => parseSpec(launch.replace(/  stop:.*\n/, "")), /requires stop/);
	assert.throws(() => parseSpec(launch.replace("focus:", "wrong:")), /step 2.*wrong/);
	assert.throws(() => parseSpec(launch.replace("feature: dock-floor-from-the-tab-row", "feature: ../bad")), /safe path/);
});
test("port substitutions affect only start and env, not the spec hash", () => {
	const spec = parseSpec(launch.replace("just run --detached", "just run --port {port}"));
	const server = substitutePort(spec.server, 4312);
	assert.equal(server.start, "just run --port 4312"); assert.deepEqual(server.env, { PORT: "4312" });
	assert.deepEqual(spec.server.env, { PORT: "{port}" });
	assert.equal(parseSpec(launch.replace("just run --detached", "just run --port {port}")).hash, spec.hash);
});
