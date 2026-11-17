// Pi extension: provider-scoped prompt rules, and recovery when a response is truncated by thinking.
// Config: ~/.pi/agent/provider-rules.jsonc (see README.md).

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applySections,
	emptyConfig,
	formatReport,
	parseConfig,
	pickConfigPath,
	resolveRecovery,
	type ModelRef,
	type ParseResult,
} from "./config.ts";
import {
	initialState,
	limitMessage,
	planTurn,
	RECOVERY_CUSTOM_TYPE,
	type RecoveryState,
	type TurnFacts,
} from "./recovery.ts";

function modelRef(model: { provider: string; id: string } | undefined): ModelRef | undefined {
	if (!model) return undefined;
	return { provider: model.provider, id: model.id };
}

export default function providerRules(pi: ExtensionAPI): void {
	let result: ParseResult = { config: emptyConfig(), problems: [] };
	let configPath = pickConfigPath().path;
	let legacy = false;
	let state: RecoveryState = initialState();

	const report = (ctx: ExtensionContext, level: "info" | "warning") => {
		const text = formatReport({ configPath, result, model: modelRef(ctx.model), legacy });
		if (ctx.hasUI && ctx.ui) ctx.ui.notify(text, level);
		else process.stderr.write(`${text}\n`);
	};

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning") => {
		const text = `provider-rules: ${message}`;
		if (ctx.hasUI && ctx.ui) ctx.ui.notify(text, level);
		else process.stderr.write(`${text}\n`);
	};

	async function load(ctx: ExtensionContext): Promise<void> {
		let text: string;
		try {
			text = await readFile(configPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				result = { config: emptyConfig(), problems: [] };
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI && ctx.ui) ctx.ui.notify(`provider-rules: ${message}`, "error");
			else process.stderr.write(`provider-rules: ${message}\n`);
			return;
		}

		result = parseConfig(text, configPath);
		if (result.problems.length > 0) report(ctx, "warning");
	}

	function restoreLevel(ctx: ExtensionContext): void {
		if (!state.pendingRestore) return;
		const level = state.pendingRestore;
		state = { ...state, pendingRestore: null };
		pi.setThinkingLevel(level);
		notify(ctx, `thinking level restored to ${level}.`, "info");
	}

	pi.on("session_start", async (_event, ctx) => {
		const picked = pickConfigPath();
		configPath = picked.path;
		legacy = picked.legacy;
		state = initialState();
		await load(ctx);
	});

	// Resolved per run, so a `/model` switch takes effect on the next run.
	pi.on("before_agent_start", (event, ctx) => {
		const model = modelRef(ctx.model);
		if (!model) return;
		applySections(result.config, model, event.systemPromptOptions.sections);
	});

	// A response that spent the whole output budget on thinking is reverted, the recovery prompt is
	// injected, and the run continues. Pi does not retry a length stop on its own.
	pi.on("turn_end", async (event, ctx) => {
		const model = modelRef(ctx.model);
		if (!model || event.message.role !== "assistant") return undefined;

		const recovery = resolveRecovery(result.config, model);
		if (!recovery.allowed) return undefined;

		const facts: TurnFacts = {
			outcome: event.outcome,
			stopReason: event.message.stopReason,
			hasText: event.message.content.some((block) => block.type === "text"),
			toolResults: event.toolResults.length,
			thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel(),
		};

		const { decision, state: next } = planTurn(state, recovery, facts);
		state = next;

		// Restore first, then lower again for the next attempt.
		if (decision.restore) {
			pi.setThinkingLevel(decision.restore);
			notify(ctx, `thinking level restored to ${decision.restore}.`, "info");
		}

		if (decision.action === "recover") {
			if (decision.setLevel) pi.setThinkingLevel(decision.setLevel);
			const attempt = state.attempts;
			const levelNote = decision.setLevel ? `, thinking level ${decision.setLevel} for this request` : "";
			notify(
				ctx,
					`thinking-only response was truncated; reverted the thinking block and continued with the recovery prompt (attempt ${attempt} of ${recovery.settings.maxAttempts})${levelNote}.`,
					"warning",
				);
				return {
					entries: [
						...event.entries,
						{ type: "context_edit", targetId: event.messageEntryId, replacement: null },
						{ type: "custom_message", customType: RECOVERY_CUSTOM_TYPE, content: decision.prompt!, display: decision.display! },
					],
					continue: true,
				};
		}

		if (decision.action === "limit" && decision.notify) {
			notify(ctx, limitMessage(recovery.settings.maxAttempts), "warning");
		}
		return undefined;
	});

	// Safety net: a run that ends before a turn completes never reaches turn_end.
	pi.on("agent_settled", async (_event, ctx) => {
		restoreLevel(ctx);
	});

	pi.registerCommand("provider-rules", {
		description: "Show the prompt rules and recovery settings in effect for the current model (re-reads the config)",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg) {
				configPath = resolve(arg);
				legacy = false;
			}
			await load(ctx);
			report(ctx, result.problems.length > 0 ? "warning" : "info");
		},
	});
}
