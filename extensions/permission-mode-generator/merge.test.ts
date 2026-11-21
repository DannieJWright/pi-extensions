import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildConfig, buildSubagents, MergeError } from "./merge.ts";
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
		/extends cycle: permissionModes\.modes\.m -> permissionModes\.fragments\.a -> permissionModes\.fragments\.b -> permissionModes\.fragments\.a/,
	);
	assert.throws(
		() => buildSubagents({ agents: { reviewer: { extends: ["worker"] }, worker: { extends: ["reviewer"] } } }),
		/extends cycle: subagents\.agents\.reviewer -> subagents\.agents\.worker -> subagents\.agents\.reviewer/,
	);
	assert.throws(
		() => buildSubagents({ fragments: { reviewer: { extends: ["reviewer"] } }, agents: { reviewer: { extends: ["reviewer"] } } }),
		/extends cycle: subagents\.agents\.reviewer -> subagents\.fragments\.reviewer -> subagents\.fragments\.reviewer/,
	);
});

test("entries can extend same-named fragments", () => {
	assert.deepEqual(buildSubagents({
		fragments: { reviewer: { tools: ["read"] } },
		agents: { reviewer: { extends: ["reviewer"], enabled: true } },
	}), { agentOverrides: { reviewer: { tools: ["read"], enabled: true } } });
	assert.deepEqual(mode(buildConfig({
		fragments: { plan: { label: "Plan" } },
		modes: { plan: { extends: ["plan"], enabled: true } },
	}), "plan"), { label: "Plan", enabled: true });
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
	const path = new URL("../../configs/permission-mode.example.src.jsonc", import.meta.url);
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

test("subagent settings and agents retain absence, empty, false and merge rules", () => {
	assert.deepEqual(buildSubagents({ settings: { disableBuiltins: false } }), { disableBuiltins: false });
	assert.deepEqual(buildSubagents({ settings: { disableBuiltins: false }, agents: {} }), {
		disableBuiltins: false, agentOverrides: {},
	});
	const result = buildSubagents({
		settings: { defaultExtensions: ["ext"], disableBuiltins: false },
		fragments: {
			base: { tools: ["a"], nested: { first: 1, removed: true }, enabled: true },
			more: { extends: ["base"], "tools+": ["b"], enabled: false },
		},
		agents: { worker: { extends: ["more"], "tools+": ["b", "c"], nested: { removed: null, second: 2 } } },
	});
	assert.deepEqual(result, {
		defaultExtensions: ["ext"], disableBuiltins: false,
		agentOverrides: { worker: { tools: ["a", "b", "c"], nested: { first: 1, second: 2 }, enabled: false } },
	});
});

test("subagent agents rejects present non-object values", () => {
	for (const agents of [["reviewer"], [], null, "reviewer", 42, false, undefined]) {
		assert.throws(() => buildSubagents({ agents }), {
			name: "Error",
			message: "subagents.agents: must be an object mapping agent names to overrides",
			constructor: MergeError,
		});
	}
});

test("settings.agentOverrides is rejected whether agents is absent or present", () => {
	for (const extra of [{}, { agents: {} }]) {
		assert.throws(() => buildSubagents({ settings: { agentOverrides: {} }, ...extra }),
			/subagents\.settings\.agentOverrides: use subagents\.agents instead/);
	}
});

test("extends lookup is section-local and names the failing entry", () => {
	assert.throws(() => buildConfig({ modes: { plan: { extends: ["reviewer"] } } }),
		/permissionModes\.modes\.plan: unknown extends "reviewer"/);
	assert.throws(() => buildSubagents({ agents: { reviewer: { extends: ["plan"] } } }),
		/subagents\.agents\.reviewer: unknown extends "plan"/);
	assert.throws(() => buildSubagents({ agents: { reviewer: { extends: ["toString"] } } }),
		/subagents\.agents\.reviewer: unknown extends "toString"/);
});

test("sibling resolved fragments replace arrays instead of appending", () => {
	const fragments = { a: { tools: ["a"] }, b: { tools: ["b"] } };
	assert.deepEqual(mode(buildConfig({ fragments, modes: { m: { extends: ["a", "b"] } } }), "m"), { tools: ["b"] });
	assert.deepEqual(buildSubagents({ fragments, agents: { worker: { extends: ["a", "b"] } } }),
		{ agentOverrides: { worker: { tools: ["b"] } } });
});

test("unsafe append names are rejected in inherited fragments before repeated merges", () => {
	for (const base of ["__proto__", "constructor", "prototype"]) {
		for (const suffix of ["++", "+++"]) {
			const key = base + suffix;
			const source = JSON.parse(`{"fragments":{"base":{"nested":{"${key}":{"polluted":true}}},"derived":{"extends":["base"]}},"modes":{"m":{"extends":["derived"]}},"agents":{"worker":{"extends":["derived"]}}}`);
			assert.throws(() => buildConfig(source), (error: Error) => {
				assert.equal(error.message, `permissionModes.fragments.base.nested.${key}: unsafe property name; rename this key`);
				return true;
			});
			assert.throws(() => buildSubagents(source), (error: Error) => {
				assert.equal(error.message, `subagents.fragments.base.nested.${key}: unsafe property name; rename this key`);
				return true;
			});
			assert.equal(({} as Record<string, unknown>).polluted, undefined);
		}
	}
});

test("unsafe JSON property names are rejected without prototype pollution or data loss", () => {
	for (const key of ["__proto__", "constructor", "prototype", "__proto__+"]) {
		const source = JSON.parse(`{"modes":{"m":{"nested":{"${key}":{"polluted":true}}}}}`);
		assert.throws(() => buildConfig(source), /permissionModes\.modes\.m\.nested\..*: unsafe property name; rename this key/);
		const agents = JSON.parse(`{"agents":{"worker":{"${key}":{"polluted":true}}}}`);
		assert.throws(() => buildSubagents(agents), /subagents\.agents\.worker\..*: unsafe property name; rename this key/);
		assert.equal(({} as Record<string, unknown>).polluted, undefined);
	}
	assert.throws(() => buildConfig(JSON.parse('{"fragments":{"__proto__":{}},"modes":{}}')),
		/permissionModes\.fragments\.__proto__: unsafe property name/);
});
