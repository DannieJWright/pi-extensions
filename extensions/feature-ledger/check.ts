#!/usr/bin/env node
// CLI: validate a feature ledger file. Used by `just feature-ledger check`.
// Thin wrapper over checkLedger in ledger.ts, which the ledger_check tool also calls,
// so the CLI and the tool cannot disagree. The check logic is for real ledgers; the
// default target is the reference example under the skill. Exits 1 on problems.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLedger, parseLedger } from "./ledger.ts";

const USAGE = `usage: node check.ts [path]

  path  ledger file (default the reference example skills/feature-ledger/references/ledger.yaml)
  -h, --help  show this text
`;

export async function run(argv: string[]): Promise<number> {
	if (argv.includes("-h") || argv.includes("--help")) {
		console.log(USAGE);
		return 0;
	}
	const path = argv[0] ?? resolve(fileURLToPath(new URL("../../skills/feature-ledger/references/ledger.yaml", import.meta.url)));
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		console.error(`feature-ledger check: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	const problems = checkLedger(text);
	if (problems.length > 0) {
		console.error(`feature-ledger check: ${path}`);
		for (const problem of problems) console.error(`  ${problem}`);
		return 1;
	}
	// Same core as the ledger_check tool. parseLedger is called only for the feature count.
	const { ledger } = parseLedger(text);
	console.log(`feature-ledger check: ${path} parses (${ledger!.features.length} features)`);
	return 0;
}

if (process.argv[1] && process.argv[1].endsWith("check.ts")) {
	process.exitCode = await run(process.argv.slice(2));
}
