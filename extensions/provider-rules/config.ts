// Config parsing, rule resolution, recovery settings, and report formatting for provider-rules.
// The extension reads this file; the just recipe `provider-rules check` runs the same code.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseJsonc } from "../../lib/jsonc.ts";

export const CONFIG_NAME = "provider-rules.jsonc";
/** The old name is still read as a fallback, and the report says which file was used. */
export const LEGACY_CONFIG_NAME = "provider-prompt-rules.jsonc";

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

/** Thinking levels the extension API accepts (`pi.setThinkingLevel`). `off` is not one of them. */
export type ThinkingLevelName = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS: readonly ThinkingLevelName[] = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** What the extension does when a response is truncated by thinking. */
export interface RecoverySettings {
	/** Text injected as a user-role message before the retry. */
	prompt: string;
	/** Consecutive recovery attempts per session, then stop and notify. */
	maxAttempts: number;
	/** Level used for the recovery request. Null leaves the level unchanged. */
	thinkingLevel: ThinkingLevelName | null;
	/** Whether the injected message is shown in the transcript UI. */
	display: boolean;
}

export const DEFAULT_RECOVERY: RecoverySettings = {
	prompt: "Work through the task one at a time.",
	maxAttempts: 3,
	thinkingLevel: "low",
	display: true,
};

/** One config entry: rule values, the wording for those rules, and recovery settings. */
export interface Entry {
	rules: Partial<Record<RuleName, boolean>>;
	text: RuleText;
	recovery: Partial<RecoverySettings>;
}

export interface Config {
	/** Entries per provider id, keyed by provider id. */
	providers: Record<string, Entry>;
	/** Entries per model, keyed by `provider/modelId`. Wins over `providers`. */
	modelOverrides: Record<string, Entry>;
	/** Default wording per rule, used when no entry sets one. */
	text: RuleText;
	/** Providers the recovery behavior applies to. */
	localProviders: string[];
	/** Default recovery settings, used when no entry sets a field. */
	recovery: Partial<RecoverySettings>;
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
	return { providers: {}, modelOverrides: {}, text: {}, localProviders: [], recovery: {} };
}

function emptyEntry(): Entry {
	return { rules: {}, text: {}, recovery: {} };
}

export function defaultConfigPath(): string {
	return join(homedir(), ".pi", "agent", CONFIG_NAME);
}

export function legacyConfigPath(): string {
	return join(homedir(), ".pi", "agent", LEGACY_CONFIG_NAME);
}

/** Prefer the new path; fall back to the legacy name so an existing config keeps working. */
export function pickConfigPath(preferred?: string): { path: string; legacy: boolean } {
	if (preferred) return { path: resolve(preferred), legacy: false };
	const primary = defaultConfigPath();
	if (existsSync(primary)) return { path: primary, legacy: false };
	const legacy = legacyConfigPath();
	if (existsSync(legacy)) return { path: legacy, legacy: true };
	return { path: primary, legacy: false };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRuleName(value: string): value is RuleName {
	return Object.keys(RULES).includes(value);
}

function isThinkingLevel(value: unknown): value is ThinkingLevelName {
	return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevelName);
}

/** Join a string or an array of lines into one string. */
function readTextValue(value: unknown, path: string, problems: Problem[]): string | undefined {
	const lines = Array.isArray(value) ? value : [value];
	if (lines.some((line) => typeof line !== "string" || !line.trim())) return undefined;
	return lines.join("\n");
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
		if (key === "localProviders") {
			if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
				problems.push({ path: key, message: "must be an array of provider ids." });
				continue;
			}
			config.localProviders = value.map((entry) => String(entry).trim());
			continue;
		}
		if (key === "recovery") {
			readRecovery(value, "recovery", config.recovery, problems);
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
		const text = readTextValue(wording, `${path}.${rule}`, problems);
		if (text === undefined) {
			problems.push({ path: `${path}.${rule}`, message: "must be a non-empty string, or an array of non-empty lines." });
			continue;
		}
		target[rule] = text;
	}
}

const RECOVERY_FIELD_PROBLEMS: Record<keyof RecoverySettings, string> = {
	prompt: "must be a non-empty string, or an array of non-empty lines.",
	maxAttempts: "must be a positive integer.",
	thinkingLevel: `must be one of ${THINKING_LEVELS.join(", ")}, or null to leave the level unchanged.`,
	display: "must be true or false.",
};

/** Read one recovery block. Bad fields are dropped and reported; good fields survive. */
function readRecovery(value: unknown, path: string, target: Partial<RecoverySettings>, problems: Problem[]): void {
	if (!isObject(value)) {
		problems.push({ path, message: "must be an object of recovery settings." });
		return;
	}
	for (const [field, item] of Object.entries(value)) {
		const fieldPath = `${path}.${field}`;
		if (!(field in RECOVERY_FIELD_PROBLEMS)) {
			problems.push({ path: fieldPath, message: `unknown recovery field "${field}".` });
			continue;
		}
		if (field === "prompt") {
			const text = readTextValue(item, fieldPath, problems);
			if (text === undefined) {
				problems.push({ path: fieldPath, message: RECOVERY_FIELD_PROBLEMS.prompt });
				continue;
			}
			target.prompt = text;
			continue;
		}
		if (field === "maxAttempts") {
			if (typeof item !== "number" || !Number.isInteger(item) || item < 1) {
				problems.push({ path: fieldPath, message: RECOVERY_FIELD_PROBLEMS.maxAttempts });
				continue;
			}
			target.maxAttempts = item;
			continue;
		}
		if (field === "thinkingLevel") {
			if (item !== null && !isThinkingLevel(item)) {
				problems.push({ path: fieldPath, message: RECOVERY_FIELD_PROBLEMS.thinkingLevel });
				continue;
			}
			target.thinkingLevel = item;
			continue;
		}
		if (typeof item !== "boolean") {
			problems.push({ path: fieldPath, message: RECOVERY_FIELD_PROBLEMS.display });
			continue;
		}
		target.display = item;
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
			problems.push({ path: entryPath, message: "must be an object of rule booleans, optional text, and optional recovery." });
			continue;
		}

		const target = emptyEntry();
		for (const [name, item] of Object.entries(entry)) {
			if (name === "text") {
				readTextMap(item, `${entryPath}.text`, target.text, problems);
				continue;
			}
			if (name === "recovery") {
				readRecovery(item, `${entryPath}.recovery`, target.recovery, problems);
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
		if (Object.keys(target.rules).length > 0 || Object.keys(target.text).length > 0 || Object.keys(target.recovery).length > 0) out[key] = target;
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

export interface ActiveRecovery {
	settings: RecoverySettings;
	/** Where each field came from, for reporting. */
	sources: Record<keyof RecoverySettings, string>;
	/** Whether this model's provider is in `localProviders`. */
	allowed: boolean;
}

const RECOVERY_FIELDS: (keyof RecoverySettings)[] = ["prompt", "maxAttempts", "thinkingLevel", "display"];

/** Per field, deepest defined level wins: model entry > provider entry > top-level default > built-in. */
export function resolveRecovery(config: Config, model: ModelRef): ActiveRecovery {
	const key = `${model.provider}/${model.id}`;
	const modelEntry = config.modelOverrides[key];
	const providerEntry = config.providers[model.provider];

	const settings = { ...DEFAULT_RECOVERY };
	const sources: Record<keyof RecoverySettings, string> = {};

	for (const field of RECOVERY_FIELDS) {
		const modelValue = modelEntry?.recovery[field];
		const providerValue = providerEntry?.recovery[field];
		const defaultValue = config.recovery[field];
		// An explicit null is a value (it means "leave the level unchanged"), so check for
		// undefined rather than using ??.
		const explicit = modelValue !== undefined ? modelValue : providerValue !== undefined ? providerValue : defaultValue;
		const value = explicit !== undefined ? explicit : DEFAULT_RECOVERY[field];
		settings[field] = value as RecoverySettings[field];
		if (modelValue !== undefined) sources[field] = `modelOverrides["${key}"].recovery.${field}`;
		else if (providerValue !== undefined) sources[field] = `providers["${model.provider}"].recovery.${field}`;
		else if (defaultValue !== undefined) sources[field] = `recovery.${field}`;
		else sources[field] = "built-in";
	}

	return { settings, sources, allowed: config.localProviders.includes(model.provider) };
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
	/** Set when the legacy config path was the one read. */
	legacy?: boolean;
}

/** Plain-text report for `just provider-rules check` and the `/provider-rules` command. */
export function formatReport(input: ReportInput): string {
	const lines = [`provider-rules: ${input.configPath}`];
	if (input.legacy) lines.push("note: read from the legacy path; rename it to provider-rules.jsonc.");

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

		const recovery = resolveRecovery(input.result.config, input.model);
		const gate = recovery.allowed
			? `provider "${input.model.provider}" is in localProviders`
			: `provider "${input.model.provider}" is not in localProviders`;
		lines.push(`recovery: ${recovery.allowed ? "allowed" : "not allowed"} (${gate})`);
		for (const field of RECOVERY_FIELDS) {
			const value = field === "prompt" ? JSON.stringify(recovery.settings[field]) : String(recovery.settings[field]);
			lines.push(`  ${field} = ${value} (${recovery.sources[field]})`);
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
			for (const [field, value] of Object.entries(entry.recovery)) {
				lines.push(`  ${path}.recovery.${field} = ${JSON.stringify(value)}`);
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
