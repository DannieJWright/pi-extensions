import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseJsonc } from "../../lib/jsonc.ts";

export type TrustedCommand = { command: string; argv: string[]; shell: boolean };

// Parse quotes even for allowlisted shell commands, so malformed input never runs.
export function parseCommand(command: string): TrustedCommand {
	if (!command.trim() || /[\0\r\n]/.test(command)) throw new Error("malformed command");
	const argv: string[] = [];
	let word = "", started = false, quote = "", escaped = false, shell = false;
	for (const ch of command) {
		if (escaped) { word += ch; started = true; escaped = false; continue; }
		if (ch === "\\" && quote !== "'") { escaped = true; started = true; continue; }
		if (quote) {
			if (ch === quote) { quote = ""; continue; }
			if (quote === '"' && /[$`]/.test(ch)) shell = true;
			word += ch; started = true; continue;
		}
		if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
		if (/\s/.test(ch)) { if (started) { argv.push(word); word = ""; started = false; } continue; }
		if (/[;&|<>$`()*?\[\]{}~#]/.test(ch)) shell = true;
		word += ch; started = true;
	}
	if (quote || escaped) throw new Error("malformed command: unclosed quote or escape");
	if (started) argv.push(word);
	if (!argv.length || !argv[0]) throw new Error("malformed command: missing executable");
	return { command, argv, shell };
}

function matches(pattern: string, value: string): boolean {
	const regex = pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
	return new RegExp(`^${regex}$`, "s").test(value);
}

export function trustCommand(command: string, allowedCommands: string[]): TrustedCommand {
	const parsed = parseCommand(command);
	if ((!parsed.shell && parsed.argv[0] === "just") || allowedCommands.some(pattern => matches(pattern, command))) return parsed;
	throw new Error(`Untrusted command: ${command}\nAdd to ~/.pi/agent/ui-capture.jsonc allowedCommands: ${JSON.stringify(command)}`);
}

export async function readAllowedCommands(path = join(homedir(), ".pi", "agent", "ui-capture.jsonc")): Promise<string[]> {
	let text: string;
	try { text = await readFile(path, "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	const config = parseJsonc(text, path);
	if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${path}: expected an object`);
	const allowed = (config as Record<string, unknown>).allowedCommands;
	if (allowed === undefined) return [];
	if (!Array.isArray(allowed) || !allowed.every(value => typeof value === "string")) throw new Error(`${path}: allowedCommands must be an array of strings`);
	return allowed;
}
