// Test harness for the feature-ledger extension. It provides a fake ExtensionAPI
// and a fake ExtensionContext so a test can call a tool's execute without a Pi
// session, and a temporary git repository with a ledger. Test-only: the extension
// code must not import this file at runtime. Depends on Node built-ins and, for invoke,
// validateToolArguments from @earendil-works/pi-ai (a devDependency).

import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { ensureParent, resolveLedgerPath } from "./ledger.ts";

const run = promisify(execFile);

// The same shape the extension uses, defined here rather than imported from the Pi package.
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
	prepareArguments?: (args: unknown) => unknown;
	execute: (toolCallId: string | null, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: FakeContext) => Promise<ToolResult>;
};

// Runs a tool the way Pi does: prepareArguments (when present), then validateToolArguments
// (coercion on, Pi's exact error text), then execute with the validated arguments. A
// validation failure rejects with Pi's Error unchanged and execute is never called.
export async function invoke(tool: ToolDefinition, params: Record<string, unknown>, ctx: FakeContext): Promise<ToolResult> {
	const prepared = tool.prepareArguments ? tool.prepareArguments(params) : params;
	const validated = validateToolArguments(tool as any, { type: "toolCall", id: "test", name: tool.name, arguments: prepared as Record<string, any> } as any) as Record<string, unknown>;
	return tool.execute(null, validated, null, null, ctx);
}

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
		// Git stops before checking the ceiling itself, even if TMPDIR is a user repo.
		const ceiling = await realpath(tmpdir());
		const fixtureCwd = await realpath(cwd);
		const inside = relative(ceiling, fixtureCwd);
		if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
			throw new Error("fixture subprocess cwd must be inside the temporary directory");
		}
		// Git's ceiling list has no escaping for the platform path-list delimiter.
		if (ceiling.includes(delimiter)) throw new Error("temporary directory cannot be represented as a Git discovery ceiling");
		// Git and validation-script subprocesses must not inherit repository, configuration,
		// hook, or identity overrides from the user's environment.
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && key !== "EMAIL"));
		Object.assign(env, {
			HOME: fixtureCwd,
			XDG_CONFIG_HOME: join(fixtureCwd, ".fixture-xdg-config"),
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_ATTR_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
			GIT_CEILING_DIRECTORIES: ceiling,
		});
		const { stdout, stderr } = await run(command, args, { cwd: fixtureCwd, env });
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? (error instanceof Error ? error.message : "") };
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

// A temporary git repository with a ledger at the resolved default path, mirroring the
// project layout (plan/ is gitignored). branch is the real branch name, read from the
// symbolic ref before the first commit, so a test can still assert on it. path is the
// default target resolveLedgerPath gives for this directory.
export async function setupRepo(ledgerText: string): Promise<{ dir: string; branch: string; path: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "feature-ledger-"));
	await exec("git", ["-c", "init.defaultBranch=feature-x", "init", "-q"], dir);
	await exec("git", ["config", "user.email", "ledger-test@example.com"], dir);
	await exec("git", ["config", "user.name", "Ledger Test"], dir);
	await writeFile(join(dir, ".gitignore"), "plan/\n");
	const branch = (await exec("git", ["symbolic-ref", "--short", "HEAD"], dir)).stdout.trim();
	await writeFile(join(dir, "README.md"), "seed\n");
	await exec("git", ["add", "-A"], dir);
	await exec("git", ["commit", "-q", "-m", "seed"], dir);
	const path = resolveLedgerPath(dir, { default: "plan/ledger.yaml" });
	await ensureParent(path);
	await writeFile(path, ledgerText.replace("{BRANCH}", branch));
	return { dir, branch, path, cleanup: () => rm(dir, { recursive: true }) };
}
