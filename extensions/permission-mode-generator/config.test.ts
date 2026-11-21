import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { run } from "./generate.ts";
import { withOutputLocks } from "../../lib/settings-lock.ts";

function fixture(t: test.TestContext) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-config-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const p = { src: path.join(dir, "src"), out: path.join(dir, "out"), state: path.join(dir, "state"), settings: path.join(dir, "settings"), subagentsState: path.join(dir, "shared"), subagentConfig: path.join(dir, "nested", "config.json") };
	const source = (subagents: object) => fs.writeFileSync(p.src, JSON.stringify({ permissionModes: { modes: {} }, subagents }));
	const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
	return { dir, p, source, read };
}

test("config inheritance, ownership, omission, re-enable and removal", async (t) => {
	const { p, source, read } = fixture(t);
	fs.mkdirSync(path.dirname(p.subagentConfig));
	fs.writeFileSync(p.subagentConfig, JSON.stringify({ first: 1, keep: { x: 2 }, last: 3 }));
	source({ fragments: { common: { inherited: { x: 1 }, list: [1] } }, config: { extends: ["common"], list: null, first: 1 } });
	assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
	assert.deepEqual(Object.keys(read(p.subagentConfig)), ["first", "keep", "last", "inherited"]);
	assert.deepEqual(read(p.subagentsState).config, { inherited: { x: 1 }, first: 1 });
	const saved = fs.readFileSync(p.subagentConfig, "utf8"), baseline = read(p.subagentsState).config;
	source({ settings: { x: 2 } });
	assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
	assert.equal(fs.readFileSync(p.subagentConfig, "utf8"), saved);
	assert.deepEqual(read(p.subagentsState).config, baseline);
	source({ config: {} });
	assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
	assert.deepEqual(read(p.subagentConfig), { keep: { x: 2 }, last: 3 });
	assert.deepEqual(read(p.subagentsState).config, {});
});

test("no config entry never reads config, even when malformed", async (t) => {
	const { p, source } = fixture(t);
	fs.mkdirSync(path.dirname(p.subagentConfig)); fs.writeFileSync(p.subagentConfig, "invalid JSON");
	fs.writeFileSync(p.subagentsState, JSON.stringify({ config: { old: 1 } }));
	source({ settings: {} });
	const original = fs.readFileSync;
	fs.readFileSync = ((file, ...args) => { if (file === p.subagentConfig) throw new Error("config was read"); return original(file, ...args); }) as typeof fs.readFileSync;
	try { assert.equal((await run({ ...p, action: "gen" })).status, "wrote"); assert.equal((await run({ ...p, action: "check" })).status, "clean"); }
	finally { fs.readFileSync = original; }
	assert.deepEqual(JSON.parse(fs.readFileSync(p.subagentsState, "utf8")).config, { old: 1 });
});

test("unadopted keys, key-order equality and array order", async (t) => {
	const { p, source, read } = fixture(t);
	fs.mkdirSync(path.dirname(p.subagentConfig));
	fs.writeFileSync(p.subagentConfig, JSON.stringify({ owned: { b: 2, a: 1 }, unrelated: true }));
	source({ config: { owned: { a: 1, b: 2 } } });
	assert.equal((await run({ ...p, action: "check" })).status, "drift"); // other outputs missing
	assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
	assert.deepEqual(read(p.subagentsState).config, { owned: { a: 1, b: 2 } });
	assert.equal((await run({ ...p, action: "check" })).status, "clean");
	source({ config: { owned: [1, 2], newKey: 3 } });
	fs.writeFileSync(p.subagentConfig, JSON.stringify({ owned: { a: 1, b: 2 }, unrelated: true, newKey: 9 }));
	assert.equal((await run({ ...p, action: "gen" })).status, "drift");
	assert.equal(read(p.subagentConfig).newKey, 9);
	assert.equal((await run({ ...p, action: "gen", force: true })).status, "wrote");
	assert.deepEqual(read(p.subagentConfig), { owned: [1, 2], unrelated: true, newKey: 3 });
	fs.writeFileSync(p.subagentConfig, JSON.stringify({ owned: [2, 1], unrelated: true, newKey: 3 }));
	assert.equal((await run({ ...p, action: "gen" })).status, "drift");
});

test("first generation refuses differing owned keys but never adopts unrelated keys", async (t) => {
	const { p, source, read } = fixture(t);
	fs.mkdirSync(path.dirname(p.subagentConfig));
	fs.writeFileSync(p.subagentConfig, JSON.stringify({ owned: 9, unrelated: { a: 1 } }));
	source({ config: { owned: 1 } });
	for (const action of ["check", "gen"] as const) {
		const result = await run({ ...p, action });
		assert.equal(result.status, "drift");
		assert.ok(result.lines.includes("subagents.config.owned  generated=1  file=9"));
		assert.equal(result.lines.some((line) => line.includes("last generated")), false);
	}
	assert.deepEqual(read(p.subagentConfig), { owned: 9, unrelated: { a: 1 } });
	assert.equal(Object.hasOwn(read(p.subagentsState), "config"), false);
	assert.equal((await run({ ...p, action: "gen", force: true })).status, "wrote");
	assert.deepEqual(read(p.subagentsState).config, { owned: 1 });
	assert.deepEqual(read(p.subagentConfig), { owned: 1, unrelated: { a: 1 } });
});

test("config drift reports adopted and new keys with their correct provenance", async (t) => {
	const { p, source, read } = fixture(t);
	source({ config: { adopted: 1, removed: 2 } });
	assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
	source({ config: { adopted: 3, newKey: 4, matching: { a: 1, b: 2 } } });
	fs.writeFileSync(p.subagentConfig, JSON.stringify({ adopted: 9, newKey: 8, matching: { b: 2, a: 1 }, unrelated: true }));
	for (const action of ["check", "gen"] as const) {
		const result = await run({ ...p, action });
		assert.equal(result.status, "drift");
		assert.ok(result.lines.includes("subagents.config.adopted  last generated=1  file=9"));
		assert.ok(result.lines.includes("subagents.config.removed  last generated=2  file=(missing)"));
		assert.ok(result.lines.includes("subagents.config.newKey  generated=4  file=8"));
		assert.equal(result.lines.some((line) => line.includes("matching") || line.includes("unrelated")), false);
	}
	assert.deepEqual(read(p.subagentsState).config, { adopted: 1, removed: 2 });
	assert.equal((await run({ ...p, action: "gen", force: true })).status, "wrote");
	assert.deepEqual(read(p.subagentsState).config, { adopted: 3, newKey: 4, matching: { a: 1, b: 2 } });
	assert.equal((await run({ ...p, action: "check" })).status, "clean");
});

test("settings and config drift and errors preserve each other's baseline", async (t) => {
	const { p, source, read } = fixture(t);
	source({ settings: { n: 1 }, config: { x: 1 } });
	assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
	fs.writeFileSync(p.settings, JSON.stringify({ subagents: { n: 99 } }));
	source({ settings: { n: 2 }, config: { x: 2 } });
	assert.equal((await run({ ...p, action: "gen" })).status, "drift");
	assert.deepEqual(read(p.subagentsState), { settings: { n: 1 }, config: { x: 2 } });
	fs.writeFileSync(p.settings, JSON.stringify({ subagents: { n: 1 } }));
	fs.writeFileSync(p.subagentConfig, JSON.stringify({ x: 99 }));
	source({ settings: { n: 3 }, config: { x: 3 } });
	assert.equal((await run({ ...p, action: "gen" })).status, "drift");
	assert.deepEqual(read(p.subagentsState), { settings: { n: 3 }, config: { x: 2 } });
	source({ settings: { n: 4 }, config: { permissions: { rules: { bash: "deny" } } } });
	assert.equal((await run({ ...p, action: "gen" })).status, "error");
	assert.deepEqual(read(p.subagentsState), { settings: { n: 4 }, config: { x: 2 } });
	fs.writeFileSync(p.settings, "invalid JSON");
	fs.writeFileSync(p.subagentConfig, JSON.stringify({ x: 2 }));
	source({ settings: { n: 5 }, config: { x: 5 } });
	assert.equal((await run({ ...p, action: "gen" })).status, "error");
	assert.deepEqual(read(p.subagentsState), { settings: { n: 4 }, config: { x: 5 } });
});

test("permission validation matches reserved tools and final candidate wait name", async (t) => {
	const { p, source } = fixture(t);
	const cases: [unknown, RegExp][] = [
		[false, /permissions must be an object/], [{ rules: false }, /rules must be an object/],
		[{ extra: 1 }, /unsupported fields/], [{ rules: { " ": "allow" } }, /empty tool/],
		[{ rules: { bash: "ask" } }, /bash is unsupported/], [{ rules: { edit: "yes" } }, /must be allow/],
		...(["contact_supervisor", "intercom", "structured_output", "bg_wait", "custom_wait"].map((name): [unknown, RegExp] => [{ rules: { [name]: "deny" } }, /reserved/])),
	];
	for (const [permissions, pattern] of cases) {
		source({ config: { waitTool: { name: "custom_wait" }, permissions } });
		const r = await run({ ...p, action: "gen", force: true });
		assert.equal(r.status, "error", JSON.stringify(permissions)); assert.match(r.lines.join(" "), pattern);
	}
	fs.mkdirSync(path.dirname(p.subagentConfig), { recursive: true });
	fs.writeFileSync(p.subagentConfig, JSON.stringify({ permissions: { rules: { bg_wait: "deny" } } }));
	source({ config: { other: true } });
	assert.match((await run({ ...p, action: "gen" })).lines.join(), /bg_wait.*reserved/);
	fs.writeFileSync(p.subagentConfig, JSON.stringify({ permissions: { rules: null } }));
	assert.match((await run({ ...p, action: "gen" })).lines.join(), /rules must be an object/);
	fs.writeFileSync(p.subagentConfig, JSON.stringify({ waitTool: { name: "custom_wait" }, permissions: { rules: { custom_wait: "deny" } } }));
	source({ config: { other: true } });
	assert.match((await run({ ...p, action: "gen" })).lines.join(), /custom_wait.*reserved/);
	fs.writeFileSync(p.subagentConfig, JSON.stringify({ permissions: { rules: { next_wait: "deny" } } }));
	source({ config: { waitTool: { name: "next_wait" } } });
	assert.match((await run({ ...p, action: "gen" })).lines.join(), /next_wait.*reserved/);
	source({ fragments: { bad: { permissions: { rules: false } } }, config: { extends: ["bad"], permissions: { rules: null } } });
	assert.equal((await run({ ...p, action: "gen", force: true })).status, "wrote");
});

test("config extends cannot reference agents, modes or unknown fragments", async (t) => {
	const { p, source } = fixture(t);
	for (const ref of ["worker", "default", "missing"]) {
		source({ agents: { worker: {} }, config: { extends: [ref] } });
		const r = await run({ ...p, action: "gen" });
		assert.equal(r.status, "error"); assert.match(r.lines.join(), new RegExp(`subagents.config: unknown extends "${ref}"`));
	}
});

test("check with active config creates no files or directories", async (t) => {
	const { p, source, dir } = fixture(t);
	source({ config: { x: 1 } });
	const before = fs.readdirSync(dir);
	assert.equal((await run({ ...p, action: "check" })).status, "drift");
	assert.deepEqual(fs.readdirSync(dir), before);
	assert.equal(fs.existsSync(path.dirname(p.subagentConfig)), false);
});

test("config symlinks, modes, atomic failure cleanup and read-only check", async (t) => {
	const { p, source, dir, read } = fixture(t); source({ config: { x: 1 } });
	fs.mkdirSync(path.dirname(p.subagentConfig));
	const target = path.join(dir, "physical"); fs.writeFileSync(target, '{"keep":1}', { mode: 0o640 }); fs.symlinkSync(target, p.subagentConfig);
	assert.equal((await run({ ...p, action: "gen" })).status, "wrote");
	assert.equal(fs.lstatSync(p.subagentConfig).isSymbolicLink(), true); assert.equal(fs.statSync(target).mode & 0o777, 0o640);
	assert.deepEqual(read(target), { keep: 1, x: 1 });
	source({ config: { x: 2 } });
	const original = fs.renameSync;
	fs.renameSync = ((from, to) => { if (to === target) throw new Error("injected config failure"); return original(from, to); }) as typeof fs.renameSync;
	try { assert.match((await run({ ...p, action: "gen" })).lines.join(), /injected config failure/); } finally { fs.renameSync = original; }
	assert.deepEqual(read(target), { keep: 1, x: 1 });
	assert.deepEqual(read(p.subagentsState).config, { x: 1 });
	assert.equal(fs.readdirSync(dir).some((x) => x.startsWith(".physical.") && x.endsWith(".tmp")), false);
	assert.equal((await run({ ...p, action: "check" })).status, "drift");
	assert.equal((await run({ ...p, action: "gen", force: true })).status, "wrote");
	fs.unlinkSync(p.subagentConfig); fs.symlinkSync(path.join(dir, "missing"), p.subagentConfig);
	assert.equal((await run({ ...p, action: "gen", force: true })).status, "wrote");
	assert.equal(fs.lstatSync(p.subagentConfig).isSymbolicLink(), true);
	assert.equal(fs.statSync(path.join(dir, "missing")).mode & 0o777, 0o600);
});

test("CLI accepts config path and rejects collisions including symlink and hardlink aliases", async (t) => {
	const { p, source, dir } = fixture(t); source({ config: { x: 1 } });
	const cli = fileURLToPath(new URL("./generate.ts", import.meta.url));
	const args = [cli, "gen", "--src", p.src, "--modes-out", p.out, "--modes-state", p.state, "--settings", p.settings, "--subagents-state", p.subagentsState, "--subagent-config"];
	let r = spawnSync(process.execPath, [...args, p.subagentConfig], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr);
	for (const target of [p.src, p.out, p.state, p.settings, p.subagentsState]) {
		for (const aliasKind of ["direct", "sym", "hard"]) {
			const alias = path.join(dir, `alias-${aliasKind}`);
			if (aliasKind === "sym") fs.symlinkSync(target, alias);
			if (aliasKind === "hard") fs.linkSync(target, alias);
			r = spawnSync(process.execPath, [...args, aliasKind === "direct" ? target : alias], { encoding: "utf8" });
			assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, /colliding paths/);
			if (aliasKind !== "direct") fs.unlinkSync(alias);
		}
	}
});

test("generators serialize config and shared baseline with different sources", async (t) => {
	const { p, source, read, dir } = fixture(t); source({ settings: { x: "a" }, config: { x: "a" } });
	const second = path.join(dir, "second"); fs.writeFileSync(second, JSON.stringify({ permissionModes: { modes: {} }, subagents: { settings: { x: "b" }, config: { x: "b" } } }));
	const module = new URL("./generate.ts", import.meta.url).href;
	const script = `import {run} from ${JSON.stringify(module)}; const p=JSON.parse(process.argv[1]); const r=await run({...p,action:'gen',force:true}); if(r.status==='error') {console.error(r);process.exit(2);}`;
	const children: Promise<unknown[]>[] = [];
	await withOutputLocks([p.subagentConfig], undefined, async () => {
		for (const src of [p.src, second]) { const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify({ ...p, src })], { stdio: "ignore" }); children.push(once(child, "exit")); }
		await new Promise((resolve) => setTimeout(resolve, 300)); assert.equal(fs.existsSync(p.out), false);
	});
	for (const child of children) assert.equal((await child)[0], 0);
	const shared = read(p.subagentsState); assert.deepEqual(shared.config, read(p.subagentConfig));
	assert.deepEqual(shared.settings, read(p.settings).subagents); assert.equal(shared.config.x, shared.settings.x);
});
