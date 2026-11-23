import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { stripJsonc } from "../../lib/jsonc.ts";
import { referencePath, run } from "./generate.ts";
import { resolveWithinScope, standInHomeRoot, withEnv } from "./test-harness.ts";
import { buildConfig, buildSubagents, type JsonObject } from "./merge.ts";

function temporaryDirectory(t: test.TestContext): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "permission-generator-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("$file resolves relative to the source before merging in both sections", (t) => {
	const dir = temporaryDirectory(t);
	// Each prompt-assembly group declares its own stand-in home root under its temporary directory and authors fixture content there, so results never depend on the contents of the real user home.
	const home = standInHomeRoot(dir, { "prompts/base.md": "base prompt\n", "prompts/override.md": "override prompt\n" });
	const sourceFile = path.join(home, "source.jsonc");
	const source = {
		permissionModes: {
			fragments: { base: { systemPrompt: { $file: "prompts/base.md" } } },
			modes: {
				inherited: { extends: ["base"] },
				overridden: { extends: ["base"], systemPrompt: { $file: "prompts/override.md" } },
				deleted: { extends: ["base"], systemPrompt: null },
			},
		},
		subagents: {
			fragments: { base: { systemPrompt: { $file: "prompts/base.md" } } },
			agents: {
				inherited: { extends: ["base"] },
				overridden: { extends: ["base"], systemPrompt: { $file: "prompts/override.md" } },
				deleted: { extends: ["base"], systemPrompt: null },
			},
		},
	};
	const resolved = resolveWithinScope(source, sourceFile, "", home) as typeof source;
	const expected = {
		inherited: { systemPrompt: "base prompt\n" },
		overridden: { systemPrompt: "override prompt\n" },
		deleted: {},
	};
	assert.deepEqual(buildConfig(resolved.permissionModes).modes, expected);
	assert.deepEqual(buildSubagents(resolved.subagents).agentOverrides, expected);
	assert.deepEqual(resolveWithinScope({ list: [{ $file: "prompts/base.md" }] }, sourceFile, "", home),
		{ list: ["base prompt\n"] });
	assert.deepEqual(source.permissionModes.fragments.base.systemPrompt, { $file: "prompts/base.md" });
});

test("missing $file reports its section and key path", (t) => {
	const home = standInHomeRoot(temporaryDirectory(t));
	for (const section of ["permissionModes", "subagents"]) {
		assert.throws(() => resolveWithinScope({ [section]: { items: [{ prompt: { $file: "missing.md" } }] } }, path.join(home, "src.jsonc"), "", home),
			new RegExp(`${section}\\.items\\[0\\]\\.prompt: cannot read \\$file .*missing\\.md`));
	}
});

test("prompt references join parts in read order with exactly one blank line", (t) => {
	// Each prompt-assembly group declares its own stand-in home root under its temporary directory and authors fixture content there, so results never depend on the contents of the real user home.
	const home = standInHomeRoot(temporaryDirectory(t), { "prompts/first.md": "first part\n   \n", "prompts/second.md": "second part\t\n" });
	const sourceFile = path.join(home, "nested", "source.jsonc");
	const value = { files: ["../prompts/first.md", path.join(home, "prompts", "second.md")], text: "added paragraph  " };
	const source = { permissionModes: { modes: { one: { systemPrompt: value } } } };
	// Entry order is preserved; trailing whitespace at each boundary is normalized before the single blank line.
	assert.deepEqual(resolveWithinScope(source, sourceFile, "", home), { permissionModes: { modes: { one: { systemPrompt: "first part\n\nsecond part\n\nadded paragraph" } } } });
	assert.deepEqual(value, { files: ["../prompts/first.md", path.join(home, "prompts", "second.md")], text: "added paragraph  " });
	assert.equal((resolveWithinScope({ subagents: { agents: { worker: { systemPrompt: { text: "text alone" } } } } }, sourceFile, "", home) as JsonObject).subagents.agents.worker.systemPrompt, "text alone");
});

test("~ expands from the declared home root for both prompt forms, not from process.env.HOME", async (t) => {
	const dir = temporaryDirectory(t);
	const home = standInHomeRoot(dir, { "home-prompt.md": "home content\n" });
	// The source directory is inside the stand-in root but is not the root itself, so only ~ expansion can reach this fixture.
	const sourceFile = path.join(home, "elsewhere", "source.jsonc");
	await withEnv({ HOME: path.join(dir, "not-the-declared-root") }, () => {
		assert.equal((resolveWithinScope({ subagents: { agents: { worker: { systemPrompt: { files: ["~/home-prompt.md"] } } } } }, sourceFile, "", home) as JsonObject).subagents.agents.worker.systemPrompt, "home content");
		// The legacy form still returns file content verbatim, only its path resolution gains ~ expansion.
		assert.equal((resolveWithinScope({ permissionModes: { fragments: { base: { systemPrompt: { $file: "~/home-prompt.md" } } } } }, sourceFile, "", home) as JsonObject).permissionModes.fragments.base.systemPrompt, "home content\n");
	});
	// Omitting the home root keeps the existing behavior: ~ resolves through the environment home.
	assert.equal(referencePath("~/home-prompt.md", sourceFile), path.join(os.homedir(), "home-prompt.md"));
});

test("read scope fails naming the key path and the reference outside the repository or the declared stand-in root", (t) => {
	const dir = temporaryDirectory(t);
	const home = standInHomeRoot(dir, { "inside.md": "in scope\n" });
	const sourceFile = path.join(home, "src.jsonc");
	for (const [keyPath, raw] of [["subagents.agents.worker.systemPrompt.files[0]", "/outside-this-run/outside.md"], ["permissionModes.modes.one.systemPrompt.$file", "../outside-the-stand-in-root.md"]] as const) {
		const value = raw.startsWith("/") ? { subagents: { agents: { worker: { systemPrompt: { files: [raw] } } } } } : { permissionModes: { modes: { one: { systemPrompt: { $file: raw } } } } };
		let failure = "";
		try { resolveWithinScope(value, sourceFile, "", home); } catch (error) { failure = (error as Error).message; }
		for (const part of [keyPath, JSON.stringify(raw)]) assert.ok(failure.includes(part), `the read-scope failure must name ${part}: ${failure}`);
	}
	// A reference inside the declared root stays in scope, so the same shape resolves normally.
	assert.equal((resolveWithinScope({ permissionModes: { modes: { one: { systemPrompt: { $file: "inside.md" } } } } }, sourceFile, "", home) as JsonObject).permissionModes.modes.one.systemPrompt, "in scope\n");
});

test("stripFrontmatter removes a leading --- block only when the entry asks for it", (t) => {
	const dir = temporaryDirectory(t);
	// Unclosed blocks are reported naming key path and file: no second delimiter, only the opening delimiter at end of file (which would otherwise be returned verbatim), and a final --- line with no trailing newline.
	const home = standInHomeRoot(dir, { "with-frontmatter.md": "---\ntitle: illustrative stand-in\n---\nbody line\n", "spaced-after-block.md": "---\ntitle: illustrative stand-in\n---\nbody line   \ntail", "unclosed.md": "---\ntitle: illustrative stand-in\nbody line\n", "opens-at-end-of-file.md": "---", "ends-without-newline.md": "---\ntitle: illustrative stand-in\nbody line\n---" });
	const sourceFile = path.join(home, "src.jsonc");
	const value = { files: [{ path: "with-frontmatter.md" }, { path: "with-frontmatter.md", stripFrontmatter: true }] };
	assert.equal((resolveWithinScope({ permissionModes: { modes: { one: { systemPrompt: value } } } }, sourceFile, "", home) as JsonObject).permissionModes.modes.one.systemPrompt,
		"---\ntitle: illustrative stand-in\n---\nbody line\n\nbody line");
	// Content after a closed block is returned byte for byte, including the spacing inside it.
	assert.equal((resolveWithinScope({ subagents: { agents: { worker: { systemPrompt: { files: [{ path: "spaced-after-block.md", stripFrontmatter: true }] } } } } }, sourceFile, "", home) as JsonObject).subagents.agents.worker.systemPrompt, "body line   \ntail");
	for (const name of ["unclosed.md", "opens-at-end-of-file.md", "ends-without-newline.md"]) {
		assert.throws(() => resolveWithinScope({ subagents: { agents: { worker: { systemPrompt: { files: [{ path: name, stripFrontmatter: true }] } } } } }, sourceFile, "", home),
			new RegExp(`subagents\\.agents\\.worker\\.systemPrompt\\.files\\[0\\]: frontmatter opened in .*${name} has no closing delimiter`));
	}
});

test("missing prompt references name their key path and resolved path", (t) => {
	const home = standInHomeRoot(temporaryDirectory(t)), sourceFile = path.join(home, "src.jsonc");
	for (const entry of ["missing.md", { path: "missing.md", stripFrontmatter: true }]) {
		assert.throws(() => resolveWithinScope({ subagents: { agents: { worker: { systemPrompt: { files: [entry] } } } } }, sourceFile, "", home),
			new RegExp(`subagents\\.agents\\.worker\\.systemPrompt\\.files\\[0\\]: cannot read referenced file .*missing\\.md`));
	}
});

test("empty or malformed prompt values report the key path", (t) => {
	const home = standInHomeRoot(temporaryDirectory(t), { "prompts/x.md": "kept verbatim\n" }), sourceFile = path.join(home, "src.jsonc");
	const prompt = (value: unknown) => ({ permissionModes: { modes: { one: { systemPrompt: value } } } });
	assert.throws(() => resolveWithinScope(prompt({ files: [{}] }), sourceFile, "", home), /systemPrompt\.files\[0\]: empty object/);
	assert.throws(() => resolveWithinScope(prompt({ text: 1 }), sourceFile, "", home), /systemPrompt: text must be a string/);
	assert.throws(() => resolveWithinScope(prompt({ files: [] }), sourceFile, "", home), /systemPrompt: must contain at least one file or text/);
	assert.throws(() => resolveWithinScope(prompt({ files: ["prompts/x.md"], extra: true }), sourceFile, "", home), /systemPrompt: prompt reference has unsupported fields: extra/);
	assert.throws(() => resolveWithinScope(prompt({ files: [{ path: "prompts/x.md", other: 1 }] }), sourceFile, "", home), /systemPrompt\.files\[0\]: unsupported fields: other/);
	// An entry object that carries only the flag, with no path, still reports its key path.
	assert.throws(() => resolveWithinScope(prompt({ files: [{ stripFrontmatter: true }] }), sourceFile, "", home), /permissionModes\.modes\.one\.systemPrompt\.files\[0\]: path must be a path string/);
	// A single-key $file object is not subject to unknown-key rejection.
	assert.equal((resolveWithinScope(prompt({ $file: "prompts/x.md" }), sourceFile, "", home) as JsonObject).permissionModes.modes.one.systemPrompt, "kept verbatim\n");
});

test("a prompt-position object with neither files nor text passes through as ordinary data", (t) => {
	const home = standInHomeRoot(temporaryDirectory(t)), sourceFile = path.join(home, "src.jsonc");
	// Only an object carrying files or text is read as the prompt-reference form, so a bare {} stays ordinary data.
	for (const [section, collection] of [["permissionModes", "modes"], ["subagents", "agents"]] as const) {
		const source = { [section]: { [collection]: { one: { systemPrompt: {} } } } };
		assert.deepEqual(resolveWithinScope(source, sourceFile, "", home), source);
	}
	// The same applies to an empty section, which the generator tests above cover only indirectly.
	assert.deepEqual(resolveWithinScope({ permissionModes: { modes: {} } }, sourceFile, "", home), { permissionModes: { modes: {} } });
});

test("assembled prompts flow through extends, override and null deletion in both sections", (t) => {
	const dir = temporaryDirectory(t);
	const home = standInHomeRoot(dir, { "prompts/base.md": "base body\n" });
	for (const [section, collection] of [["permissionModes", "modes"], ["subagents", "agents"]] as const) {
		const assembled = "base body\n\nadded by inline text";
		const source = { [section]: { fragments: { base: { systemPrompt: { files: ["prompts/base.md"], text: "added by inline text" } } }, [collection]: {
			inherited: { extends: ["base"] },
			overridden: { extends: ["base"], systemPrompt: { text: "replacement form" } },
			deleted: { extends: ["base"], systemPrompt: null },
		} } };
		const resolved = resolveWithinScope(source, path.join(home, "source.jsonc"), "", home) as Record<string, JsonObject>;
		assert.equal(resolved[section].fragments.base.systemPrompt, assembled);
		const merged = section === "permissionModes" ? buildConfig(resolved[section]).modes : buildSubagents(resolved[section]).agentOverrides;
		assert.deepEqual(merged, { inherited: { systemPrompt: assembled }, overridden: { systemPrompt: "replacement form" }, deleted: {} });
	}
});

test("generator writes, checks, detects drift and force overwrites", async (t) => {
	const dir = temporaryDirectory(t);
	const paths = { src: path.join(dir, "src.jsonc"), out: path.join(dir, "out.json"), state: path.join(dir, "state.json"), settings: path.join(dir, "settings.json"), subagentsState: path.join(dir, "subagents-state.json") };
	fs.writeFileSync(paths.src, JSON.stringify({ permissionModes: {
		output: { defaultMode: "default" },
		fragments: { common: { permission: { read: "allow" } } },
		modes: { default: { extends: ["common"], label: "Default" } },
	} }));
	assert.equal((await run({ ...paths, action: "check" })).status, "drift");
	assert.equal((await run({ ...paths, action: "gen" })).status, "wrote");
	const generated = JSON.parse(fs.readFileSync(paths.out, "utf8")) as JsonObject;
	assert.deepEqual(generated, {
		$comment: "Generated from permissions.src.jsonc. Do not edit this file by hand.",
		defaultMode: "default", modes: { default: { permission: { read: "allow" }, label: "Default" } },
	});
	assert.deepEqual(JSON.parse(fs.readFileSync(paths.state, "utf8")), generated);
	assert.equal((await run({ ...paths, action: "check" })).status, "clean");
	fs.writeFileSync(paths.out, JSON.stringify({ ...generated, defaultMode: "edited" }));
	const drift = await run({ ...paths, action: "gen" });
	assert.equal(drift.status, "drift");
	assert.match(drift.lines.join("\n"), /defaultMode/);
	assert.equal((await run({ ...paths, action: "gen", force: true })).status, "wrote");
	assert.deepEqual(JSON.parse(fs.readFileSync(paths.out, "utf8")), generated);
	assert.equal(fs.existsSync(paths.settings), false);
	assert.equal(fs.existsSync(paths.subagentsState), false);
});

test("existing CLI accepts explicit output and state paths", (t) => {
	const dir = temporaryDirectory(t);
	const src = path.join(dir, "src.jsonc"), out = path.join(dir, "out.json"), state = path.join(dir, "state.json");
	fs.writeFileSync(src, '{"permissionModes":{"output":{"defaultMode":"one"},"modes":{"one":{"label":"One"}}}}');
	const cli = fileURLToPath(new URL("./generate.ts", import.meta.url));
	for (const action of ["gen", "check"]) {
		const result = spawnSync(process.execPath, [cli, action, "--src", src, "--modes-out", out, "--modes-state", state, "--settings", path.join(dir, "settings"), "--subagents-state", path.join(dir, "subagents-state")], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	}
	assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).modes.one.label, "One");
});

function pathsFor(dir: string) {
	return { src: path.join(dir, "src.jsonc"), out: path.join(dir, "out.json"), state: path.join(dir, "state.json"), settings: path.join(dir, "settings.json"), subagentsState: path.join(dir, "subagents-state.json") };
}

test("outputs drift independently and force repairs both", async (t) => {
	const dir = temporaryDirectory(t), p = pathsFor(dir);
	fs.writeFileSync(p.src, JSON.stringify({ permissionModes: { modes: { one: { label: "one" } } }, subagents: { settings: { disableBuiltins: true }, agents: {} } }));
	fs.writeFileSync(p.settings, JSON.stringify({ before: 1, subagents: { disableBuiltins: false }, after: 2 }));
	assert.equal((await run({ ...p, action: "gen" })).status, "drift");
	assert.equal(JSON.parse(fs.readFileSync(p.out, "utf8")).modes.one.label, "one");
	assert.equal(fs.existsSync(p.subagentsState), false);
	assert.equal(JSON.parse(fs.readFileSync(p.settings, "utf8")).subagents.disableBuiltins, false);
	assert.equal((await run({ ...p, action: "gen", force: true })).status, "wrote");
	const settings = JSON.parse(fs.readFileSync(p.settings, "utf8"));
	assert.deepEqual(Object.keys(settings), ["before", "subagents", "after"]);
	assert.deepEqual(settings.subagents, { disableBuiltins: true, agentOverrides: {} });
	assert.deepEqual(JSON.parse(fs.readFileSync(p.subagentsState, "utf8")), { settings: settings.subagents });
	fs.writeFileSync(p.out, JSON.stringify({ edited: true }));
	fs.writeFileSync(p.src, JSON.stringify({ permissionModes: { modes: {} }, subagents: { settings: { disableBuiltins: false } } }));
	const drift = await run({ ...p, action: "gen" });
	assert.equal(drift.status, "drift");
	assert.deepEqual(JSON.parse(fs.readFileSync(p.settings, "utf8")).subagents, { disableBuiltins: false });
	assert.deepEqual(JSON.parse(fs.readFileSync(p.out, "utf8")), { edited: true });
});

test("settings reports stringify collisions and meaningful model scope key order", async (t) => {
	const dir = temporaryDirectory(t), p = pathsFor(dir);
	fs.writeFileSync(p.src, '{"permissionModes":{"modes":{}},"subagents":{"settings":{"numbers":[null,0],"modelScope":{"agents":{"worker":[1]," worker ":[2]}}}}}');
	assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
	const edited = '{"subagents":{"numbers":[1e400,-0],"modelScope":{"agents":{" worker ":[2],"worker":[1]}}}}';
	fs.writeFileSync(p.settings, edited);
	const baseline = fs.readFileSync(p.subagentsState, "utf8");
	const result = await run({ ...p, action: "check" });
	assert.equal(result.status, "drift");
	assert.ok(result.lines.includes("subagents.numbers[0]  last generated=null  file=Infinity"));
	assert.ok(result.lines.includes("subagents.numbers[1]  last generated=0  file=-0"));
	assert.ok(result.lines.includes('subagents.modelScope.agents: key order differs  last generated=["worker"," worker "]  file=[" worker ","worker"]'));
	for (const force of [false, true]) {
		assert.equal((await run({ ...p, action: "gen", force })).status, "error");
		assert.equal(fs.readFileSync(p.settings, "utf8"), edited);
		assert.equal(fs.readFileSync(p.subagentsState, "utf8"), baseline);
	}
});

test("first-adoption settings and later source drift report numeric collisions", async (t) => {
	const dir = temporaryDirectory(t), p = pathsFor(dir);
	fs.writeFileSync(p.src, '{"permissionModes":{"modes":{}},"subagents":{"settings":{"numbers":[null,0]}}}');
	const edited = '{"subagents":{"numbers":[1e400,-0]}}';
	fs.writeFileSync(p.settings, edited);
	const result = await run({ ...p, action: "check" });
	assert.equal(result.status, "drift");
	assert.ok(result.lines.includes("subagents.numbers[0]  generated=null  file=Infinity"));
	assert.ok(result.lines.includes("subagents.numbers[1]  generated=0  file=-0"));
	assert.equal((await run({ ...p, action: "gen", force: true })).status, "error");
	assert.equal(fs.readFileSync(p.settings, "utf8"), edited);
	assert.equal(fs.existsSync(p.subagentsState), false);
	fs.writeFileSync(p.src, '{"permissionModes":{"modes":{}},"subagents":{"settings":{"numbers":[1e400,-0]}}}');
	assert.equal((await run({ ...p, action: "check" })).status, "error");
});

test("mode output retains JSON serialization equality for numeric collisions", async (t) => {
	const dir = temporaryDirectory(t), p = pathsFor(dir);
	fs.writeFileSync(p.src, '{"permissionModes":{"output":{"numbers":[null,0]},"modes":{}}}');
	assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
	const edited = fs.readFileSync(p.out, "utf8").replace("0", "-0").replace("null", "1e400");
	fs.writeFileSync(p.out, edited);
	assert.equal((await run({ ...p, action: "check" })).status, "clean");
	assert.equal((await run({ ...p, action: "gen" })).status, "error");
	assert.equal(fs.readFileSync(p.out, "utf8"), edited);
});

test("check is read-only and matching outputs are adopted only by gen", async (t) => {
	const dir = temporaryDirectory(t), p = pathsFor(dir);
	fs.writeFileSync(p.src, JSON.stringify({ permissionModes: { modes: {} }, subagents: { settings: { x: 1 } } }));
	fs.writeFileSync(p.out, JSON.stringify({ $comment: "Generated from permissions.src.jsonc. Do not edit this file by hand.", modes: {} }));
	fs.writeFileSync(p.settings, JSON.stringify({ subagents: { x: 1 } }));
	const before = fs.readdirSync(dir).sort();
	assert.equal((await run({ ...p, action: "check" })).status, "clean");
	assert.deepEqual(fs.readdirSync(dir).sort(), before);
	assert.equal((await run({ ...p, action: "gen" })).status, "clean");
	assert.equal(fs.existsSync(p.state), true);
	assert.equal(fs.existsSync(p.subagentsState), true);
	fs.writeFileSync(p.out, '{"different":true}');
	const snapshot = fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")]);
	assert.equal((await run({ ...p, action: "check" })).status, "drift");
	assert.deepEqual(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")]), snapshot);
});

test("pending update refuses automatic adoption after interruption", async (t) => {
	const dir = temporaryDirectory(t), p = pathsFor(dir);
	fs.writeFileSync(p.src, JSON.stringify({ permissionModes: { modes: {} } }));
	fs.writeFileSync(p.out, JSON.stringify({ $comment: "Generated from permissions.src.jsonc. Do not edit this file by hand.", modes: {} }));
	fs.writeFileSync(`${p.out}.generator-pending`, "{}");
	assert.equal((await run({ ...p, action: "gen" })).status, "drift");
	assert.equal(fs.existsSync(p.state), false);
	assert.equal((await run({ ...p, action: "gen", force: true })).status, "wrote");
	assert.equal(fs.existsSync(`${p.out}.generator-pending`), false);
});

test("settings output preserves symlink, physical mode and unrelated keys", async (t) => {
	const dir = temporaryDirectory(t), p = pathsFor(dir), physical = path.join(dir, "actual.json");
	fs.writeFileSync(p.src, JSON.stringify({ permissionModes: { modes: {} }, subagents: { settings: { x: 1 } } }));
	fs.writeFileSync(physical, '{"other":true}', { mode: 0o640 });
	fs.symlinkSync("actual.json", p.settings);
	assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
	assert.equal(fs.lstatSync(p.settings).isSymbolicLink(), true);
	assert.equal(fs.statSync(physical).mode & 0o777, 0o640);
	assert.deepEqual(JSON.parse(fs.readFileSync(physical, "utf8")), { other: true, subagents: { x: 1 } });
});

test("rejects aliases before writing", async (t) => {
	const dir = temporaryDirectory(t), p = pathsFor(dir);
	fs.writeFileSync(p.src, JSON.stringify({ permissionModes: { modes: {} } }));
	fs.symlinkSync(path.basename(p.src), p.out);
	assert.match((await run({ ...p, action: "gen" })).lines.join(), /colliding paths/);
	assert.equal(fs.existsSync(p.state), false);
});

test("baseline rename failure leaves output complete, baseline unchanged and recovery marker", async (t) => {
	const dir = temporaryDirectory(t), p = pathsFor(dir);
	fs.writeFileSync(p.src, JSON.stringify({ permissionModes: { modes: { one: { label: "old" } } } }));
	assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
	const baseline = fs.readFileSync(p.state, "utf8");
	fs.writeFileSync(p.src, JSON.stringify({ permissionModes: { modes: { one: { label: "new" } } } }));
	const rename = fs.renameSync;
	fs.renameSync = ((from, to) => {
		if (to === p.state) throw new Error("injected baseline rename failure");
		return rename(from, to);
	}) as typeof fs.renameSync;
	try { assert.match((await run({ ...p, action: "gen" })).lines.join(), /injected baseline rename failure/); }
	finally { fs.renameSync = rename; }
	assert.equal(JSON.parse(fs.readFileSync(p.out, "utf8")).modes.one.label, "new");
	assert.equal(fs.readFileSync(p.state, "utf8"), baseline);
	assert.equal(fs.existsSync(`${p.out}.generator-pending`), true);
	assert.equal((await run({ ...p, action: "gen" })).status, "drift");
	assert.equal((await run({ ...p, action: "gen", force: true })).status, "wrote");
});

test("concurrent readers only see complete mode files", async (t) => {
	const dir = temporaryDirectory(t), p = pathsFor(dir);
	const { spawn } = await import("node:child_process");
	const { once } = await import("node:events");
	const source = (label: string) => JSON.stringify({ permissionModes: { modes: { one: { label: label.repeat(500_000) } } } });
	fs.writeFileSync(p.src, source("a"));
	assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
	const observer = `const fs=require('fs'); console.log('ready'); let n=0; const end=Date.now()+1500; while(Date.now()<end) { const x=JSON.parse(fs.readFileSync(process.argv[1])); if(x.modes.one.label.length!==500000) process.exit(2); n++; } if(!n) process.exit(3);`;
	const child = spawn(process.execPath, ["-e", observer, p.out], { stdio: ["ignore", "pipe", "pipe"] });
	const exit = once(child, "exit");
	await once(child.stdout, "data");
	for (const label of ["b", "c", "d", "e", "f"]) {
		fs.writeFileSync(p.src, source(label));
		assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
	}
	assert.equal((await exit)[0], 0);
});

test("concurrent generators serialize shared output and shared baseline with different sources", async (t) => {
	const { spawn } = await import("node:child_process");
	const { withOutputLocks } = await import("../../lib/settings-lock.ts");
	const cli = fileURLToPath(new URL("./generate.ts", import.meta.url));
	for (const shared of ["output", "baseline"]) {
		const dir = temporaryDirectory(t), a = pathsFor(dir), b = { ...pathsFor(dir), src: path.join(dir, "second.jsonc") };
		if (shared === "output") b.state = path.join(dir, "second-state.json");
		else b.out = path.join(dir, "second-out.json");
		fs.writeFileSync(a.src, JSON.stringify({ permissionModes: { modes: { one: { label: "a" } } } }));
		fs.writeFileSync(b.src, JSON.stringify({ permissionModes: { modes: { one: { label: "b" } } } }));
		const children: Promise<number | null>[] = [];
		const start = (p: typeof a) => new Promise<number | null>((resolve, reject) => {
			const child = spawn(process.execPath, [cli, "gen", "--force", "--src", p.src, "--modes-out", p.out, "--modes-state", p.state, "--settings", p.settings, "--subagents-state", p.subagentsState], { stdio: "ignore" });
			child.on("error", reject); child.on("exit", resolve);
		});
		await withOutputLocks([shared === "output" ? a.out : a.state], undefined, async () => {
			children.push(start(a), start(b));
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.equal(fs.existsSync(a.out), false);
		});
		assert.deepEqual(await Promise.all(children), [0, 0]);
		const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")).modes.one.label;
		if (shared === "output") {
			assert.deepEqual([read(a.state), read(b.state)], ["a", "b"]);
			assert.ok(["a", "b"].includes(read(a.out)));
		} else {
			assert.deepEqual([read(a.out), read(b.out)], ["a", "b"]);
			assert.ok(["a", "b"].includes(read(a.state)));
		}
	}
});

test("output write failure leaves the old complete file and baseline intact", async (t) => {
	const dir = temporaryDirectory(t), p = pathsFor(dir);
	fs.writeFileSync(p.src, JSON.stringify({ permissionModes: { modes: { one: { label: "old" } } } }));
	assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
	const output = fs.readFileSync(p.out, "utf8"), baseline = fs.readFileSync(p.state, "utf8");
	assert.equal(fs.statSync(p.out).mode & 0o777, 0o600);
	fs.writeFileSync(p.src, JSON.stringify({ permissionModes: { modes: { one: { label: "new" } } } }));
	const write = fs.writeFileSync;
	fs.writeFileSync = ((file, ...args) => {
		if (typeof file === "string" && path.basename(file).startsWith(".out.json.") && !path.basename(file).startsWith(".out.json.generator-pending.")) throw new Error("injected output write failure");
		return write(file, ...args);
	}) as typeof fs.writeFileSync;
	try { assert.match((await run({ ...p, action: "gen" })).lines.join(), /injected output write failure/); }
	finally { fs.writeFileSync = write; }
	assert.equal(fs.readFileSync(p.out, "utf8"), output);
	assert.equal(fs.readFileSync(p.state, "utf8"), baseline);
	assert.equal((await run({ ...p, action: "gen" })).status, "drift");
});

test("checks during a concurrent generator never mutate files", async (t) => {
	const dir = temporaryDirectory(t), p = pathsFor(dir);
	const { spawn } = await import("node:child_process");
	const { once } = await import("node:events");
	fs.writeFileSync(p.src, JSON.stringify({ permissionModes: { modes: { one: { label: "a" } } } }));
	assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
	const module = new URL("./generate.ts", import.meta.url).href;
	const script = `import {run} from ${JSON.stringify(module)}; import fs from 'node:fs'; const p=JSON.parse(process.argv[1]); console.log('ready'); for(let i=0;i<30;i++){fs.writeFileSync(p.src,JSON.stringify({permissionModes:{modes:{one:{label:String(i)}}}}));const r=await run({...p,action:'gen'});if(r.status==='error')process.exit(2);}`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(p)], { stdio: ["ignore", "pipe", "pipe"] });
	const exit = once(child, "exit");
	await once(child.stdout, "data");
	const methods = ["writeFileSync", "mkdirSync", "renameSync", "unlinkSync"] as const;
	const original = methods.map((name) => fs[name]);
	let mutations = 0;
	try {
		for (const name of methods) (fs as unknown as Record<string, unknown>)[name] = () => { mutations++; throw new Error("check attempted to mutate"); };
		for (let i = 0; i < 80; i++) {
			const result = await run({ ...p, action: "check" });
			assert.ok(["clean", "drift", "error"].includes(result.status));
		}
	} finally { methods.forEach((name, i) => { (fs as unknown as Record<string, unknown>)[name] = original[i]; }); }
	assert.equal(mutations, 0);
	assert.equal((await exit)[0], 0);
});

test("dangling settings link writes to the filesystem target without touching the lexical target", async (t) => {
	const dir = temporaryDirectory(t), p = pathsFor(dir), outside = path.join(dir, "outside");
	fs.mkdirSync(path.join(outside, "inner"), { recursive: true });
	fs.symlinkSync(path.join(outside, "inner"), path.join(dir, "jump"));
	fs.symlinkSync("jump/../target.json", p.settings);
	fs.writeFileSync(path.join(dir, "target.json"), '{"untouched":true}');
	fs.writeFileSync(p.src, JSON.stringify({ permissionModes: { modes: {} }, subagents: { settings: { x: 1 } } }));
	assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outside, "target.json"), "utf8")), { subagents: { x: 1 } });
	assert.equal(fs.readFileSync(path.join(dir, "target.json"), "utf8"), '{"untouched":true}');
	assert.equal(fs.lstatSync(p.settings).isSymbolicLink(), true);
});

test("queued generator reloads source and file references under the correct lock set", async (t) => {
	const { spawn } = await import("node:child_process");
	const { once } = await import("node:events");
	const { withOutputLocks } = await import("../../lib/settings-lock.ts");
	const module = new URL("./generate.ts", import.meta.url).href;
	for (const initiallyHasSubagents of [false, true]) {
		const dir = temporaryDirectory(t), p = pathsFor(dir), prompt = path.join(dir, "prompt.md");
		const source = (label: string, hasSubagents: boolean) => ({ permissionModes: { modes: { one: { label, prompt: { $file: "prompt.md" } } } }, ...(hasSubagents ? { subagents: { settings: { label } } } : {}) });
		fs.writeFileSync(p.src, JSON.stringify(source("old", initiallyHasSubagents)));
		fs.writeFileSync(prompt, "old prompt");
		const script = `import fs from 'node:fs'; import {run} from ${JSON.stringify(module)}; const p=JSON.parse(process.argv[1]); const original=fs.readFileSync; let notified=false; fs.readFileSync=function(file,...args){const result=original.call(this,file,...args); if(file===p.src&&!notified){notified=true; console.log('source-read');} return result;}; const result=await run({...p,action:'gen'}); console.log(JSON.stringify(result)); if(result.status==='error')process.exit(2);`;
		let exit: Promise<unknown[]>;
		let output = "";
		await withOutputLocks([p.out], undefined, async () => {
			const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(p)], { stdio: ["ignore", "pipe", "pipe"] });
			exit = once(child, "exit");
			child.stdout.on("data", (data) => { output += data.toString(); });
			await once(child.stdout, "data");
			assert.match(output, /source-read/);
			fs.writeFileSync(p.src, JSON.stringify(source("new", !initiallyHasSubagents)));
			fs.writeFileSync(prompt, "new prompt");
		});
		assert.equal((await exit!)[0], 0, output);
		assert.deepEqual(JSON.parse(fs.readFileSync(p.out, "utf8")).modes.one, { label: "new", prompt: "new prompt" });
		assert.deepEqual(JSON.parse(fs.readFileSync(p.state, "utf8")).modes.one, { label: "new", prompt: "new prompt" });
		if (initiallyHasSubagents) assert.equal(fs.existsSync(p.settings), false);
		else assert.deepEqual(JSON.parse(fs.readFileSync(p.settings, "utf8")).subagents, { label: "new" });
	}
});

test("durably orders marker, output and baseline before removing the marker", async (t) => {
	const dir = temporaryDirectory(t), p = pathsFor(dir), marker = `${p.out}.generator-pending`;
	fs.writeFileSync(p.src, JSON.stringify({ permissionModes: { modes: {} } }));
	const open = fs.openSync, close = fs.closeSync, sync = fs.fsyncSync, rename = fs.renameSync, unlink = fs.unlinkSync;
	const fds = new Map<number, string>(), events: string[] = [];
	fs.openSync = ((file, ...args) => { const fd = open(file, ...args); fds.set(fd, String(file)); return fd; }) as typeof fs.openSync;
	fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync;
	fs.fsyncSync = ((fd) => { events.push(`sync:${fds.get(fd)}`); return sync(fd); }) as typeof fs.fsyncSync;
	fs.renameSync = ((from, to) => { events.push(`rename:${to}`); return rename(from, to); }) as typeof fs.renameSync;
	fs.unlinkSync = ((file) => { events.push(`unlink:${file}`); return unlink(file); }) as typeof fs.unlinkSync;
	try { assert.equal((await run({ ...p, action: "gen" })).status, "wrote"); }
	finally { fs.openSync = open; fs.closeSync = close; fs.fsyncSync = sync; fs.renameSync = rename; fs.unlinkSync = unlink; }
	const markerRename = events.indexOf(`rename:${marker}`), outRename = events.indexOf(`rename:${p.out}`), stateRename = events.indexOf(`rename:${p.state}`), markerUnlink = events.indexOf(`unlink:${marker}`);
	assert.ok(markerRename >= 0 && markerRename < outRename && outRename < stateRename && stateRename < markerUnlink, events.join("\n"));
	for (const [begin, end] of [[markerRename, outRename], [outRename, stateRename], [stateRename, markerUnlink]]) {
		assert.ok(events.slice(begin + 1, end).includes(`sync:${dir}`), events.join("\n"));
	}
	for (const [prefix, before] of [[`.out.json.generator-pending.`, markerRename], [`.out.json.`, outRename], [`.state.json.`, stateRename]] as const) {
		assert.ok(events.slice(0, before).some((event) => event.startsWith(`sync:${path.join(dir, prefix)}`)), events.join("\n"));
	}
	assert.ok(events.slice(markerUnlink + 1).includes(`sync:${dir}`));
});

test("sync failure fails closed before output or leaves an interrupted marker", async (t) => {
	for (const failedRename of ["marker", "output", "baseline"]) {
		const dir = temporaryDirectory(t), p = pathsFor(dir), marker = `${p.out}.generator-pending`;
		fs.writeFileSync(p.src, JSON.stringify({ permissionModes: { modes: {} } }));
		const open = fs.openSync, close = fs.closeSync, sync = fs.fsyncSync, rename = fs.renameSync;
		const fds = new Map<number, string>(); let failNext = false;
		fs.openSync = ((file, ...args) => { const fd = open(file, ...args); fds.set(fd, String(file)); return fd; }) as typeof fs.openSync;
		fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync;
		fs.renameSync = ((from, to) => { const result = rename(from, to); if (to === ({ marker, output: p.out, baseline: p.state })[failedRename]) failNext = true; return result; }) as typeof fs.renameSync;
		fs.fsyncSync = ((fd) => { if (failNext && fds.get(fd) === dir) { failNext = false; throw new Error("injected directory sync failure"); } return sync(fd); }) as typeof fs.fsyncSync;
		try { assert.match((await run({ ...p, action: "gen" })).lines.join(), /injected directory sync failure/); }
		finally { fs.openSync = open; fs.closeSync = close; fs.fsyncSync = sync; fs.renameSync = rename; }
		assert.equal(fs.existsSync(marker), true);
		if (failedRename === "marker") assert.equal(fs.existsSync(p.out), false);
		assert.equal((await run({ ...p, action: "gen" })).status, "drift");
	}
});

test("older source snapshot cannot overwrite a newer completed generator", async (t) => {
	const { spawn } = await import("node:child_process");
	const { once } = await import("node:events");
	const dir = temporaryDirectory(t), p = pathsFor(dir), gate = path.join(dir, "gate");
	const source = (label: string) => JSON.stringify({ permissionModes: { modes: { one: { label } } } });
	fs.writeFileSync(p.src, source("old"));
	const module = new URL("./generate.ts", import.meta.url).href;
	const script = `import fs from 'node:fs'; import {run} from ${JSON.stringify(module)}; const p=JSON.parse(process.argv[1]), gate=process.argv[2]; const original=fs.readFileSync; let first=true; fs.readFileSync=function(file,...args){const result=original.call(this,file,...args); if(file===p.src&&first){first=false; console.log('snapshot'); while(!fs.existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);} return result;}; const result=await run({...p,action:'gen'}); if(result.status==='error') { console.error(result); process.exit(2); }`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(p), gate], { stdio: ["ignore", "pipe", "pipe"] });
	const exit = once(child, "exit");
	try {
		await once(child.stdout, "data");
		fs.writeFileSync(p.src, source("new"));
		assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
	} finally { fs.writeFileSync(gate, "go"); }
	assert.equal((await exit)[0], 0);
	assert.equal(JSON.parse(fs.readFileSync(p.out, "utf8")).modes.one.label, "new");
	assert.equal(JSON.parse(fs.readFileSync(p.state, "utf8")).modes.one.label, "new");
});

test("marker file sync failure never publishes the output", async (t) => {
	const dir = temporaryDirectory(t), p = pathsFor(dir);
	fs.writeFileSync(p.src, JSON.stringify({ permissionModes: { modes: {} } }));
	const open = fs.openSync, close = fs.closeSync, sync = fs.fsyncSync;
	const fds = new Map<number, string>();
	fs.openSync = ((file, ...args) => { const fd = open(file, ...args); fds.set(fd, String(file)); return fd; }) as typeof fs.openSync;
	fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync;
	fs.fsyncSync = ((fd) => { if (fds.get(fd)?.includes(".out.json.generator-pending.")) throw new Error("injected file sync failure"); return sync(fd); }) as typeof fs.fsyncSync;
	try { assert.match((await run({ ...p, action: "gen" })).lines.join(), /injected file sync failure/); }
	finally { fs.openSync = open; fs.closeSync = close; fs.fsyncSync = sync; }
	assert.equal(fs.existsSync(p.out), false);
	assert.equal(fs.existsSync(p.state), false);
	assert.equal(fs.existsSync(`${p.out}.generator-pending`), false);
});

test("generation does not open an existing unreadable searchable ancestor", async (t) => {
	const dir = temporaryDirectory(t), ancestor = path.join(dir, "search-only"), outputDir = path.join(ancestor, "writable");
	fs.mkdirSync(outputDir, { recursive: true });
	const p = { ...pathsFor(dir), out: path.join(outputDir, "out.json"), state: path.join(outputDir, "state.json") };
	fs.writeFileSync(p.src, JSON.stringify({ permissionModes: { modes: {} } }));
	fs.chmodSync(ancestor, 0o111);
	const open = fs.openSync; let attempted = false;
	try {
		fs.openSync = ((file, ...args) => {
			if (file === ancestor) { attempted = true; throw Object.assign(new Error("injected EACCES opening searchable ancestor"), { code: "EACCES" }); }
			return open(file, ...args);
		}) as typeof fs.openSync;
		const result = await run({ ...p, action: "gen" });
		assert.equal(result.status, "wrote", result.lines.join("\n"));
		assert.equal(attempted, false);
		assert.equal(fs.existsSync(`${p.out}.generator-pending`), false);
		assert.equal((await run({ ...p, action: "check" })).status, "clean");
	} finally { fs.openSync = open; fs.chmodSync(ancestor, 0o700); }
});

test("new output and baseline ancestors are synced before marker publication", async (t) => {
	const dir = temporaryDirectory(t), shared = path.join(dir, "new"), outputDir = path.join(shared, "out"), stateParent = path.join(shared, "state"), stateDir = path.join(stateParent, "deep");
	const p = { ...pathsFor(dir), out: path.join(outputDir, "out.json"), state: path.join(stateDir, "state.json") };
	fs.writeFileSync(p.src, JSON.stringify({ permissionModes: { modes: {} } }));
	const open = fs.openSync, close = fs.closeSync, sync = fs.fsyncSync, rename = fs.renameSync;
	const fds = new Map<number, string>(), events: string[] = [];
	fs.openSync = ((file, ...args) => { const fd = open(file, ...args); fds.set(fd, String(file)); return fd; }) as typeof fs.openSync;
	fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync;
	fs.fsyncSync = ((fd) => { events.push(`sync:${fds.get(fd)}`); return sync(fd); }) as typeof fs.fsyncSync;
	fs.renameSync = ((from, to) => { events.push(`rename:${to}`); return rename(from, to); }) as typeof fs.renameSync;
	try { assert.equal((await run({ ...p, action: "gen" })).status, "wrote"); }
	finally { fs.openSync = open; fs.closeSync = close; fs.fsyncSync = sync; fs.renameSync = rename; }
	const marker = events.indexOf(`rename:${p.out}.generator-pending`);
	assert.ok(marker >= 0, events.join("\n"));
	const beforeMarker = events.slice(0, marker);
	const expected = [shared, dir, outputDir, shared, stateParent, shared, stateDir, stateParent].map((item) => `sync:${item}`);
	let position = -1;
	for (const event of expected) {
		position = beforeMarker.indexOf(event, position + 1);
		assert.ok(position >= 0, events.join("\n"));
	}
	assert.equal(beforeMarker.includes(`sync:${path.dirname(dir)}`), false, events.join("\n"));
});

test("new ancestor sync failure stops before publishing a marker", async (t) => {
	const dir = temporaryDirectory(t), outputDir = path.join(dir, "new", "output");
	const p = { ...pathsFor(dir), out: path.join(outputDir, "out.json"), state: path.join(outputDir, "state.json") };
	fs.writeFileSync(p.src, JSON.stringify({ permissionModes: { modes: {} } }));
	const open = fs.openSync, close = fs.closeSync, sync = fs.fsyncSync;
	const fds = new Map<number, string>();
	fs.openSync = ((file, ...args) => { const fd = open(file, ...args); fds.set(fd, String(file)); return fd; }) as typeof fs.openSync;
	fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync;
	fs.fsyncSync = ((fd) => { if (fds.get(fd) === dir) throw new Error("injected ancestor sync failure"); return sync(fd); }) as typeof fs.fsyncSync;
	try {
		const result = await run({ ...p, action: "gen" });
		assert.equal(result.status, "error");
		assert.match(result.lines.join(), /injected ancestor sync failure/);
	} finally { fs.openSync = open; fs.closeSync = close; fs.fsyncSync = sync; }
	assert.equal(fs.existsSync(`${p.out}.generator-pending`), false);
	assert.equal(fs.existsSync(p.out), false);
	assert.equal(fs.existsSync(p.state), false);
});

test("retry syncs interrupted directory creation before publishing", async (t) => {
	for (const failure of ["mkdir", "child-sync", "parent-sync"]) {
		const dir = temporaryDirectory(t), shared = path.join(dir, "new"), outputDir = path.join(shared, "output");
		const p = { ...pathsFor(dir), out: path.join(outputDir, "out.json"), state: path.join(outputDir, "state.json") };
		fs.writeFileSync(p.src, JSON.stringify({ permissionModes: { modes: {} } }));
		const open = fs.openSync, close = fs.closeSync, sync = fs.fsyncSync, mkdir = fs.mkdirSync, rename = fs.renameSync;
		const fds = new Map<number, string>(), events: string[] = [];
		let created = false, failing = true;
		fs.openSync = ((file, ...args) => { const fd = open(file, ...args); fds.set(fd, String(file)); return fd; }) as typeof fs.openSync;
		fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync;
		fs.mkdirSync = ((file, ...args) => { const result = mkdir(file, ...args); if (file === shared) { created = true; if (failure === "mkdir" && failing) throw new Error("injected interruption"); } return result; }) as typeof fs.mkdirSync;
		fs.fsyncSync = ((fd) => { const file = fds.get(fd); events.push(`sync:${file}`); if (failing && created && file === (failure === "child-sync" ? shared : failure === "parent-sync" ? dir : "")) throw new Error("injected interruption"); return sync(fd); }) as typeof fs.fsyncSync;
		fs.renameSync = ((from, to) => { events.push(`rename:${to}`); return rename(from, to); }) as typeof fs.renameSync;
		try {
			assert.equal((await run({ ...p, action: "gen" })).status, "error", failure);
			assert.equal(fs.existsSync(shared), true);
			assert.equal(fs.existsSync(p.out), false);
			// An unresolved parent sync failure must also stop the retry.
			if (failure === "parent-sync") assert.equal((await run({ ...p, action: "gen" })).status, "error");
			failing = false; events.length = 0;
			assert.equal((await run({ ...p, action: "gen" })).status, "wrote", failure);
			const publication = events.indexOf(`rename:${p.out}.generator-pending`);
			const childSync = events.indexOf(`sync:${shared}`), parentSync = events.indexOf(`sync:${dir}`, childSync + 1);
			assert.ok(childSync >= 0 && parentSync > childSync && publication > parentSync, events.join("\n"));
		} finally { fs.openSync = open; fs.closeSync = close; fs.fsyncSync = sync; fs.mkdirSync = mkdir; fs.renameSync = rename; }
	}
});

test("concurrent mkdir intent cannot be used as an output or baseline, even via aliases", async (t) => {
	const { spawn } = await import("node:child_process");
	const { once } = await import("node:events");
	const { createHash } = await import("node:crypto");
	const dir = temporaryDirectory(t), p = pathsFor(dir), childDir = path.join(dir, "new");
	const marker = path.join(dir, `.generator-mkdir-${createHash("sha256").update("new").digest("hex")}`);
	const alias = path.join(dir, "intent-alias"), parentAlias = path.join(dir, "parent-alias");
	fs.symlinkSync(path.basename(marker), alias);
	fs.symlinkSync(dir, parentAlias);
	fs.writeFileSync(p.src, JSON.stringify({ permissionModes: { modes: {} }, subagents: { settings: { x: 1 } } }));
	const module = new URL("../../lib/settings-lock.ts", import.meta.url).href;
	const script = `import fs from 'node:fs'; import {mkdirDurably} from ${JSON.stringify(module)}; const symlink=fs.symlinkSync; fs.symlinkSync=(target,file,...args)=>{const result=symlink(target,file,...args); if(file===process.argv[2]){console.log('intent'); fs.readSync(0,Buffer.alloc(1),0,1,null);} return result;}; mkdirDurably(process.argv[1]);`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", script, childDir, marker], { stdio: ["pipe", "pipe", "pipe"] });
	const exit = once(child, "exit");
	try {
		assert.match(String((await once(child.stdout, "data"))[0]), /intent/);
		for (const key of ["out", "state", "settings", "subagentsState"] as const) {
			for (const collision of [marker, alias, path.join(parentAlias, path.basename(marker))]) {
				const result = await run({ ...p, [key]: collision, action: "gen", force: true });
				assert.equal(result.status, "error", `${key}: ${collision}: ${result.lines}`);
				assert.match(result.lines.join(), /reserved directory creation intent name/);
			}
		}
		assert.equal(fs.lstatSync(marker).isSymbolicLink(), true);
		assert.equal(fs.existsSync(path.join(dir, "pi-permission-generator:mkdir-v1")), false);
		assert.equal(fs.existsSync(p.out), false);
		assert.equal(fs.existsSync(p.state), false);
	} finally {
		child.stdin.end("x");
		const [code] = await exit;
		assert.equal(code, 0);
	}
	assert.equal(fs.existsSync(marker), false);
	assert.equal(fs.existsSync(childDir), true);
});

test("concurrent creator's unsynced ancestor is synced before publishing", async (t) => {
	const { spawn } = await import("node:child_process");
	const { once } = await import("node:events");
	const dir = temporaryDirectory(t), shared = path.join(dir, "new"), outputDir = path.join(shared, "output");
	const p = { ...pathsFor(dir), out: path.join(outputDir, "out.json"), state: path.join(outputDir, "state.json") };
	fs.writeFileSync(p.src, JSON.stringify({ permissionModes: { modes: {} } }));
	const module = new URL("../../lib/settings-lock.ts", import.meta.url).href;
	const script = `import fs from 'node:fs'; import {mkdirDurably} from ${JSON.stringify(module)}; const mkdir=fs.mkdirSync; fs.mkdirSync=(file,...args)=>{const result=mkdir(file,...args); if(file===process.argv[1]){console.log('created'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);} return result;}; mkdirDurably(process.argv[2]);`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", script, shared, outputDir], { stdio: ["ignore", "pipe", "pipe"] });
	const exit = once(child, "exit");
	const open = fs.openSync, close = fs.closeSync, sync = fs.fsyncSync, rename = fs.renameSync;
	const fds = new Map<number, string>(), events: string[] = [];
	try {
		const [data] = await once(child.stdout, "data");
		assert.match(String(data), /created/);
		fs.openSync = ((file, ...args) => { const fd = open(file, ...args); fds.set(fd, String(file)); return fd; }) as typeof fs.openSync;
		fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync;
		fs.fsyncSync = ((fd) => { events.push(`sync:${fds.get(fd)}`); return sync(fd); }) as typeof fs.fsyncSync;
		fs.renameSync = ((from, to) => { events.push(`rename:${to}`); return rename(from, to); }) as typeof fs.renameSync;
		assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
		const childSync = events.indexOf(`sync:${shared}`), parentSync = events.indexOf(`sync:${dir}`, childSync + 1), publication = events.indexOf(`rename:${p.out}.generator-pending`);
		assert.ok(childSync >= 0 && parentSync > childSync && publication > parentSync, events.join("\n"));
	} finally { fs.openSync = open; fs.closeSync = close; fs.fsyncSync = sync; fs.renameSync = rename; child.kill(); await exit; }
});

test("unsafe source numbers fail before any output or baseline mutation", async (t) => {
	for (const section of [
		'"permissionModes":{"output":{"nested":[VALUE]},"modes":{}}',
		'"permissionModes":{"modes":{"one":{"nested":[VALUE]}}}',
		'"permissionModes":{"modes":{}},"subagents":{"settings":{"nested":[VALUE]}}',
		'"permissionModes":{"modes":{}},"subagents":{"config":{"nested":[VALUE]}}',
		'"permissionModes":{"modes":{}},"subagents":{"agents":{"worker":{"nested":[VALUE]}}}',
	]) for (const number of ["-0", "1e400", "-1e400", "1.234567890123456789", "1e-400"]) {
		const dir = temporaryDirectory(t), p = { ...pathsFor(dir), subagentConfig: path.join(dir, "config") };
		fs.writeFileSync(p.src, '{"permissionModes":{"modes":{}},"subagents":{"settings":{"v":1},"config":{"v":1}}}');
		assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
		const files = [p.out, p.state, p.settings, p.subagentsState, p.subagentConfig];
		const before = files.map((file) => fs.readFileSync(file, "utf8"));
		fs.writeFileSync(p.src, `{${section.replace("VALUE", number)}}`);
		for (const action of ["check", "gen"] as const) {
			const result = await run({ ...p, action, force: true });
			assert.equal(result.status, "error", `${section} ${number}`);
			assert.match(result.lines.join(), /cannot be preserved/);
			assert.deepEqual(files.map((file) => fs.readFileSync(file, "utf8")), before);
		}
	}
});

test("unsafe existing nested numbers preflight all active outputs without mutation", async (t) => {
	for (const target of ["out", "state", "settings", "subagentsState", "subagentConfig"] as const) for (const number of ["-0", "1e400", "9007199254740993"]) {
		const dir = temporaryDirectory(t), p = { ...pathsFor(dir), subagentConfig: path.join(dir, "config") };
		fs.writeFileSync(p.src, '{"permissionModes":{"modes":{}},"subagents":{"settings":{"v":1},"config":{"v":1}}}');
		assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
		const original = fs.readFileSync(p[target], "utf8");
		fs.writeFileSync(p[target], original.replace(/\}\s*$/, `,"unrelated":{"deep":[${number}]}}`));
		fs.writeFileSync(p.src, '{"permissionModes":{"output":{"changed":true},"modes":{}},"subagents":{"settings":{"v":2},"config":{"v":2}}}');
		const files = [p.out, p.state, p.settings, p.subagentsState, p.subagentConfig];
		const before = files.map((file) => fs.readFileSync(file, "utf8"));
		const result = await run({ ...p, action: "gen", force: true });
		assert.equal(result.status, "error", `${target} ${number}`);
		assert.match(result.lines.join(), /cannot be preserved/);
		assert.deepEqual(files.map((file) => fs.readFileSync(file, "utf8")), before);
		assert.equal(files.some((file) => fs.existsSync(`${file}.generator-pending`)), false);
	}
});

test("equivalent decimal spellings and ordinary finite values generate without drift", async (t) => {
	const dir = temporaryDirectory(t), p = pathsFor(dir);
	fs.writeFileSync(p.src, '{"permissionModes":{"output":{"numbers":[0,0.0,1.00,10e-1,1e21,0.1]},"modes":{}},"subagents":{"settings":{"numbers":[0,1.00,0.1]}}}');
	assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
	assert.equal((await run({ ...p, action: "check" })).status, "clean");
	assert.equal((await run({ ...p, action: "gen" })).status, "clean");
});

test("overwritten unsafe source numbers in JSONC fail before output mutation", async (t) => {
	const dir = temporaryDirectory(t), p = { ...pathsFor(dir), subagentConfig: path.join(dir, "config") };
	fs.writeFileSync(p.src, '{"permissionModes":{"modes":{}},"subagents":{"settings":{"v":1},"config":{"v":1}}}');
	assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
	const files = [p.out, p.state, p.settings, p.subagentsState, p.subagentConfig];
	const before = files.map((file) => fs.readFileSync(file, "utf8"));
	fs.writeFileSync(p.src, '{"permissionModes":{"output":{"x":9007199254740993, /* duplicate */ "x":1},"modes":{}}}');
	for (const action of ["check", "gen"] as const) {
		const result = await run({ ...p, action, force: true });
		assert.equal(result.status, "error");
		assert.match(result.lines.join(), /9007199254740993.*cannot be preserved/);
		assert.deepEqual(files.map((file) => fs.readFileSync(file, "utf8")), before);
	}
});

test("source JSONC number diagnostics label offsets after comments and trailing commas are stripped", async (t) => {
	const dir = temporaryDirectory(t), p = { ...pathsFor(dir), subagentConfig: path.join(dir, "config") };
	fs.writeFileSync(p.src, '{"permissionModes":{"modes":{}},"subagents":{"settings":{"v":1},"config":{"v":1}}}');
	assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
	const files = [p.out, p.state, p.settings, p.subagentsState, p.subagentConfig];
	const before = files.map((file) => fs.readFileSync(file, "utf8"));
	const text = '{ // preceding comment\n"permissionModes":{"output":{"ignored":[1,], /* block comment */ "x":9007199254740993},"modes":{}}}';
	fs.writeFileSync(p.src, text);
	const offset = stripJsonc(text).indexOf("9007199254740993");
	assert.notEqual(offset, text.indexOf("9007199254740993"));
	for (const action of ["check", "gen"] as const) {
		const result = await run({ ...p, action, force: true });
		assert.equal(result.status, "error");
		assert.ok(result.lines.some((line) => line.includes(`${p.src}: number 9007199254740993 at offset ${offset} in stripped JSONC`)));
		assert.deepEqual(files.map((file) => fs.readFileSync(file, "utf8")), before);
		assert.equal(files.some((file) => fs.existsSync(`${file}.generator-pending`)), false);
	}
});

test("overwritten unsafe numbers in active files preflight without mutation", async (t) => {
	for (const target of ["out", "state", "settings", "subagentsState", "subagentConfig"] as const) {
		const dir = temporaryDirectory(t), p = { ...pathsFor(dir), subagentConfig: path.join(dir, "config") };
		fs.writeFileSync(p.src, '{"permissionModes":{"modes":{}},"subagents":{"settings":{"v":1},"config":{"v":1}}}');
		assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
		fs.writeFileSync(p[target], '{"unrelated":{"x":9007199254740993,"x":1}}');
		fs.writeFileSync(p.src, '{"permissionModes":{"output":{"changed":true},"modes":{}},"subagents":{"settings":{"v":2},"config":{"v":2}}}');
		const files = [p.out, p.state, p.settings, p.subagentsState, p.subagentConfig];
		const before = files.map((file) => fs.readFileSync(file, "utf8"));
		for (const force of [false, true]) {
			const result = await run({ ...p, action: "gen", force });
			assert.equal(result.status, "error", target);
			assert.match(result.lines.join(), /9007199254740993.*cannot be preserved/);
			assert.deepEqual(files.map((file) => fs.readFileSync(file, "utf8")), before);
			assert.equal(files.some((file) => fs.existsSync(`${file}.generator-pending`)), false);
		}
	}
});

test("deep existing data and unexpected preflight failures leave all outputs unchanged", async (t) => {
	for (const failure of ["deep-safe", "deep-unsafe", "read-error", "read-syntax-error"] as const) {
		const dir = temporaryDirectory(t), p = { ...pathsFor(dir), subagentConfig: path.join(dir, "config") };
		fs.writeFileSync(p.src, '{"permissionModes":{"modes":{}},"subagents":{"settings":{"v":1},"config":{"v":1}}}');
		assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
		if (failure !== "read-error" && failure !== "read-syntax-error") {
			const depth = 20000;
			fs.writeFileSync(p.settings, `{"unrelated":${"[".repeat(depth)}${failure === "deep-unsafe" ? "9007199254740993" : "1"}${"]".repeat(depth)}}`);
		}
		fs.writeFileSync(p.src, '{"permissionModes":{"output":{"changed":true},"modes":{}},"subagents":{"settings":{"v":2},"config":{"v":2}}}');
		const files = [p.out, p.state, p.settings, p.subagentsState, p.subagentConfig];
		const before = files.map((file) => fs.readFileSync(file, "utf8"));
		const read = fs.readFileSync;
		if (failure === "read-error" || failure === "read-syntax-error") fs.readFileSync = ((file, ...args) => {
			if (file === p.settings) throw failure === "read-error" ? new Error("injected preflight failure") : new SyntaxError("injected preflight failure");
			return read(file, ...args);
		}) as typeof fs.readFileSync;
		try {
			const result = await run({ ...p, action: "gen", force: true });
			assert.equal(result.status, "error", failure);
			assert.ok(result.lines.some((line) => line.startsWith(`${p.settings}: `)), failure);
			assert.match(result.lines.join(), failure.startsWith("read-") ? /injected preflight failure/ : /Maximum call stack size exceeded/);
		} finally { fs.readFileSync = read; }
		assert.deepEqual(files.map((file) => fs.readFileSync(file, "utf8")), before);
		assert.equal(files.some((file) => fs.existsSync(`${file}.generator-pending`)), false);
	}
});

test("malformed settings retain independent output behavior", async (t) => {
	const dir = temporaryDirectory(t), p = pathsFor(dir);
	fs.writeFileSync(p.src, '{"permissionModes":{"modes":{}},"subagents":{"settings":{"v":1}}}');
	fs.writeFileSync(p.settings, '{"broken":');
	const result = await run({ ...p, action: "gen" });
	assert.equal(result.status, "error");
	assert.match(result.lines.join(), /not valid JSON/);
	assert.equal(fs.existsSync(p.out), true);
	assert.equal(fs.existsSync(p.state), true);
	assert.equal(fs.readFileSync(p.settings, "utf8"), '{"broken":');
});
