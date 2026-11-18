#!/usr/bin/env node
// CLI: validate a feature ledger file. Used by `just feature-ledger check`.
// Default target is the reference example schema/ledger.yaml. Exits 1 on problems.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLedger } from "./ledger.ts";

const USAGE = `usage: node check.ts [path]

  path  ledger file (default the reference example schema/ledger.yaml)
  -h, --help  show this text
`;

export async function run(argv: string[]): Promise<number> {
	if (argv.includes("-h") || argv.includes("--help")) {
		console.log(USAGE);
		return 0;
	}
	const path = argv[0] ?? resolve(fileURLToPath(new URL("../../schema/ledger.yaml", import.meta.url)));
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		console.error(`feature-ledger check: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	const { ledger, problems } = parseLedger(text);
	if (problems.length > 0) {
		console.error(`feature-ledger check: ${path}`);
		for (const problem of problems) console.error(`  ${problem}`);
		return 1;
	}
	console.log(`feature-ledger check: ${path} parses (${ledger!.features.length} features)`);
	return 0;
}

if (process.argv[1] && process.argv[1].endsWith("check.ts")) {
	process.exitCode = await run(process.argv.slice(2));
}
