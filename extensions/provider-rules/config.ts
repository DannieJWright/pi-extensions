// Config parsing, rule resolution, and report formatting for provider-prompt-rules.
// The extension reads this file; the just recipe `provider-rules check` runs the same code.

import { parseJsonc } from "../../lib/jsonc.ts";

export type RuleName = "sequentialSubagents";

export interface Rule {
	id: RuleName;
	/** System prompt section tag the wording is rendered into. */
	section: string;
	/** Built-in wording. Used when the config has no `text` override. */
	text: string;
}

/** Rules the config can turn on. Section names must match Pi's `[a-z][a-z0-9_-]*` rule. */
export const RULES: Record<RuleName, Rule> = {
	sequentialSubagents: {
		id: "sequentialSubagents",
		section: "subagent_execution",
		text: [
			"This provider handles one model request at a time.",
			"- Run one subagent at a time. Do not dispatch another while one is running.",
			"- Wait for each subagent to finish before starting the next. Use acp_delegate_wait to block for its result.",
			"- While a subagent is running, do not do other work and do not call tools.",
		].join("\n"),
	},
};

export type RuleText = Partial<Record<RuleName, string>>;

/** One config entry: rule values, and the wording for those rules at this level. */
export interface Entry {
	rules: Partial<Record<RuleName, boolean>>;
	text: RuleText;
}

export interface Config {
	/** Entries per provider id, keyed by provider id. */
	providers: Record<string, Entry>;
	/** Entries per model, keyed by `provider/modelId`. Wins over `providers`. */
	modelOverrides: Record<string, Entry>;
	/** Default wording per rule, used when no entry sets one. */
	text: RuleText;
}

export interface Problem {
	path: string;
	message: string;
}

export interface ParseResult {
	config: Config;
	problems: Problem[];
}

export interface ModelRef {
	provider: string;
	id: string;
}

export interface ActiveRule {
	rule: RuleName;
	/** Where the value came from, for reporting. */
	source: string;
	/** Wording: entry text, then the default text, then the built-in text. */
	text: string;
	/** Where the wording came from, for reporting. */
	textSource: string;
}

export function emptyConfig(): Config {
	return { providers: {}, modelOverrides: {}, text: {} };
}

function emptyEntry(): Entry {
	return { rules: {}, text: {} };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRuleName(value: string): value is RuleName {
	return Object.keys(RULES).includes(value);
}

/** Parse the config. Bad entries are dropped and reported; they never clobber a good value. */
export function parseConfig(text: string, sourceName: string): ParseResult {
	const raw = parseJsonc(text, sourceName);
	const config = emptyConfig();
	const problems: Problem[] = [];

	if (raw === null || raw === undefined) return { config, problems };
	if (!isObject(raw)) {
		problems.push({ path: "(root)", message: "must be an object." });
		return { config, problems };
	}

	for (const [key, value] of Object.entries(raw)) {
		if (key === "providers" || key === "modelOverrides") {
			config[key] = readEntries(value, key, key === "modelOverrides", problems);
			continue;
		}
		if (key === "text") {
			readTextMap(value, "text", config.text, problems);
			continue;
		}
		problems.push({ path: key, message: `unknown key "${key}".` });
	}

	return { config, problems };
}

function readTextMap(value: unknown, path: string, target: RuleText, problems: Problem[]): void {
	if (!isObject(value)) {
		problems.push({ path, message: "must be an object of rule strings." });
		return;
	}
	for (const [rule, wording] of Object.entries(value)) {
		if (!isRuleName(rule)) {
			problems.push({ path: `${path}.${rule}`, message: `unknown rule "${rule}".` });
			continue;
		}
		// A string, or an array of lines joined with a newline.
		const lines = Array.isArray(wording) ? wording : [wording];
		if (lines.some((line) => typeof line !== "string" || !line.trim())) {
			problems.push({ path: `${path}.${rule}`, message: "must be a non-empty string, or an array of non-empty lines." });
			continue;
		}
		target[rule] = lines.join("\n");
	}
}

function readEntries(
	value: unknown,
	path: string,
	requireSlash: boolean,
	problems: Problem[],
): Record<string, Entry> {
	const out: Record<string, Entry> = {};
	if (!isObject(value)) {
		problems.push({ path, message: "must be an object of entries." });
		return out;
	}

	for (const [key, entry] of Object.entries(value)) {
		const entryPath = `${path}.${key}`;
		if (requireSlash && !key.includes("/")) {
			problems.push({ path: entryPath, message: "key must be provider/modelId." });
		}
		if (!isObject(entry)) {
			problems.push({ path: entryPath, message: "must be an object of rule booleans and optional text." });
			continue;
		}

		const target = emptyEntry();
		for (const [name, item] of Object.entries(entry)) {
			if (name === "text") {
				readTextMap(item, `${entryPath}.text`, target.text, problems);
				continue;
			}
			if (!isRuleName(name)) {
				problems.push({ path: `${entryPath}.${name}`, message: `unknown rule "${name}".` });
				continue;
			}
			if (typeof item !== "boolean") {
				problems.push({ path: `${entryPath}.${name}`, message: "must be true or false." });
				continue;
			}
			target.rules[name] = item;
		}
		if (Object.keys(target.rules).length > 0 || Object.keys(target.text).length > 0) out[key] = target;
	}

	return out;
}

/** Deepest defined level wins: model override, then provider. */
export function resolveRules(config: Config, model: ModelRef): ActiveRule[] {
	const active: ActiveRule[] = [];

	for (const rule of Object.keys(RULES) as RuleName[]) {
		const key = `${model.provider}/${model.id}`;
		const modelEntry = config.modelOverrides[key];
		const providerEntry = config.providers[model.provider];

		const modelValue = modelEntry?.rules[rule];
		const providerValue = providerEntry?.rules[rule];
		const value = modelValue ?? providerValue;
		if (!value) continue;

		const source = modelValue !== undefined ? `modelOverrides["${key}"]` : `providers["${model.provider}"]`;

		// Wording: this level's text, then the level that set the value, then the default, then the built-in.
		const modelText = modelEntry?.text[rule];
		const providerText = providerEntry?.text[rule];
		const entryText = modelText ?? providerText;
		const textSource = entryText !== undefined
			? (modelText !== undefined ? `modelOverrides["${key}"].text` : `providers["${model.provider}"].text`)
			: (config.text[rule] !== undefined ? "text" : "built-in");

		active.push({ rule, source, text: entryText ?? defaultText(config, rule), textSource });
	}

	return active;
}

/** Default wording for a rule: the top-level `text` override when present, else the built-in text. */
export function defaultText(config: Config, rule: RuleName): string {
	return config.text[rule] ?? RULES[rule].text;
}

/** Apply the rules for `model` to the mutable system prompt sections. */
export function applySections(config: Config, model: ModelRef, sections: Record<string, string>): ActiveRule[] {
	const active = resolveRules(config, model);
	for (const rule of Object.keys(RULES) as RuleName[]) {
		const name = RULES[rule].section;
		const hit = active.find((entry) => entry.rule === rule);
		if (hit) sections[name] = hit.text;
		else delete sections[name];
	}
	return active;
}

export interface ReportInput {
	configPath: string;
	result: ParseResult;
	model?: ModelRef;
}

/** Plain-text report for `just provider-rules check` and the `/provider-rules` command. */
export function formatReport(input: ReportInput): string {
	const lines = [`provider-prompt-rules: ${input.configPath}`];

	if (input.model) {
		const key = `${input.model.provider}/${input.model.id}`;
		const active = resolveRules(input.result.config, input.model);
		lines.push(`model: ${key}`);
		if (active.length === 0) {
			lines.push("active rules: none");
		} else {
			lines.push("active rules:");
			for (const hit of active) {
				lines.push(`  ${hit.rule} -> <${RULES[hit.rule].section}> (${hit.source}, text from ${hit.textSource})`);
			}
		}
	} else {
		lines.push("model: not known");
	}

	const entries = [
		...Object.entries(input.result.config.providers).map(([key, entry]) => [`providers.${key}`, entry]),
		...Object.entries(input.result.config.modelOverrides).map(([key, entry]) => [`modelOverrides.${key}`, entry]),
	];
	if (entries.length > 0) {
		lines.push("configured:");
		for (const [path, entry] of entries) {
			for (const [rule, value] of Object.entries(entry.rules)) {
				lines.push(`  ${path}.${rule} = ${value}`);
			}
			for (const [rule, wording] of Object.entries(entry.text)) {
				lines.push(`  ${path}.text.${rule} = ${wording}`);
			}
		}
	}

	if (input.result.problems.length > 0) {
		lines.push("problems:");
		for (const problem of input.result.problems) {
			lines.push(`  ${problem.path}: ${problem.message}`);
		}
	}

	return lines.join("\n");
}
