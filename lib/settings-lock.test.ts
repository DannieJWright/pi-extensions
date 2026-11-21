import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdirDurably, physicalPath, withOutputLocks } from "./settings-lock.ts";

function fixture(t: test.TestContext): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-lock-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("mkdir intent name conflicts fail without changing the existing file", (t) => {
	const dir = fixture(t), name = "new", child = path.join(dir, name);
	const marker = path.join(dir, `.generator-mkdir-${createHash("sha256").update(name).digest("hex")}`);
	fs.writeFileSync(marker, "unrelated");
	assert.throws(() => mkdirDurably(child), /Directory creation intent conflicts with existing path/);
	assert.equal(fs.readFileSync(marker, "utf8"), "unrelated");
	assert.equal(fs.existsSync(child), false);
});

test("physicalPath rejects reserved intent components even through aliases or when missing", (t) => {
	const dir = fixture(t), markerName = `.generator-mkdir-${createHash("sha256").update("new").digest("hex")}`;
	const marker = path.join(dir, markerName), alias = path.join(dir, "alias");
	fs.symlinkSync(markerName, alias);
	fs.symlinkSync("alias", path.join(dir, "chain"));
	fs.symlinkSync(dir, path.join(dir, "parent-alias"));
	for (const file of [marker, path.join(marker, "file"), alias, path.join(dir, "chain"), path.join(dir, "parent-alias", markerName)]) {
		assert.throws(() => physicalPath(file), /reserved directory creation intent name/, file);
	}
	fs.writeFileSync(marker, "existing");
	assert.throws(() => physicalPath(alias), /reserved directory creation intent name/);
	assert.throws(() => mkdirDurably(path.join(dir, markerName, "child")), /reserved directory creation intent name/);
	assert.equal(fs.readFileSync(marker, "utf8"), "existing");
	assert.equal(physicalPath(path.join(dir, ".generator-mkdir-not-a-hash")), path.join(dir, ".generator-mkdir-not-a-hash"));
});

test("reserved mkdir intent names reject uppercase and mixed-case paths and aliases", (t) => {
	const dir = fixture(t), markerName = `.generator-mkdir-${"ab".repeat(32)}`;
	const marker = path.join(dir, markerName);
	fs.writeFileSync(marker, "existing");
	const variants = [markerName.toUpperCase(), `.GeNeRaToR-MkDiR-${"aB".repeat(32)}`];
	for (const [index, name] of variants.entries()) {
		const alias = path.join(dir, `alias-${index}`);
		fs.symlinkSync(name, alias);
		fs.symlinkSync(path.basename(alias), path.join(dir, `chain-${index}`));
		for (const file of [path.join(dir, name), path.join(dir, name, "file"), alias, path.join(dir, `chain-${index}`)]) {
			assert.throws(() => physicalPath(file), /reserved directory creation intent name/, file);
		}
		const child = path.join(dir, `missing-${index}`, name, "child");
		assert.throws(() => mkdirDurably(child), /reserved directory creation intent name/, child);
		assert.equal(fs.existsSync(path.join(dir, `missing-${index}`)), false);
	}
	assert.equal(fs.readFileSync(marker, "utf8"), "existing");
	for (const name of [`.GENERATOR-MKDIR-${"A".repeat(63)}`, `.GENERATOR-MKDIR-${"G".repeat(64)}`]) {
		assert.equal(physicalPath(path.join(dir, name)), path.join(dir, name));
	}
});

test("holds both settings locks and follows file links, cleaning up on error", async (t) => {
	const dir = fixture(t), settings = path.join(dir, "settings.json"), target = path.join(dir, "target.json");
	fs.writeFileSync(target, "{}");
	fs.symlinkSync("target.json", settings);
	assert.equal(physicalPath(settings), target);
	await assert.rejects(withOutputLocks([settings], settings, (owned) => {
		assert.equal(fs.existsSync(`${settings}.lock`), true);
		assert.equal(fs.existsSync(`${target}.write-lock/owner.json`), true);
		owned();
		throw new Error("injected failure");
	}), /injected failure/);
	assert.equal(fs.existsSync(`${settings}.lock`), false);
	assert.equal(fs.existsSync(`${target}.write-lock`), false);
});

test("stale proper-lockfile lock is reclaimed and live lease is respected", async (t) => {
	const dir = fixture(t), file = path.join(dir, "settings.json"), lock = `${file}.lock`;
	fs.mkdirSync(lock);
	const old = new Date(Date.now() - 15_000);
	fs.utimesSync(lock, old, old);
	await withOutputLocks([file], file, () => assert.equal(fs.existsSync(lock), true));
	assert.equal(fs.existsSync(lock), false);
});

test("separate processes serialize a shared output lease", async (t) => {
	const dir = fixture(t), file = path.join(dir, "out.json");
	const moduleUrl = new URL("./settings-lock.ts", import.meta.url).href;
	const program = `import {withOutputLocks} from ${JSON.stringify(moduleUrl)}; import fs from 'node:fs'; await withOutputLocks([process.argv[1]], undefined, async () => { console.log('locked'); await new Promise(r=>setTimeout(r,350)); fs.writeFileSync(process.argv[1], 'first'); });`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", program, file], { stdio: ["ignore", "pipe", "pipe"] });
	const exited = once(child, "exit");
	await once(child.stdout, "data");
	await withOutputLocks([file], undefined, () => {
		assert.equal(fs.readFileSync(file, "utf8"), "first");
		fs.writeFileSync(file, "second");
	});
	const [exit] = await exited;
	assert.equal(exit, 0);
	assert.equal(fs.readFileSync(file, "utf8"), "second");
});

test("compromised locks fail closed and do not remove replacement", async (t) => {
	const dir = fixture(t), file = path.join(dir, "settings.json"), lock = `${file}.lock`;
	await assert.rejects(withOutputLocks([file], file, (owned) => {
		fs.rmdirSync(lock);
		fs.mkdirSync(lock);
		owned();
	}), /Lock compromised/);
	assert.equal(fs.existsSync(lock), true);
});

test("proper lock remains fresh beyond stale threshold and excludes another process", { timeout: 20_000 }, async (t) => {
	const dir = fixture(t), file = path.join(dir, "settings.json"), lock = `${file}.lock`;
	await withOutputLocks([file], file, async (owned) => {
		const before = fs.statSync(lock).mtimeMs;
		await new Promise((resolve) => setTimeout(resolve, 10_500));
		owned();
		assert.ok(fs.statSync(lock).mtimeMs > before);
		const child = spawn(process.execPath, ["-e", "try { require('fs').mkdirSync(process.argv[1]); process.exit(1); } catch (e) { process.exit(e.code === 'EEXIST' ? 0 : 2); }", lock]);
		const [exit] = await once(child, "exit");
		assert.equal(exit, 0);
	});
});

test("other processes holding either settings protocol finish before replacement", async (t) => {
	for (const protocol of ["proper", "lease"]) {
		const dir = fixture(t), file = path.join(dir, "settings.json"), lock = `${file}${protocol === "proper" ? ".lock" : ".write-lock"}`;
		fs.writeFileSync(file, "original");
		const script = `const fs=require('fs'), os=require('os'), path=require('path'); const lock=process.argv[1], file=process.argv[2]; fs.mkdirSync(lock); if(process.argv[3]==='lease') fs.writeFileSync(path.join(lock,'owner.json'), JSON.stringify({token:'other-process', pid:process.pid, hostname:os.hostname()})); console.log('locked'); setTimeout(()=>{fs.writeFileSync(file,'external'); fs.rmSync(lock,{recursive:true});}, 300);`;
		const child = spawn(process.execPath, ["-e", script, lock, file, protocol], { stdio: ["ignore", "pipe", "pipe"] });
		const exit = once(child, "exit");
		await once(child.stdout, "data");
		await withOutputLocks([file], file, () => {
			assert.equal(fs.readFileSync(file, "utf8"), "external");
			fs.writeFileSync(file, "generator");
			assert.equal(fs.existsSync(`${file}.lock`), true);
			assert.equal(fs.existsSync(`${file}.write-lock`), true);
		});
		assert.equal((await exit)[0], 0);
		assert.equal(fs.readFileSync(file, "utf8"), "generator");
	}
});

test("dead local lease is fenced and a compromised lease is not cleaned up", async (t) => {
	const dir = fixture(t), file = path.join(dir, "settings.json"), lock = `${file}.write-lock`;
	fs.mkdirSync(lock);
	fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ token: "dead-owner", pid: 2147483647, hostname: os.hostname() }));
	await withOutputLocks([file], file, () => assert.equal(fs.existsSync(`${lock}.retired-dead-owner/owner.json`), true));
	assert.equal(fs.existsSync(lock), false);
	await assert.rejects(withOutputLocks([file], file, (owned) => {
		fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ token: "replacement", pid: process.pid, hostname: os.hostname() }));
		owned();
	}), /Lock compromised/);
	assert.equal(fs.existsSync(`${lock}/owner.json`), true);
});

test("replacement is visible to an independent reader before lock release", async (t) => {
	const { spawnSync } = await import("node:child_process");
	const dir = fixture(t), file = path.join(dir, "settings.json");
	fs.writeFileSync(file, "old");
	await withOutputLocks([file], file, () => {
		const tmp = path.join(dir, "new");
		fs.writeFileSync(tmp, "new");
		fs.renameSync(tmp, file);
		const observer = spawnSync(process.execPath, ["-e", "const fs=require('fs'); process.exit(fs.existsSync(process.argv[1]+'.lock') && fs.existsSync(process.argv[1]+'.write-lock') && fs.readFileSync(process.argv[1],'utf8')==='new' ? 0 : 1)", file]);
		assert.equal(observer.status, 0);
	});
});

test("dangling settings link resolves directory links before .. and holds the installed target lease", async (t) => {
	const dir = fixture(t), outside = path.join(dir, "outside"), inner = path.join(outside, "inner");
	fs.mkdirSync(inner, { recursive: true });
	fs.symlinkSync(inner, path.join(dir, "jump"));
	const settings = path.join(dir, "settings.json"), target = path.join(outside, "target.json");
	fs.symlinkSync("jump/../target.json", settings);
	assert.equal(physicalPath(settings), target);
	await withOutputLocks([settings], settings, () => {
		assert.equal(fs.existsSync(`${target}.write-lock/owner.json`), true);
		assert.equal(fs.existsSync(`${path.join(dir, "target.json")}.write-lock`), false);
	});
});
