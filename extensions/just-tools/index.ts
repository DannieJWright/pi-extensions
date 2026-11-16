import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { argvFor, optionsName, schemaFor } from "./arguments.ts";
import { collectRecipes, mergeConfig, parseConfig, selectRecipes, toolName, type Config } from "./recipes.ts";

const JUSTFILE_NAMES = ["justfile", "Justfile", ".justfile", ".Justfile"];

function safeText(value: string): string {
	return stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

async function findJustfile(cwd: string): Promise<string | undefined> {
	for (const name of JUSTFILE_NAMES) {
		const path = join(cwd, name);
		try {
			if ((await stat(path)).isFile()) return path;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return undefined;
}

export default function justTools(pi: ExtensionAPI, settings: { outputDir?: string } = {}): void {
	pi.on("session_start", async (_event, ctx) => {
		const cwd = resolve(ctx.cwd);
		const warn = (message: string) => ctx.ui.notify(`just-tools: ${message}`, "warning");
		try {
			const justfile = await findJustfile(cwd);
			if (!justfile) return;
			const readConfig = async (path: string): Promise<Config> => {
				try {
					return parseConfig(await readFile(path, "utf8"), path);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
					throw error;
				}
			};
			const globalConfigPath = join(homedir(), ".pi", "just-tools.jsonc");
			const localConfigPath = join(cwd, ".pi", "just-tools.jsonc");
			const config = mergeConfig(await readConfig(globalConfigPath), await readConfig(localConfigPath));
			const metadata = await pi.exec("just", ["--justfile", justfile, "--json"], { cwd, maxBuffer: 8 * 1024 * 1024 });
			if (metadata.code !== 0 || metadata.killed || metadata.truncated) throw new Error(`just --json failed${metadata.truncated ? " (output exceeded limit)" : ""}: ${metadata.stderr || `exit ${metadata.code}`}`);
			const summary = await pi.exec("just", ["--justfile", justfile, "--summary"], { cwd, maxBuffer: 1024 * 1024 });
			if (summary.code !== 0 || summary.killed || summary.truncated) throw new Error(`just --summary failed${summary.truncated ? " (output exceeded limit)" : ""}: ${summary.stderr || `exit ${summary.code}`}`);
			const publicNames = new Set(summary.stdout.trim().split(/\s+/).filter(Boolean));
			const recipes = selectRecipes(collectRecipes(JSON.parse(metadata.stdout), publicNames), config);
			const existing = new Set(pi.getAllTools().map((tool) => tool.name));
			const names = new Map<string, string>();
			const definitions = recipes.map((recipe) => {
				const name = toolName(recipe.path);
				const previous = names.get(name);
				if (previous !== undefined) throw new Error(`Tool name conflict: ${name} (${previous}, ${recipe.path})`);
				if (existing.has(name)) throw new Error(`Tool name conflict: ${name} (${recipe.path}; already registered)`);
				names.set(name, recipe.path);
				return { recipe, name, parameters: schemaFor(recipe) };
			});
			for (const { recipe, name, parameters } of definitions) {
				const optionKey = optionsName(recipe);
				pi.registerTool({
					name,
					label: `just ${recipe.path}`,
					description: `Run just recipe ${recipe.path} in ${cwd}. ${recipe.doc ?? ""} Use ${optionKey}.grep for a focused stdout filter. ${optionKey}.tail defaults to 25 lines per stream; set it to 0 or a negative integer to return the start instead. Use ${optionKey}.show to show the current recipe instead of running it. Full unfiltered stdout and stderr are saved to a file whose path is returned. Runs outside the bash sandbox; parsing the justfile can evaluate expressions even when showing. Each displayed stream is limited to 24 KiB and 1,000 lines.`,
					parameters: parameters as unknown as TSchema,
					async execute(_id, args, signal) {
						try {
							if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Expected an argument object");
							const input = { ...args } as Record<string, unknown>;
							const options = Object.hasOwn(input, optionKey) ? input[optionKey] : {};
							delete input[optionKey];
							if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error(`${optionKey} must be an object`);
							const opts = options as Record<string, unknown>;
							for (const key of Object.keys(opts)) if (key !== "grep" && key !== "show" && key !== "tail") throw new Error(`Unknown ${optionKey} option ${key}`);
							if (opts.show !== undefined && typeof opts.show !== "boolean") throw new Error(`${optionKey}.show must be a boolean`);
							if (opts.grep !== undefined && typeof opts.grep !== "string") throw new Error(`${optionKey}.grep must be a string`);
							if (opts.tail !== undefined && !Number.isSafeInteger(opts.tail)) throw new Error(`${optionKey}.tail must be a safe integer`);
							const requestedTail = (opts.tail as number | undefined) ?? 25;
							const tail = requestedTail > 0 ? requestedTail : undefined;
							let pattern: RegExp | undefined;
							if (typeof opts.grep === "string") {
								if (opts.grep.length > 65536) throw new Error("grep regular expression exceeds 65536 characters");
								try { pattern = new RegExp(opts.grep); }
								catch (error) { throw new Error(`Invalid grep regular expression: ${error instanceof Error ? error.message : String(error)}`); }
							}
							const argv = argvFor(justfile, recipe, input, opts.show === true);
							if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled before execution." }], details: { cancelled: true }, isError: true };
							const { runJust } = await import("./runner.ts");
							const result = await runJust(argv, { cwd, signal, grep: pattern, tail, outputDir: settings.outputDir });
							const status = `Exit code: ${result.code}; cancelled: ${result.cancelled}; killed: ${result.killed}; truncated: ${result.truncated}.`;
							const noMatch = pattern && !result.matched && !result.filterIncomplete ? `[No matches${result.incomplete ? "; process output may be incomplete" : ""}.]` : "";
							const filterWarning = result.filterIncomplete ? "\n[Warning: grep filtering is incomplete; matching lines may be omitted (a line exceeded the limit, matching timed out, or capture was incomplete).]" : "";
							const logStatus = result.outputUnavailable ? "Output files are unavailable." : result.capturePaths ? `Log finalization failed. Recoverable captures: ${result.capturePaths.join(", ")}` : `${result.incomplete ? "Partial output" : "Full output"}: ${result.fullOutputPath} (${result.fullOutputLines === undefined ? "line count unavailable" : `${result.fullOutputLines} lines`})`;
							const truncationNotice = !result.truncated ? "" : result.outputUnavailable
								? "\n[Output truncated. The saved output files are unavailable.]"
								: result.capturePaths
									? "\n[Output truncated. Read the available captured output in the files listed below.]"
									: `\n[Output truncated. Read the ${result.incomplete ? "available captured" : "full unfiltered"} output in the log file below.]`;
							const logWarning = result.logError ? `\n[Warning: ${result.logError}]` : "";
							return {
								content: [{ type: "text", text: safeText(`${status}\nstdout:\n${result.stdout}${noMatch}${filterWarning}\nstderr:\n${result.stderr}${truncationNotice}\n${logStatus}${logWarning}`) }],
								details: { exitCode: result.code, cancelled: result.cancelled, killed: result.killed, truncated: result.truncated, fullOutputPath: result.capturePaths || result.outputUnavailable ? undefined : result.fullOutputPath, fullOutputLines: result.fullOutputLines, incomplete: result.incomplete, filterIncomplete: result.filterIncomplete, logError: result.logError, capturePaths: result.capturePaths, outputUnavailable: result.outputUnavailable },
								isError: result.code !== 0 || result.cancelled || result.killed || result.incomplete,
							};
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							const cancelled = !!signal?.aborted;
							return { content: [{ type: "text", text: safeText(`${cancelled ? "Cancelled" : "Could not run"} ${recipe.path}: ${message}`) }], details: { cancelled }, isError: true };
						}
					},
				});
			}
		} catch (error) {
			warn(error instanceof Error ? error.message : String(error));
		}
	});
}
