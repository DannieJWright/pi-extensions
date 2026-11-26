// Thin adapter: wires rules.ts into Pi. It loads the pi-permission-modes modules lazily from the root named by
// PI_CWD_GUARD_PERMISSION_MODES_ROOT, else from the default install under Pi's agent directory, and hands them to rules.ts. Detection, judgment, composition and all
// prompt-section and reason text stay in rules.ts. When the package cannot be loaded the extension logs once,
// passes every command through and skips the prompt section.

import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	PROMPT_SECTION,
	boundaryBlock,
	boundaryFindings,
	promptSectionText,
	resolveMode,
	type BoundaryBlock,
	type ModeConfig,
	type PackageFunctions,
} from "./rules.ts";

export const PERMISSION_MODES_ROOT_ENV = "PI_CWD_GUARD_PERMISSION_MODES_ROOT";

/** What the adapter needs from the package: the rules.ts functions plus the config loader. */
export interface PackageRuntime {
	functions: PackageFunctions;
	loadModeConfig(cwd: string, agentDir: string): ModeConfig;
}

/** Everything the handlers touch outside this module, injectable so tests never read an installed package. */
export interface CwdGuardDeps {
	/** Resolves undefined when the package is unavailable; the loader logs that once. */
	loadRuntime(): Promise<PackageRuntime | undefined>;
	agentDir(): Promise<string> | string;
	env(): Record<string, string | undefined>;
	warn(message: string): void;
}

interface ToolCallEventLike {
	toolName: string;
	input: { command?: unknown };
}

interface SectionsEventLike {
	systemPromptOptions: { sections?: Record<string, string> };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The tool_call gate for bash. Any failure passes the command through with one warning line. */
export function makeToolCallHandler(deps: CwdGuardDeps) {
	return async (event: ToolCallEventLike, ctx: { cwd: string }): Promise<BoundaryBlock | undefined> => {
		if (event.toolName !== "bash") return undefined;
		try {
			const runtime = await deps.loadRuntime();
			if (!runtime) return undefined;
			const config = runtime.loadModeConfig(ctx.cwd, await deps.agentDir());
			const mode = resolveMode(deps.env(), config);
			if (!mode) return undefined;
			const command = typeof event.input.command === "string" ? event.input.command : "";
			return boundaryBlock(await boundaryFindings(command, ctx.cwd, mode, runtime.functions), ctx.cwd);
		} catch (error) {
			deps.warn(`cwd-guard: passing the command through, the boundary check failed: ${describe(error)}`);
			return undefined;
		}
	};
}

/** The before_agent_start section. Skipped when the package is unavailable. */
export function makeBeforeAgentStartHandler(deps: CwdGuardDeps) {
	return async (event: SectionsEventLike, ctx: { cwd: string }): Promise<void> => {
		try {
			if (!(await deps.loadRuntime())) return;
			const sections = (event.systemPromptOptions.sections ??= {});
			sections[PROMPT_SECTION] = promptSectionText(ctx.cwd);
		} catch (error) {
			deps.warn(`cwd-guard: skipping the prompt section: ${describe(error)}`);
		}
	};
}

/** The package root under Pi's agent directory where pi-permission-modes is installed. */
export function defaultPackageRoot(agentDir: string): string {
	return path.join(agentDir, "npm", "node_modules", "pi-permission-modes");
}

const importFromUrl = (fileUrl: string): Promise<unknown> => import(fileUrl);

/** Loads the package modules once. The root is PI_CWD_GUARD_PERMISSION_MODES_ROOT when set and non-empty, else
 * defaultPackageRoot(await agentDir()). Warns once, naming the source and root, only when nothing loads. */
export function makeRuntimeLoader(
	env: () => Record<string, string | undefined>,
	agentDir: CwdGuardDeps["agentDir"],
	warn: (message: string) => void,
	importer: (fileUrl: string) => Promise<unknown> = importFromUrl,
): () => Promise<PackageRuntime | undefined> {
	let loading: Promise<PackageRuntime | undefined> | undefined;
	return () => {
		loading ??= (async () => {
			const explicit = env()[PERMISSION_MODES_ROOT_ENV];
			const source = explicit ? `explicit ${PERMISSION_MODES_ROOT_ENV}` : "derived default";
			let root = explicit || "(unresolved)";
			try {
				if (!explicit) root = defaultPackageRoot(await agentDir());
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const load = (file: string) => importer(pathToFileURL(path.join(root, "src", file)).href) as Promise<any>;
				const [parse, config, heuristics, paths, resolve] = await Promise.all([
					load("bash-parse.ts"),
					load("config-load.ts"),
					load("heuristics.ts"),
					load("paths.ts"),
					load("resolve.ts"),
				]);
				return {
					loadModeConfig: config.loadModeConfig,
					functions: {
						getTreeSitterParser: parse.getTreeSitterParser,
						expandShellCommands: parse.expandShellCommands,
						unwrapCommand: parse.unwrapCommand,
						normalizeBashToken: heuristics.normalizeBashToken,
						tokenTarget: heuristics.tokenTarget,
						isOutside: paths.isOutside,
						sandboxAllowedRoots: paths.sandboxAllowedRoots,
						insideRoots: paths.insideRoots,
						resolveSurfaceDetailed: resolve.resolveSurfaceDetailed,
						mostRestrictive: resolve.mostRestrictive,
					},
				};
			} catch (error) {
				warn(`cwd-guard: cannot load pi-permission-modes from ${source} ${root}; the guard is off: ${describe(error)}`);
				return undefined;
			}
		})();
		return loading;
	};
}

export default function cwdGuard(pi: ExtensionAPI): void {
	const env = () => process.env;
	const warn = (message: string) => console.warn(message);
	// Imported lazily: the pi package resolves only inside Pi.
	const agentDir = async () => (await import("@earendil-works/pi-coding-agent")).getAgentDir();
	const deps: CwdGuardDeps = {
		loadRuntime: makeRuntimeLoader(env, agentDir, warn),
		agentDir,
		env,
		warn,
	};
	pi.on("before_agent_start", makeBeforeAgentStartHandler(deps));
	pi.on("tool_call", makeToolCallHandler(deps));
}
