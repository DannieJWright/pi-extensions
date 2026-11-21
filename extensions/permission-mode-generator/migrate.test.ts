import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJsonc } from "../../lib/jsonc.ts";
import { buildSubagents } from "./merge.ts";
import { migrate, settingsEqual } from "./migrate.ts";

function fixture(t: test.TestContext) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "permission-migration-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const paths = { oldSrc: path.join(dir, "old.jsonc"), src: path.join(dir, "new.jsonc"), settings: path.join(dir, "settings.json") };
	fs.writeFileSync(paths.oldSrc, '{\n// retained\n"modes": {}\n} // end comment\n');
	return paths;
}

test("migration preserves comments, absent and empty agent overrides, and old source", (t) => {
	for (const subagents of [undefined, { defaultExtensions: [], value: null }, { agentOverrides: {} }, { agentOverrides: { worker: { tools: ["read"] } }, disabled: false }]) {
		const paths = fixture(t);
		if (subagents !== undefined) fs.writeFileSync(paths.settings, JSON.stringify({ subagents }));
		migrate(paths);
		const text = fs.readFileSync(paths.src, "utf8");
		assert.match(text, /\/\/ retained/);
		assert.match(text, /\/\/ end comment/);
		const source = parseJsonc(text, paths.src) as Record<string, unknown>;
		if (subagents === undefined) assert.equal(Object.hasOwn(source, "subagents"), false);
		else assert.equal(settingsEqual(buildSubagents(source.subagents as Record<string, unknown>), subagents), true);
		assert.equal(fs.readFileSync(paths.oldSrc, "utf8"), '{\n// retained\n"modes": {}\n} // end comment\n');
		assert.throws(() => migrate(paths), /already exists/);
	}
});

test("migration refuses values that merging or file resolution would change", (t) => {
	for (const subagents of [
		{ agentOverrides: { worker: { value: null } } },
		{ agentOverrides: { worker: { "tools+": ["read"] } } },
		{ agentOverrides: { worker: { prompt: { $file: "missing" } } } },
		{ agentOverrides: null },
	]) {
		const paths = fixture(t);
		fs.writeFileSync(paths.settings, JSON.stringify({ subagents }));
		assert.throws(() => migrate(paths), /migrate manually/);
		assert.equal(fs.existsSync(paths.src), false);
	}
	const paths = fixture(t);
	fs.writeFileSync(paths.oldSrc, JSON.stringify({ output: { literal: { $file: "never-read" } } }));
	assert.throws(() => migrate(paths), /legacy \$file-shaped literal.*migrate manually/);
	assert.equal(fs.existsSync(paths.src), false);
});

test("settings comparisons ignore key order except colliding model scope names", () => {
	assert.equal(settingsEqual({ agentOverrides: {}, x: 1 }, { x: 1, agentOverrides: {} }), true);
	assert.equal(settingsEqual({ modelScope: { agents: { worker: [1], " worker ": [2] } } }, { modelScope: { agents: { " worker ": [2], worker: [1] } } }), false);
	assert.equal(settingsEqual({ modelScope: { agents: { worker: [1], scout: [2] } } }, { modelScope: { agents: { scout: [2], worker: [1] } } }), true);
});

test("competing migrations publish one complete source and never overwrite", async (t) => {
	const paths = fixture(t);
	const { spawn } = await import("node:child_process");
	const module = new URL("./migrate.ts", import.meta.url).href;
	const program = `import {migrate} from ${JSON.stringify(module)}; try {migrate(JSON.parse(process.argv[1]));} catch(e) {console.error(e.message); process.exitCode=1;}`;
	const start = () => new Promise<number | null>((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", program, JSON.stringify(paths)], { stdio: "ignore" });
		child.on("error", reject); child.on("exit", resolve);
	});
	const results = await Promise.all([start(), start()]);
	assert.deepEqual(results.sort(), [0, 1]);
	const source = parseJsonc(fs.readFileSync(paths.src, "utf8"), paths.src) as Record<string, unknown>;
	assert.equal(Object.hasOwn(source, "permissionModes"), true);
	assert.deepEqual(fs.readdirSync(path.dirname(paths.src)).sort(), ["new.jsonc", "old.jsonc"]);
});

test("publication failure removes temporary source and leaves other files alone", (t) => {
	const paths = fixture(t);
	fs.writeFileSync(paths.settings, JSON.stringify({ subagents: { agentOverrides: {} }, unrelated: true }));
	const before = fs.readFileSync(paths.settings, "utf8");
	const link = fs.linkSync;
	fs.linkSync = (() => { throw new Error("injected publication failure"); }) as typeof fs.linkSync;
	try { assert.throws(() => migrate(paths), /injected publication failure/); }
	finally { fs.linkSync = link; }
	assert.equal(fs.readFileSync(paths.settings, "utf8"), before);
	assert.deepEqual(fs.readdirSync(path.dirname(paths.src)).sort(), ["old.jsonc", "settings.json"]);
});
