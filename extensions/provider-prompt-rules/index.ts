// Pi extension: add provider-scoped prompt rules to the system prompt.
// Config: ~/.pi/agent/provider-prompt-rules.jsonc (see README.md).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applySections,
	emptyConfig,
	formatReport,
	parseConfig,
	type ModelRef,
	type ParseResult,
} from "./config.ts";

const CONFIG_NAME = "provider-prompt-rules.jsonc";

function defaultConfigPath(): string {
	return join(homedir(), ".pi", "agent", CONFIG_NAME);
}

function modelRef(model: { provider: string; id: string } | undefined): ModelRef | undefined {
	if (!model) return undefined;
	return { provider: model.provider, id: model.id };
}

export default function providerPromptRules(pi: ExtensionAPI): void {
	let result: ParseResult = { config: emptyConfig(), problems: [] };
	let configPath = defaultConfigPath();

	const report = (ctx: ExtensionContext, level: "info" | "warning") => {
		const text = formatReport({ configPath, result, model: modelRef(ctx.model) });
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
			if (ctx.hasUI && ctx.ui) ctx.ui.notify(`provider-prompt-rules: ${message}`, "error");
			else process.stderr.write(`provider-prompt-rules: ${message}\n`);
			return;
		}

		result = parseConfig(text, configPath);
		if (result.problems.length > 0) report(ctx, "warning");
	}

	pi.on("session_start", async (_event, ctx) => {
		await load(ctx);
	});

	// Resolved per run, so a `/model` switch takes effect on the next run.
	pi.on("before_agent_start", (event, ctx) => {
		const model = modelRef(ctx.model);
		if (!model) return;
		applySections(result.config, model, event.systemPromptOptions.sections);
	});

	pi.registerCommand("provider-rules", {
		description: "Show the prompt rules in effect for the current model (re-reads the config)",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg) configPath = resolve(arg);
			await load(ctx);
			report(ctx, result.problems.length > 0 ? "warning" : "info");
		},
	});
}
