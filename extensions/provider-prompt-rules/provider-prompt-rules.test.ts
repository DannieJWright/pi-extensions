import test from "node:test";
import assert from "node:assert/strict";
import { applySections, defaultText, formatReport, parseConfig, resolveRules, RULES } from "./config.ts";

const SOURCE = "test-config";
const STRATA = { provider: "strata", id: "qwen3.8-flash-next-iq2_xs" };

function parse(text: string) {
	return parseConfig(text, SOURCE);
}

test("provider rule resolves for a configured provider", () => {
	const { config, problems } = parse(`{ "providers": { "strata": { "sequentialSubagents": true } } }`);
	assert.deepEqual(problems, []);
	assert.deepEqual(resolveRules(config, STRATA), [
		{ rule: "sequentialSubagents", source: 'providers["strata"]', text: RULES.sequentialSubagents.text, textSource: "built-in" },
	]);
});

test("model override wins over the provider rule", () => {
	const { config, problems } = parse(`{
		"providers": { "strata": { "sequentialSubagents": true } },
		"modelOverrides": { "strata/small-model": { "sequentialSubagents": false } }
	}`);
	assert.deepEqual(problems, []);
	assert.deepEqual(resolveRules(config, { provider: "strata", id: "small-model" }), []);
	// A model with no override still gets the provider rule.
	assert.deepEqual(resolveRules(config, STRATA), [
		{ rule: "sequentialSubagents", source: 'providers["strata"]', text: RULES.sequentialSubagents.text, textSource: "built-in" },
	]);
});

test("an unconfigured provider gets no rule", () => {
	const { config, problems } = parse(`{ "providers": { "strata": { "sequentialSubagents": true } } }`);
	assert.deepEqual(problems, []);
	assert.deepEqual(resolveRules(config, { provider: "openai", id: "gpt" }), []);
});

test("bad entries are reported and dropped, good values survive", () => {
	const { config, problems } = parse(`{
		"providers": { "strata": { "sequentialSubagents": true, "unknownRule": true }, "local-llama": { "sequentialSubagents": "yes" } },
		"modelOverrides": { "local-llama": { "sequentialSubagents": true } },
		"text": { "sequentialSubagents": "Run one subagent at a time." },
		"unknownKey": {}
	}`);
	assert.deepEqual(problems, [
		{ path: "providers.strata.unknownRule", message: 'unknown rule "unknownRule".' },
		{ path: "providers.local-llama.sequentialSubagents", message: "must be true or false." },
		{ path: "modelOverrides.local-llama", message: "key must be provider/modelId." },
		{ path: "unknownKey", message: 'unknown key "unknownKey".' },
	]);
	// The good value in the same entry survives, and the good text block survives.
	assert.deepEqual(resolveRules(config, STRATA), [
		{ rule: "sequentialSubagents", source: 'providers["strata"]', text: "Run one subagent at a time.", textSource: "text" },
	]);
});

test("modelOverrides keys must be provider/modelId", () => {
	const { config, problems } = parse(`{ "modelOverrides": { "strata": { "sequentialSubagents": true } } }`);
	assert.deepEqual(problems, [{ path: "modelOverrides.strata", message: "key must be provider/modelId." }]);
	// The value is kept, but a key without a model id can never match, so it resolves nothing.
	assert.deepEqual(resolveRules(config, STRATA), []);
});

test("wording comes from the provider entry, then the default, then the built-in text", () => {
	const { config, problems } = parse(`{
		"providers": {
			"strata": { "sequentialSubagents": true, "text": { "sequentialSubagents": "Provider wording." } },
			"local-llama": { "sequentialSubagents": true }
		}
	}`);
	assert.deepEqual(problems, []);

	assert.deepEqual(resolveRules(config, STRATA), [
		{
			rule: "sequentialSubagents",
			source: 'providers["strata"]',
			text: "Provider wording.",
			textSource: 'providers["strata"].text',
		},
	]);
	// A provider with no entry text falls back to the default, then the built-in text.
	assert.deepEqual(resolveRules(config, { provider: "local-llama", id: "qwen" })[0].textSource, "built-in");

	// A model entry text wins over its provider's text.
	const withModelText = parse(`{
		"providers": { "strata": { "sequentialSubagents": true, "text": { "sequentialSubagents": "Provider wording." } } },
		"modelOverrides": { "strata/small-model": { "text": { "sequentialSubagents": "Model wording." } } }
	}`);
	assert.deepEqual(resolveRules(withModelText.config, { provider: "strata", id: "small-model" })[0].text, "Model wording.");
});

test("text can be an array of lines", () => {
	const { config, problems } = parse(`{ "providers": { "strata": { "sequentialSubagents": true, "text": { "sequentialSubagents": ["Line one.", "Line two."] } } } }`);
	assert.deepEqual(problems, []);
	assert.equal(resolveRules(config, STRATA)[0].text, "Line one.\nLine two.");

	const bad = parse(`{ "text": { "sequentialSubagents": ["Line one.", ""] } }`);
	assert.deepEqual(bad.problems, [{ path: "text.sequentialSubagents", message: "must be a non-empty string, or an array of non-empty lines." }]);
});

test("the top-level text block is the default wording", () => {
	const withText = parse(`{ "text": { "sequentialSubagents": "Custom wording." } }`);
	assert.equal(defaultText(withText.config, "sequentialSubagents"), "Custom wording.");
	const withoutText = parse(`{}`);
	assert.equal(defaultText(withoutText.config, "sequentialSubagents"), RULES.sequentialSubagents.text);
	// A provider entry text wins over the default.
	const entryText = parse(`{ "text": { "sequentialSubagents": "Default." }, "providers": { "strata": { "sequentialSubagents": true, "text": { "sequentialSubagents": "Provider wording." } } } }`);
	assert.equal(resolveRules(entryText.config, STRATA)[0].text, "Provider wording.");
});

test("section names are valid Pi system prompt section tags", () => {
	for (const rule of Object.values(RULES)) {
		assert.match(rule.section, /^[a-z][a-z0-9_-]*$/);
		assert.notEqual(rule.section, "preamble");
	}
});

test("sections are added for a matching model and removed on a model switch", () => {
	const { config } = parse(`{ "providers": { "strata": { "sequentialSubagents": true } } }`);
	const sections: Record<string, string> = {};

	applySections(config, STRATA, sections);
	assert.deepEqual(Object.keys(sections), ["subagent_execution"]);
	assert.equal(sections.subagent_execution, RULES.sequentialSubagents.text);

	applySections(config, { provider: "local-llama", id: "qwen" }, sections);
	assert.deepEqual(sections, {});
});

test("report shows the model, the winning source, and problems", () => {
	const { config, problems } = parse(`{ "providers": { "strata": { "sequentialSubagents": true } }, "text": { "sequentialSubagents": 1 } }`);
	const report = formatReport({ configPath: "/tmp/x.jsonc", result: { config, problems }, model: STRATA });
	assert.match(report, /model: strata\/qwen3\.8-flash-next-iq2_xs/);
	assert.match(report, /subagent_execution> \(providers\["strata"\], text from built-in\)/);
	assert.match(report, /text\.sequentialSubagents: must be a non-empty string, or an array of non-empty lines\./);
	assert.match(report, /text from built-in\)/);
});
