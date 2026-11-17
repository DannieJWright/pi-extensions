import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig, formatReport, resolveRecovery, type ModelRef } from "./config.ts";
import { initialState, isTruncatedThinking, planTurn, type TurnFacts } from "./recovery.ts";

const SOURCE = "test-config";
const LOCAL = { provider: "ollama", id: "qwen3.8-flash-next-iq2_xs" };

function recoveryFor(configText: string, model: ModelRef = LOCAL) {
	const { config, problems } = parseConfig(configText, SOURCE);
	assert.deepEqual(problems, []);
	return resolveRecovery(config, model);
}

/** A turn whose whole response went to thinking. */
function truncated(overrides: Partial<TurnFacts> = {}): TurnFacts {
	return {
		outcome: "completed",
		stopReason: "length",
		hasText: false,
		toolResults: 0,
		thinkingLevel: "high",
		...overrides,
	};
}

test("the built-in recovery settings are the defaults", () => {
	const recovery = recoveryFor(`{ "localProviders": ["ollama"] }`);
	assert.equal(recovery.allowed, true);
	assert.deepEqual(recovery.settings, {
		prompt: "Work through the task one at a time.",
		maxAttempts: 3,
		thinkingLevel: "low",
		display: true,
	});
	assert.deepEqual(recovery.sources, {
		prompt: "built-in",
		maxAttempts: "built-in",
		thinkingLevel: "built-in",
		display: "built-in",
	});
});

test("the gate is the localProviders list", () => {
	const recovery = recoveryFor(`{ "localProviders": ["ollama"] }`, { provider: "openai", id: "gpt" });
	assert.equal(recovery.allowed, false);
	// An empty list gates everything off.
	assert.equal(recoveryFor(`{}`).allowed, false);
});

test("recovery fields resolve per field: model entry > provider entry > default > built-in", () => {
	const recovery = recoveryFor(`{
		"localProviders": ["ollama"],
		"recovery": { "prompt": "Top-level prompt.", "maxAttempts": 5 },
		"providers": { "ollama": { "recovery": { "prompt": "Provider prompt.", "thinkingLevel": "minimal" } } },
		"modelOverrides": { "ollama/qwen3.8-flash-next-iq2_xs": { "recovery": { "prompt": "Model prompt." } } }
	}`);
	assert.equal(recovery.settings.prompt, "Model prompt.");
	assert.equal(recovery.sources.prompt, 'modelOverrides["ollama/qwen3.8-flash-next-iq2_xs"].recovery.prompt');
	assert.equal(recovery.settings.thinkingLevel, "minimal");
	assert.equal(recovery.sources.thinkingLevel, 'providers["ollama"].recovery.thinkingLevel');
	assert.equal(recovery.settings.maxAttempts, 5);
	assert.equal(recovery.sources.maxAttempts, "recovery.maxAttempts");
	assert.equal(recovery.settings.display, true);
	assert.equal(recovery.sources.display, "built-in");
});

test("bad recovery fields are reported and dropped, good fields survive", () => {
	const { config, problems } = parseConfig(`{
		"localProviders": ["ollama", ""],
		"providers": { "ollama": { "recovery": { "prompt": ["Line one.", "Line two."], "maxAttempts": 0, "thinkingLevel": "ultra", "display": "yes", "unknownField": true } } }
	}`, SOURCE);
	assert.deepEqual(problems, [
		{ path: "localProviders", message: "must be an array of provider ids." },
		{ path: "providers.ollama.recovery.maxAttempts", message: "must be a positive integer." },
		{ path: "providers.ollama.recovery.thinkingLevel", message: "must be one of minimal, low, medium, high, xhigh, max, or null to leave the level unchanged." },
		{ path: "providers.ollama.recovery.display", message: "must be true or false." },
		{ path: "providers.ollama.recovery.unknownField", message: 'unknown recovery field "unknownField".' },
	]);
	assert.equal(resolveRecovery(config, LOCAL).settings.prompt, "Line one.\nLine two.");
});

test("thinking level null leaves the level unchanged", () => {
	const recovery = recoveryFor(`{ "localProviders": ["ollama"], "providers": { "ollama": { "recovery": { "thinkingLevel": null } } } }`);
	assert.equal(recovery.settings.thinkingLevel, null);
	const { decision, state } = planTurn(initialState(), recovery, truncated());
	assert.equal(decision.action, "recover");
	assert.equal(decision.setLevel, null);
	assert.equal(state.pendingRestore, null);
});

test("trigger: only a completed length stop with no text and no tool calls", () => {
	assert.equal(isTruncatedThinking(truncated()), true);
	assert.equal(isTruncatedThinking(truncated({ hasText: true })), false);
	assert.equal(isTruncatedThinking(truncated({ toolResults: 2 })), false);
	assert.equal(isTruncatedThinking(truncated({ outcome: "aborted" })), false);
	assert.equal(isTruncatedThinking(truncated({ outcome: "error" })), false);
	assert.equal(isTruncatedThinking(truncated({ stopReason: "end_turn" })), false);
});

test("a truncated turn plans a revert, the injected prompt, and the lower level", () => {
	const recovery = recoveryFor(`{ "localProviders": ["ollama"] }`);
	const { decision, state } = planTurn(initialState(), recovery, truncated());
	assert.deepEqual(decision, {
		restore: null,
		action: "recover",
		reset: false,
		prompt: "Work through the task one at a time.",
		display: true,
		setLevel: "low",
	});
	assert.equal(state.attempts, 1);
	// The level to put back after the recovery request is the one this turn ran with.
	assert.equal(state.pendingRestore, "high");
});

test("the level is restored after the recovery turn, and stays the original across repeats", () => {
	const recovery = recoveryFor(`{ "localProviders": ["ollama"] }`);
	let state = initialState();

	// Turn 1 truncates: lower to low, remember high.
	const first = planTurn(state, recovery, truncated({ thinkingLevel: "high" }));
	state = first.state;
	assert.equal(first.decision.setLevel, "low");
	assert.equal(state.pendingRestore, "high");

	// Turn 2 (the recovery turn) truncates again: restore high, then lower again.
	const second = planTurn(state, recovery, truncated({ thinkingLevel: "low" }));
	assert.equal(second.decision.restore, "high");
	assert.equal(second.decision.action, "recover");
	assert.equal(second.state.pendingRestore, "high");
	assert.equal(second.state.attempts, 2);

	// Turn 3 completes normally: restore, and the streak ends.
	const third = planTurn(second.state, recovery, truncated({ thinkingLevel: "low", hasText: true, stopReason: "end_turn" }));
	assert.equal(third.decision.restore, "high");
	assert.equal(third.decision.action, "none");
	assert.equal(third.decision.reset, true);
	assert.equal(third.state.attempts, 0);
	assert.equal(third.state.pendingRestore, null);
});

test("the attempt limit stops recovery and is reported once", () => {
	const recovery = recoveryFor(`{ "localProviders": ["ollama"], "providers": { "ollama": { "recovery": { "maxAttempts": 2 } } } }`);
	let state = initialState();

	const first = planTurn(state, recovery, truncated());
	state = first.state;
	assert.equal(first.decision.action, "recover");

	state = planTurn(state, recovery, truncated()).state;
	assert.equal(state.attempts, 2);

	const third = planTurn(state, recovery, truncated());
	assert.equal(third.decision.action, "limit");
	assert.equal(third.decision.notify, true);
	assert.equal(third.state.attempts, 2);

	// A further truncated turn does not report again; a normal turn clears the limit.
	const fourth = planTurn(third.state, recovery, truncated());
	assert.equal(fourth.decision.action, "limit");
	assert.equal(fourth.decision.notify, false);
	const after = planTurn(fourth.state, recovery, truncated({ hasText: true, stopReason: "end_turn" }));
	assert.equal(after.decision.reset, true);
	assert.equal(after.state.reportedLimit, false);
	assert.equal(planTurn(after.state, recovery, truncated()).decision.action, "recover");
});

test("a gated provider plans nothing", () => {
	const recovery = recoveryFor(`{ "localProviders": ["ollama"] }`, { provider: "openai", id: "gpt" });
	const { decision, state } = planTurn({ ...initialState(), attempts: 2 }, recovery, truncated());
	assert.equal(decision.action, "none");
	// The counter is not reset by a turn the gate does not cover.
	assert.equal(state.attempts, 2);
});

test("an aborted or errored turn does not reset the counter, but still restores the level", () => {
	const recovery = recoveryFor(`{ "localProviders": ["ollama"] }`);
	const state = { attempts: 1, pendingRestore: "high", reportedLimit: false };
	const { decision, state: next } = planTurn(state, recovery, truncated({ outcome: "error", stopReason: "error" }));
	assert.equal(decision.restore, "high");
	assert.equal(decision.action, "none");
	assert.equal(decision.reset, false);
	assert.equal(next.attempts, 1);
	assert.equal(next.pendingRestore, null);
});

test("the report shows the recovery settings and the gate", () => {
	const { config, problems } = parseConfig(`{ "localProviders": ["ollama"], "providers": { "ollama": { "recovery": { "maxAttempts": 2 } } } }`, SOURCE);
	assert.deepEqual(problems, []);
	const report = formatReport({ configPath: "/tmp/x.jsonc", result: { config, problems }, model: LOCAL });
	assert.match(report, /^provider-rules: /);
	assert.match(report, /recovery: allowed \(provider "ollama" is in localProviders\)/);
	assert.match(report, /maxAttempts = 2 \(providers\["ollama"\]\.recovery\.maxAttempts\)/);
	assert.match(report, /prompt = "Work through the task one at a time." \(built-in\)/);
	assert.match(report, /providers\.ollama\.recovery\.maxAttempts = 2/);

	const gated = formatReport({ configPath: "/tmp/x.jsonc", result: { config, problems }, model: { provider: "openai", id: "gpt" } });
	assert.match(gated, /recovery: not allowed \(provider "openai" is not in localProviders\)/);

	const legacy = formatReport({ configPath: "/tmp/legacy.jsonc", result: { config, problems }, legacy: true });
	assert.match(legacy, /note: read from the legacy path/);
});
