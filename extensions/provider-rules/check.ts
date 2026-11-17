#!/usr/bin/env node
// CLI: validate the provider rules config and print the effective rules and recovery settings.
// Used by `just provider-rules check`. Exits 1 when the config has problems.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { formatReport, parseConfig, pickConfigPath, type ModelRef } from "./config.ts";

const USAGE = `usage: node check.ts [options]

  --config <path>          config file (default ~/.pi/agent/provider-rules.jsonc, or the legacy
                           provider-prompt-rules.jsonc when only that one exists)
  --model <provider/id>    report the rules for this model
  -h, --help               show this text
`;

function parseModel(value: string): ModelRef | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

export async function run(argv: string[]): Promise<number> {
	const picked = pickConfigPath();
	let configPath = picked.path;
	let legacy = picked.legacy;
	let model: ModelRef | undefined;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "-h" || arg === "--help") {
			process.stdout.write(USAGE);
			return 0;
		}
		if (arg === "--config" || arg === "--model") {
			const value = argv[i + 1];
			if (!value) {
				process.stderr.write(`provider-rules: ${arg} needs a value\n`);
				return 2;
			}
			if (arg === "--config") {
				configPath = resolve(value);
				legacy = false;
			} else {
				model = parseModel(value);
				if (!model) {
					process.stderr.write(`provider-rules: --model needs provider/modelId\n`);
					return 2;
				}
			}
			i += 1;
			continue;
		}
		process.stderr.write(`provider-rules: unknown argument: ${arg}\n${USAGE}`);
		return 2;
	}

	let text: string;
	try {
		text = await readFile(configPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			process.stdout.write(`provider-rules: ${configPath} does not exist (nothing configured).\n`);
			return 0;
		}
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`provider-rules: ${message}\n`);
		return 1;
	}

	const result = parseConfig(text, configPath);
	process.stdout.write(`${formatReport({ configPath, result, model, legacy })}\n`);
	return result.problems.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	run(process.argv.slice(2)).then((code) => process.exit(code));
}
