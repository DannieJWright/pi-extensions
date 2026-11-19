// Test harness for the feature-ledger extension. It provides a fake ExtensionAPI
// and a fake ExtensionContext so a test can call a tool's execute without a Pi
// session, and a temporary git repository with a ledger. Test-only: the extension
// code must not import this file at runtime. Node built-ins only.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensureParent, ledgerPath } from "./ledger.ts";

const run = promisify(execFile);

// The same shape the extension uses. Defined here, not imported from the Pi
// package, so the harness runs without that package installed.
export type ExecResult = { code: number; stdout: string; stderr: string };
// Pi calls pi.exec(command, args, { cwd }); the core Exec type takes cwd as a string.
// Accept both so the harness serves the extension wrapper and a test call directly.
export type ExecInput = (command: string, args: string[], cwd: string | { cwd?: string }) => Promise<ExecResult>;

export type ToolResult = { content: [{ type: string; text: string }]; details: Record<string, unknown>; isError?: boolean };

export type ToolDefinition = {
	name: string;
	label?: string;
	description: string;
	parameters: unknown;
	execute: (toolCallId: string | null, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: FakeContext) => Promise<ToolResult>;
};

export interface FakeApi {
	registerTool(tool: ToolDefinition): void;
	exec: ExecInput;
	tools: Record<string, ToolDefinition>;
}

export interface FakeContext {
	cwd: string;
}

export async function exec(command: string, args: string[], cwdOrOptions: string | { cwd?: string }): Promise<ExecResult> {
	const cwd = typeof cwdOrOptions === "string" ? cwdOrOptions : cwdOrOptions?.cwd ?? "";
	try {
		const { stdout, stderr } = await run(command, args, { cwd });
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
	}
}

export function createFakeApi(): FakeApi {
	const api: FakeApi = {
		tools: {},
		registerTool(tool: ToolDefinition): void {
			api.tools[tool.name] = tool;
		},
		exec,
	};
	return api;
}

export function createFakeContext(cwd: string): FakeContext {
	return { cwd };
}

// A temporary git repository with a ledger under plan/<branch>/, mirroring the
// project layout (plan/ is gitignored). branch is the real branch name, read from
// the symbolic ref before the first commit.
export async function setupRepo(ledgerText: string): Promise<{ dir: string; branch: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "feature-ledger-"));
	await exec("git", ["-c", "init.defaultBranch=feature-x", "init", "-q"], dir);
	await exec("git", ["config", "user.email", "ledger-test@example.com"], dir);
	await exec("git", ["config", "user.name", "Ledger Test"], dir);
	await writeFile(join(dir, ".gitignore"), "plan/\n");
	const branch = (await exec("git", ["symbolic-ref", "--short", "HEAD"], dir)).stdout.trim();
	await writeFile(join(dir, "README.md"), "seed\n");
	await exec("git", ["add", "-A"], dir);
	await exec("git", ["commit", "-q", "-m", "seed"], dir);
	await ensureParent(ledgerPath(dir, branch));
	await writeFile(ledgerPath(dir, branch), ledgerText.replace("{BRANCH}", branch));
	return { dir, branch, cleanup: () => rm(dir, { recursive: true }) };
}
