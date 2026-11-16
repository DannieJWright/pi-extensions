import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildConfig } from "./merge.ts";
import { parseJsonc, stripJsonc } from "../../lib/jsonc.ts";

function build(source: Record<string, unknown>): Record<string, unknown> {
	return buildConfig(source);
}

function mode(config: Record<string, unknown>, name: string): Record<string, unknown> {
	return (config.modes as Record<string, Record<string, unknown>>)[name];
}

function map(config: Record<string, unknown>, name: string, key: string): Record<string, unknown> {
	return mode(config, name)[key] as Record<string, unknown>;
}

test("deep merge keeps inherited key order and appends new keys", () => {
	const config = build({
		fragments: {
			base: { permission: { write: { "*": "ask", "guard": "deny" } } },
		},
		modes: {
			m: { extends: ["base"], permission: { write: { "new": "allow" } } },
		},
	});

	assert.deepEqual(mode(config, "m"), { permission: { write: { "*": "ask", "guard": "deny", "new": "allow" } } });
	const write = map(config, "m", "permission")["write"] as Record<string, unknown>;
	assert.deepEqual(Object.keys(write), ["*", "guard", "new"]);
});

test("last matching key wins in a pattern map", () => {
	const config = build({
		fragments: { base: { permission: { write: { "*": "ask", "plan/*.md": "allow" } } } },
		modes: { m: { extends: ["base"], permission: { write: { "*": "deny" } } } },
	});

	assert.deepEqual(mode(config, "m"), { permission: { write: { "*": "deny", "plan/*.md": "allow" } } });
});

test("$replace writes the map in its own order", () => {
	const config = build({
		fragments: { base: { permission: { write: { "*": "ask", "a": "deny" } } } },
		modes: { m: { extends: ["base"], permission: { write: { $replace: true, "b": "allow", "*": "deny" } } } },
	});

	assert.deepEqual(mode(config, "m"), { permission: { write: { "b": "allow", "*": "deny" } } });
});

test("key+ appends to an inherited array without duplicates", () => {
	const config = build({
		fragments: { base: { sandbox: { allowWrite: [".", "/tmp"] } } },
		modes: { m: { extends: ["base"], sandbox: { "allowWrite+": ["/tmp", "/var"] } } },
	});

	assert.deepEqual(mode(config, "m"), { sandbox: { allowWrite: [".", "/tmp", "/var"] } });
});

test("arrays replace without key+", () => {
	const config = build({
		fragments: { base: { sandbox: { allowWrite: [".", "/tmp"] } } },
		modes: { m: { extends: ["base"], sandbox: { allowWrite: ["/only"] } } },
	});

	assert.deepEqual(mode(config, "m"), { sandbox: { allowWrite: ["/only"] } });
});

test("null deletes an inherited key", () => {
	const config = build({
		fragments: { base: { permission: { read: "allow", skill: "allow" } } },
		modes: { m: { extends: ["base"], permission: { read: null } } },
	});

	assert.deepEqual(mode(config, "m"), { permission: { skill: "allow" } });
});

test("a type change replaces the inherited value", () => {
	const config = build({
		fragments: { base: { permission: { tool: "allow" } } },
		modes: { m: { extends: ["base"], permission: { tool: { "*": "ask" } } } },
	});

	assert.deepEqual(mode(config, "m"), { permission: { tool: { "*": "ask" } } });
});

test("extends applies left to right, fragments and modes alike", () => {
	const config = build({
		fragments: { a: { label: "A", x: 1 }, b: { x: 2, y: 3 } },
		modes: {
			base: { extends: ["a"], label: "Base", x: 10 },
			m: { extends: ["base", "b"] },
		},
	});

	assert.deepEqual(mode(config, "m"), { label: "Base", x: 2, y: 3 });
});

test("key+ on a missing key creates the array", () => {
	const config = build({
		fragments: {},
		modes: { m: { sandbox: { "allowWrite+": ["/tmp"] } } },
	});

	assert.deepEqual(mode(config, "m"), { sandbox: { allowWrite: ["/tmp"] } });
});

test("merge keywords are stripped from the output", () => {
	const config = build({
		fragments: { base: { permission: { write: { $replace: true, "*": "ask" } } } },
		modes: { m: { extends: ["base"], permission: { read: "allow" } } },
	});

	assert.deepEqual(mode(config, "m"), { permission: { write: { "*": "ask" }, read: "allow" } });
	assert.ok(!("extends" in mode(config, "m")));
	assert.ok(!("$replace" in map(config, "m", "permission")["write"]));
});

test("unknown extends is an error", () => {
	assert.throws(
		() => build({ fragments: { a: {} }, modes: { m: { extends: ["nope"] } } }),
		/unknown extends "nope"/,
	);
});

test("extends cycle is an error", () => {
	assert.throws(
		() => build({ fragments: { a: { extends: ["b"] }, b: { extends: ["a"] } }, modes: { m: { extends: ["a"] } } }),
		/extends cycle: m -> a -> b -> a/,
	);
});

test("output block is copied as-is", () => {
	const config = build({
		output: { defaultMode: "default", cycleOrder: ["default"] },
		fragments: {},
		modes: { default: { label: "Default" } },
	});

	assert.ok(!("output" in config));
	assert.equal(config.defaultMode, "default");
	assert.deepEqual(config.cycleOrder, ["default"]);
	assert.deepEqual(config.modes, { default: { label: "Default" } });
});

test("JSONC comments and trailing commas parse", () => {
	const source = `{
  // line comment
  "output": { "defaultMode": "m", },
  /* block comment */
  "fragments": { "a": { "x": 1, }, },   // trailing comment
  "modes": { "m": { "extends": ["a"], "y": "z" } }
}`;

	const parsed = parseJsonc(source, "test") as Record<string, unknown>;
	const config = buildConfig(parsed);
	assert.deepEqual(config, {
		defaultMode: "m",
		modes: { m: { x: 1, y: "z" } },
	});
});

test("comments inside strings are kept", () => {
	const parsed = parseJsonc(stripJsonc(`{"a": "http://x /* not a comment */"}`), "test");
	assert.deepEqual(parsed, { a: "http://x /* not a comment */" });
});

test("configured prompts follow mode inheritance without enabling plan approval", () => {
	const path = new URL("./permission-mode.src.jsonc", import.meta.url);
	const config = build(parseJsonc(readFileSync(path, "utf8"), path.pathname) as Record<string, unknown>);
	const planPrompt = mode(config, "plan").systemPrompt;
	const buildPrompt = mode(config, "build").systemPrompt;

	assert.equal(typeof planPrompt, "string");
	assert.notEqual(planPrompt, "@plan");
	assert.match(planPrompt as string, /show_plan/);
	assert.match(planPrompt as string, /Do not implement code/);
	assert.equal(mode(config, "plan-local").systemPrompt, planPrompt);
	assert.equal(typeof buildPrompt, "string");
	assert.match(buildPrompt as string, /Implement the user's current request/);
	for (const name of ["build-local", "build-yolo"]) {
		assert.equal(mode(config, name).systemPrompt, buildPrompt);
	}
	for (const name of ["default", "yolo"]) {
		assert.equal(mode(config, name).systemPrompt, undefined);
	}
});

test("the shipped source generates the shipped modes", () => {
	const source = parseJsonc(
		`{
  "output": { "defaultMode": "default", "cycleOrder": ["default", "plan-local"] },
  "fragments": {
    "pathGate": { "permission": { "path": { "*": "allow" } } },
    "common": { "extends": ["pathGate"], "permission": { "read": "allow", "skill": "allow" } },
    "local": { "permission": { "external_directory": { "*": "deny" } } }
  },
  "modes": {
    "default": { "extends": ["common"], "label": "Default" },
    "plan-local": { "extends": ["plan", "local"], "label": "Plan (local)" },
    "plan": { "extends": ["common"], "label": "Plan Mode", "permission": { "write": { "*": "deny" } } }
  }
}`,
		"test",
	) as Record<string, unknown>;

	const config = buildConfig(source);
	assert.deepEqual(mode(config, "plan-local"), {
		permission: {
			path: { "*": "allow" },
			read: "allow",
			skill: "allow",
			external_directory: { "*": "deny" },
			write: { "*": "deny" },
		},
		label: "Plan (local)",
	});
});
