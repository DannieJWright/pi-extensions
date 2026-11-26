// Detection, judgment and composition for the cwd guard. The package functions arrive as injected arguments
// (`PackageFunctions`); this module imports no package path, so unit tests never touch an installed package.
// Ported from the cwd-guard POC; resolveMode is new code.

import path from "node:path";

/** Minimal structural types for what this module reads from pi-permission-modes. Declared locally so no
 * package path is imported. */
export type Action = "allow" | "ask" | "deny";

/** A pattern table such as `permission.path`: opaque here, passed to `resolveSurfaceDetailed`. */
export type PermissionSurface = unknown;

export interface PermissionSet {
	path?: PermissionSurface;
	external_directory?: PermissionSurface;
}

export interface ModeDef {
	sandbox: unknown;
	permission: PermissionSet;
	/** Project tighten-only overlay, folded with the base policy. */
	projectOverlay?: PermissionSet;
}

/** The mode config as far as mode lookup needs it. */
export interface ModeConfig {
	modes: Record<string, ModeDef>;
	defaultMode: string;
}

/** One parsed command: head name, arguments and whether it came from a nested script. */
export interface BashCommand {
	name: string;
	args: string[];
	isNested: boolean;
}

/** A tree-sitter parser as far as this module uses it. */
export interface BashParser {
	parse(script: string): BashCommand[];
}

/** The package functions this module needs, injected by the caller. */
export interface PackageFunctions {
	/** `getTreeSitterParser`: resolves undefined when tree-sitter cannot load. */
	getTreeSitterParser(): Promise<BashParser | undefined> | BashParser | undefined;
	expandShellCommands(parse: (script: string) => unknown, tree: unknown): BashCommand[];
	unwrapCommand(command: BashCommand): BashCommand;
	normalizeBashToken(token: string): string;
	tokenTarget(token: string, root: string, bare: boolean): string | undefined;
	isOutside(root: string, target: string, alsoInside: readonly string[]): boolean;
	sandboxAllowedRoots(root: string, sandbox: unknown): string[];
	insideRoots(root: string, sandbox: unknown): string[];
	resolveSurfaceDetailed(surface: PermissionSurface, target: string): { action?: Action } | undefined;
	mostRestrictive(...actions: (Action | undefined)[]): Action | undefined;
}

/** Command heads that move the shell's working directory, matched on the basename. */
const DIRECTORY_COMMANDS = new Set(["cd", "chdir", "pushd", "popd"]);

/** Stack-reference arguments of cd/pushd/popd: `-`, `+N`, `-N`. Flags such as -L, -P and -n do not match. */
const STACK_REFERENCE = /^[-+]\d*$/;

/** Prompt section key. permission-modes uses permission_mode / permission_mode_docs / permission_mode_steering,
 * so this must not collide with them. */
export const PROMPT_SECTION = "cwd_boundary";

/** What one directory command names. Only a denied crossing changes anything at runtime. */
export interface BoundaryFinding {
	/** Command head after unwrapping wrappers, as a basename (`cd`, `chdir`, `pushd`, `popd`). */
	name: string;
	/** The argument judged, as written. Empty when there was none to judge. */
	argument: string;
	/** The argument is a stack reference (`-`, `+N`, `-N`): the shell's own directory stack, which this
	 * extension cannot know. Never guessed. */
	stackTarget?: boolean;
	/** Absolute path the argument names, when it names one worth judging. */
	target?: string;
	/** Whether that target crosses the boundary as permission-modes defines it. */
	crossing?: boolean;
	/** Boundary decision for a crossing target. Non-crossings are not decided. */
	action?: Action;
}

/** What the tool_call handler returns for a refused directory change. */
export interface BoundaryBlock {
	block: true;
	reason: string;
}

/** Fixed one-line reason: names the boundary and the alternative. */
export function boundaryReason(root: string, target: string): string {
	return `outside the session working directory ${root}; run this with an absolute path inside it (${target} is outside). A cd affects only this command.`;
}

/** The gate's decision over one bash call's findings: only a denied crossing blocks; ask and allow return
 * nothing, so the normal flow continues, including the package's own prompt path. */
export function boundaryBlock(findings: readonly BoundaryFinding[], root: string): BoundaryBlock | undefined {
	for (const finding of findings) {
		if (finding.action === "deny" && finding.target) return { block: true, reason: boundaryReason(root, finding.target) };
	}
	return undefined;
}

/** Boundary decision for one target, composed from exported package pieces only: the surfaces of the base
 * policy and of the project overlay are resolved separately and folded with `mostRestrictive`. Pattern
 * matching stays in the package. */
export function boundaryAction(mode: ModeDef, target: string, pkg: PackageFunctions): Action | undefined {
	const sources = mode.projectOverlay ? [mode.permission, mode.projectOverlay] : [mode.permission];
	const layers = sources.flatMap((perm) => [pkg.resolveSurfaceDetailed(perm.path, target), pkg.resolveSurfaceDetailed(perm.external_directory, target)]);
	return pkg.mostRestrictive(...layers.map((layer) => layer?.action));
}

/** The also-inside set passed to `isOutside`: the mode's raw sandbox bounds plus its inside roots. */
export function insideSet(root: string, mode: ModeDef, pkg: PackageFunctions): string[] {
	return [...pkg.sandboxAllowedRoots(root, mode.sandbox), ...pkg.insideRoots(root, mode.sandbox)];
}

/** Live mode lookup. The env name written by permission-modes wins; when it is unset or names no loaded
 * mode (the headless fallback never writes it), `config.defaultMode` applies. Returns nothing when neither
 * names a mode. */
export function resolveMode(env: Record<string, string | undefined>, config: ModeConfig): ModeDef | undefined {
	const name = env.PI_PERMISSION_MODE;
	if (name && Object.hasOwn(config.modes, name)) return config.modes[name];
	return Object.hasOwn(config.modes, config.defaultMode) ? config.modes[config.defaultMode] : undefined;
}

/** A heredoc operator outside quotes: `<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`. `<<<` is a here-string. */
const HEREDOC = /^<<(-?)[ \t]*(['"]?)([A-Za-z0-9_.-]+)\2/;

/** A segment whose first word is a redirection (`>f`, `2>&1`, `<<EOF`) carries no command head to judge. */
const REDIRECTION_START = /^\d*[<>]/;

/** Documented fallback when tree-sitter cannot load: split on `;`, `&`, `|` and newlines outside quotes,
 * then take each segment's head, skipping assignment prefixes before it. This is not the package's own
 * no-parser path, which splits on `[;|&()]+` and strips quotes from heads; this split tracks quote spans
 * and keeps the quotes in the words. Heredoc bodies are skipped, and so are segments that begin with a
 * redirection, so text bash never executes is not judged as a command. */
export function commandsWithoutParser(command: string): BashCommand[] {
	const segments: string[] = [];
	const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
	let current = "";
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "'" || ch === '"') {
			const end = command.indexOf(ch, i + 1);
			const stop = end === -1 ? command.length : end;
			current += command.slice(i, stop + 1);
			i = stop;
			continue;
		}
		if (ch === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
			const heredoc = HEREDOC.exec(command.slice(i));
			if (heredoc) {
				heredocs.push({ delimiter: heredoc[3], stripTabs: heredoc[1] === "-" });
				current += heredoc[0];
				i += heredoc[0].length - 1;
				continue;
			}
		}
		if (ch === "\n" && heredocs.length) {
			segments.push(current);
			current = "";
			// Each pending body runs up to the line that equals its delimiter; none of it is a command.
			let at = i + 1;
			for (const doc of heredocs) {
				while (at < command.length) {
					const newline = command.indexOf("\n", at);
					const end = newline === -1 ? command.length : newline;
					const line = command.slice(at, end);
					at = end + 1;
					if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
				}
			}
			heredocs.length = 0;
			i = at - 1;
			continue;
		}
		if (ch === ";" || ch === "&" || ch === "|" || ch === "\n") {
			segments.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	segments.push(current);
	const out: BashCommand[] = [];
	for (const segment of segments) {
		const words = segment.split(/\s+/).filter(Boolean);
		if (!words.length || REDIRECTION_START.test(words[0])) continue;
		const headAt = words.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
		if (headAt < 0) continue;
		out.push({ name: words[headAt], args: words.slice(headAt + 1), isNested: false });
	}
	return out;
}

/** The directory commands among already-parsed commands. Reports what was seen; it decides nothing beyond the boundary layer. */
export function judgeCommands(parsed: readonly BashCommand[], root: string, mode: ModeDef, pkg: PackageFunctions): BoundaryFinding[] {
	const inside = insideSet(root, mode, pkg);
	const findings: BoundaryFinding[] = [];
	for (const raw of parsed) {
		const c = pkg.unwrapCommand(raw); // wrappers such as `env`, `timeout`, `xargs` come off first
		const name = path.basename(c.name);
		if (!DIRECTORY_COMMANDS.has(name)) continue;
		const finding: BoundaryFinding = { name, argument: "" };
		for (const arg of c.args) {
			const tok = pkg.normalizeBashToken(arg);
			if (!tok) continue;
			if (STACK_REFERENCE.test(tok)) {
				finding.stackTarget = true; // the shell's stack: reported, never guessed
				break;
			}
			if (tok.startsWith("-")) continue; // flags such as -L, -P and -n
			if (name !== "popd") finding.argument = tok; // popd names only the shell's own stack, never a path
			break;
		}
		// tokenTarget with bare=false judges only a path-shaped argument: `cd build` is not read as a crossing.
		// Variables other than $HOME cannot be resolved here, so they are left as written.
		const target = finding.argument ? pkg.tokenTarget(finding.argument, root, false) : undefined;
		if (!target) {
			findings.push(finding);
			continue;
		}
		finding.target = target;
		finding.crossing = pkg.isOutside(root, target, inside);
		if (finding.crossing) finding.action = boundaryAction(mode, target, pkg);
		findings.push(finding);
	}
	return findings;
}

/** The tree-sitter parser when it can load, otherwise the documented fallback split. */
export async function parseCommands(command: string, pkg: PackageFunctions): Promise<BashCommand[]> {
	const parser = await pkg.getTreeSitterParser();
	if (!parser) return commandsWithoutParser(command);
	// `unwrapCommand` does not descend into `sh -c`, so inner scripts are expanded here.
	return pkg.expandShellCommands((script) => parser.parse(script), parser.parse(command));
}

/** One bash call through whichever parser is available. */
export async function boundaryFindings(command: string, root: string, mode: ModeDef, pkg: PackageFunctions): Promise<BoundaryFinding[]> {
	return judgeCommands(await parseCommands(command, pkg), root, mode, pkg);
}

/** The boundary statement. The text depends on nothing but the root, so it stays stable for the whole
 * session. Statements 1-3 are the POC text; statement 4 is original wording written for this extension. */
export function promptSectionText(root: string): string {
	return [
		"The session working directory is " + root + ". When the session started in .worktrees/<branch>, that worktree is the session working directory.",
		"Shell cwd never persists between calls: a cd applies to that one command.",
		"Relative paths resolve from the session working directory. Use absolute paths inside it.",
		"This guard refuses an explicit directory change out of the session working directory when the permission policy denies it. Any other command that reaches outside follows the normal permission flow, which may ask first.",
	].join("\n");
}
