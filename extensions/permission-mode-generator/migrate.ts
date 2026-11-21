// Migrate the old source without changing any generated output or baseline.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseJsonc, stripJsonc } from "../../lib/jsonc.ts";
import { assertRoundtripValues, parseRoundtripJson } from "./json-roundtrip.ts";
import { buildSubagents, type JsonObject } from "./merge.ts";

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Equality for settings: object order is immaterial except for trimmed model-scope names. */
export function settingsEqual(a: unknown, b: unknown, keyPath = "subagents"): boolean {
	if (Array.isArray(a) || Array.isArray(b)) {
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
			a.every((value, i) => settingsEqual(value, b[i], `${keyPath}[${i}]`));
	}
	if (isObject(a) && isObject(b)) {
		const keys = Object.keys(a);
		if (keys.length !== Object.keys(b).length || keys.some((key) => !Object.hasOwn(b, key))) return false;
		if (keyPath === "subagents.modelScope.agents") {
			const last = (value: JsonObject): string[] => {
				const result = new Map<string, string>();
				for (const key of Object.keys(value)) result.set(key.trim(), key);
				return [...result.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([name, key]) => `${name}\0${key}`);
			};
			if (JSON.stringify(last(a)) !== JSON.stringify(last(b))) return false;
		}
		return keys.every((key) => settingsEqual(a[key], b[key], `${keyPath}.${key}`));
	}
	return Object.is(a, b);
}

function findFileLiteral(value: unknown, keyPath: string): string | undefined {
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const found = findFileLiteral(value[i], `${keyPath}[${i}]`);
			if (found) return found;
		}
	} else if (isObject(value)) {
		if (Object.keys(value).length === 1 && Object.hasOwn(value, "$file")) return keyPath;
		for (const [key, child] of Object.entries(value)) {
			const found = findFileLiteral(child, `${keyPath}.${key}`);
			if (found) return found;
		}
	}
	return undefined;
}

export interface MigrationPaths {
	oldSrc: string;
	src: string;
	settings: string;
}

/** Publishes a complete file exclusively; a competing migration cannot replace it. */
export function migrate(paths: MigrationPaths): void {
	if (fs.existsSync(paths.src)) throw new Error(`${paths.src} already exists; refusing to overwrite it`);
	const oldText = fs.readFileSync(paths.oldSrc, "utf8");
	const old = parseJsonc(oldText, paths.oldSrc);
	parseRoundtripJson(stripJsonc(oldText), paths.oldSrc, "stripped JSONC");
	if (!isObject(old)) throw new Error(`${paths.oldSrc}: top level must be an object`);
	const literal = findFileLiteral(old, "permissionModes");
	if (literal) throw new Error(`${literal}: legacy $file-shaped literal would change meaning; migrate manually (see MIGRATION.md)`);

	let subagents: JsonObject | undefined;
	let settings: unknown;
	try {
		settings = parseRoundtripJson(fs.readFileSync(paths.settings, "utf8"), paths.settings);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (settings !== undefined && !isObject(settings)) throw new Error(`${paths.settings}: top level must be an object; migrate manually (see MIGRATION.md)`);
	if (isObject(settings) && Object.hasOwn(settings, "subagents")) {
		if (!isObject(settings.subagents)) throw new Error("settings.subagents is not an object; migrate manually (see MIGRATION.md)");
		const { agentOverrides, ...rest } = settings.subagents;
		subagents = { settings: rest };
		if (Object.hasOwn(settings.subagents, "agentOverrides")) subagents.agents = agentOverrides;
		const importedLiteral = findFileLiteral(subagents, "subagents");
		if (importedLiteral) throw new Error(`${importedLiteral}: $file-shaped literal would change meaning; migrate manually (see MIGRATION.md)`);
		try {
			if (!settingsEqual(buildSubagents(subagents), settings.subagents)) throw new Error("merge changes a value");
		} catch (error) {
			throw new Error(`settings.subagents cannot be represented safely (${error instanceof Error ? error.message : String(error)}); migrate manually (see MIGRATION.md)`);
		}
	}
	assertRoundtripValues(subagents, "subagents");
	const text = `{\n  "permissionModes": ${oldText.trim()}\n${subagents ? `,\n  "subagents": ${JSON.stringify(subagents, null, 2)}\n` : ""}}\n`;
	fs.mkdirSync(path.dirname(paths.src), { recursive: true });
	const temp = path.join(path.dirname(paths.src), `.${path.basename(paths.src)}.${randomUUID()}.tmp`);
	try {
		fs.writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
		fs.linkSync(temp, paths.src);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${paths.src} already exists; refusing to overwrite it`);
		throw error;
	} finally {
		try { fs.unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
}
