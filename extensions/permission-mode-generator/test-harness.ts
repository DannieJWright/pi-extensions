// Test support shared by the permission-mode-generator test modules. Test-only: the extension code must not import
// this file at runtime. Node built-ins plus the resolver itself, so path rules are stated once instead of restated.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { referencePath, resolveFiles } from "./generate.ts";

// The repository owns the committed fixture agent files, so it is one of the allowed read roots. path.resolve drops the trailing separator a URL leaves behind.
export const repositoryRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

/** Run fn with process.env set to overrides (undefined removes a variable), then restore the previous values. Used only by the opt-in runtime probes, which need environment roots; prompt assembly takes an explicit home root instead. */
export async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
	const names = Object.keys(overrides);
	const saved = new Map(names.map((name) => [name, process.env[name]]));
	try {
		for (const name of names) {
			const value = overrides[name];
			if (value === undefined) delete process.env[name]; else process.env[name] = value;
		}
		return await fn();
	} finally {
		for (const name of names) {
			const value = saved.get(name);
			if (value === undefined) delete process.env[name]; else process.env[name] = value;
		}
	}
}

/** Declare a stand-in home root under dir seeded with fixture content, so a prompt-assembly group never reads the real user home. */
export function standInHomeRoot(dir: string, contents: Record<string, string> = {}): string {
	const root = path.join(dir, "home-root");
	fs.mkdirSync(root, { recursive: true });
	for (const [relative, text] of Object.entries(contents)) {
		const target = path.join(root, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, text);
	}
	return root;
}

/** A resolved reference is in scope when it lies inside the repository or the declared stand-in root. */
export function isInScope(resolved: string, roots: string[]): boolean {
	return roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

/** Each prompt-form reference with its key path, mirroring the shapes the resolver accepts so a failure can name both. Non-path entries are skipped: validating them is the resolver's job. */
function referencesIn(value: unknown, keyPath = ""): Array<{ keyPath: string; raw: string }> {
	if (Array.isArray(value)) return value.flatMap((item, index) => referencesIn(item, `${keyPath}[${index}]`));
	if (!value || typeof value !== "object") return [];
	const found: Array<{ keyPath: string; raw: string }> = [];
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		const here = keyPath ? `${keyPath}.${key}` : key;
		if (typeof child === "string" && (key === "$file" || key === "path")) found.push({ keyPath: here, raw: child });
		else if (key === "files" && Array.isArray(child)) child.forEach((entry, index) => { if (typeof entry === "string") found.push({ keyPath: `${here}[${index}]`, raw: entry }); else found.push(...referencesIn(entry, `${here}[${index}]`)); });
		else found.push(...referencesIn(child, here));
	}
	return found;
}

/** Fail naming the key path and the reference as authored when it resolves outside the repository or the declared stand-in root. */
export function checkReadScope(value: unknown, sourceFile: string, keyPath: string, homeRoot: string): void {
	for (const ref of referencesIn(value, keyPath)) {
		const resolved = referencePath(ref.raw, sourceFile, homeRoot);
		assert.ok(isInScope(resolved, [repositoryRoot, homeRoot]), `${ref.keyPath}: reference ${JSON.stringify(ref.raw)} resolves outside the repository or the declared stand-in root (${resolved})`);
	}
}

/** Resolve through the resolver after every recorded reference has been checked against the read scope. */
export function resolveWithinScope(value: unknown, sourceFile: string, keyPath: string, homeRoot: string): unknown {
	checkReadScope(value, sourceFile, keyPath, homeRoot);
	return resolveFiles(value, sourceFile, keyPath, homeRoot);
}
