import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { controlSupervisor } from "./server-control.ts";
import { controlSession, proof, signalOwnGroup } from "./server-supervisor.mjs";
import { CaptureServer, type Identity, type OwnedServer, type Probe } from "./server.ts";
import { HostServerRuntime } from "./server-runtime.ts";
import { canonicalJson } from "./spec.ts";
import { trustCommand } from "./trust.ts";

const secret = "a".repeat(64);
const identity: Identity = { pid: 123, start: "1", boot: "boot", control: { address: "b".repeat(32), secret } };

test("supervisor control authenticates both peers and rejects replay and foreign requests", async () => {
	let stops = 0;
	const session = controlSession(secret, async () => { stops++; });
	const nonce = "c".repeat(64);
	assert.deepEqual(await session({ action: "hello", nonce }), { proof: proof(secret, `hello:${nonce}`) });
	await assert.rejects(session({ action: "stop", proof: proof("wrong", `stop:${nonce}`) }), /Unverified/);
	const result = await session({ action: "stop", proof: proof(secret, `stop:${nonce}`) });
	assert.equal(result.error, ""); assert.equal(stops, 1);
	await assert.rejects(session({ action: "stop", proof: proof(secret, `stop:${nonce}`) }), /Unverified/);
});

test("replacement control endpoint cannot authorize a stop at the signal boundary", async () => {
	let ownedSignals = 0, foreignSignals = 0, requests = 0, closed = false;
	const original = controlSession(secret, async () => { ownedSignals++; });
	await controlSupervisor(identity, "verify", async () => ({ request: original, close() {} }));
	const foreign = controlSession("d".repeat(64), async () => { foreignSignals++; });
	await assert.rejects(controlSupervisor(identity, "stop", async () => ({
		async request(message) { requests++; return foreign(message); },
		close() { closed = true; },
	})), /Unverified supervisor response/);
	assert.equal(requests, 1); assert.equal(ownedSignals, 0); assert.equal(foreignSignals, 0); assert.equal(closed, true);
});

test("authenticated control sends stop only to the same challenged supervisor", async () => {
	let stops = 0;
	const session = controlSession(secret, async () => { stops++; });
	await controlSupervisor(identity, "stop", async () => ({ request: session, close() {} }));
	assert.equal(stops, 1);
});

test("the supervisor signals its own pinned group, never the recorded or replacement ID", async () => {
	const calls: Array<[number, string]> = [];
	let recorded = 123;
	await signalOwnGroup({ pid: 777 }, async () => {
		recorded = 999;
		return { group: 777, session: 777 };
	}, (pid: number, signal: string) => calls.push([pid, signal]));
	assert.equal(recorded, 999); assert.deepEqual(calls, [[-777, "SIGTERM"]]);
	await assert.rejects(signalOwnGroup({ pid: 777 }, async () => ({ group: 999, session: 999 }), () => assert.fail("foreign group signalled")), /not its session/);
});

class ScriptedHost extends HostServerRuntime {
	unhealthy = false;
	async probe(_url: string, owner?: Identity): Promise<Probe> {
		if (!owner) return { listener: false, healthy: false };
		return { listener: true, healthy: !this.unhealthy, owned: true };
	}
}

test("host refuses an implicitly detaching launcher before running it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "capture-refusal-"));
	const launcher = join(dir, "launcher.cjs"), marker = join(dir, "ran"), server = join(dir, "server.cjs");
	try {
		await writeFile(server, "require('node:http').createServer((req,res)=>res.end('ok')).listen(4321, '127.0.0.1');\n");
		await writeFile(launcher, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');\nrequire('node:child_process').spawn(process.execPath, [${JSON.stringify(server)}], {detached:true, stdio:'ignore'}).unref();\n`);
		const command = `${process.execPath} ${launcher}`, config = { start: command, port: 4321, ready: { timeout: 1 } };
		const runtime = new ScriptedHost(join(dir, "records"));
		const manager = new CaptureServer(runtime, [command]);
		await assert.rejects(manager.start(dir, "spec.yaml", config), /Automatic server launch is unavailable.*server.url/);
		await assert.rejects(runtime.launch(trustCommand(command, [command]), { cwd: dir, env: {}, detached: false }), /Automatic server launch is unavailable/);
		await assert.rejects(readFile(marker), { code: "ENOENT" });
		assert.equal(await runtime.load(JSON.stringify([dir, join(dir, "spec.yaml")])), null);
		assert.deepEqual(await readdir(join(dir, "records")), []);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("host URL mode leaves a user-run server running", { skip: !["linux", "darwin"].includes(process.platform) || process.env.UI_CAPTURE_SKIP_HOST_TESTS === "1", timeout: 15000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "capture-external-"));
	const external = createServer((_req, res) => res.end("external"));
	try {
		await new Promise<void>((resolve, reject) => { external.once("error", reject); external.listen(0, "127.0.0.1", resolve); });
		const address = external.address(); assert.ok(address && typeof address !== "string");
		const config = { url: `http://127.0.0.1:${address.port}` };
		const manager = new CaptureServer(new HostServerRuntime(join(dir, "records")), []);
		assert.equal((await manager.start(dir, "spec.yaml", config)).alive, true);
		assert.equal((await manager.status(dir, "spec.yaml", config)).alive, true);
		assert.equal(await manager.logs(dir, "spec.yaml", config), null);
		await manager.stop(dir, "spec.yaml", config);
		assert.equal(await (await fetch(config.url)).text(), "external");
	} finally {
		await new Promise<void>(resolve => external.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	}
});

test("legacy supervisor records remain controllable but are retained after group cleanup", { skip: process.platform !== "linux" || process.env.UI_CAPTURE_SKIP_HOST_TESTS === "1", timeout: 30000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "capture-legacy-"));
	const records = join(dir, "records"), script = join(dir, "server.cjs"), logPath = join(records, "legacy.log");
	const first = new ScriptedHost(records), second = new ScriptedHost(records);
	let child: ChildProcess | undefined, owner: Identity | undefined;
	try {
		await mkdir(records, { mode: 0o700 });
		// This controlled fixture never forks or listens; it represents a previously launched supervisor.
		await writeFile(script, "console.log('legacy child'); setInterval(() => {}, 1000); setTimeout(() => process.exit(), 15000);\n");
		const log = await open(logPath, "wx", 0o600);
		try {
			child = spawn(process.execPath, [fileURLToPath(new URL("./server-supervisor.mjs", import.meta.url))], { detached: true, stdio: ["ignore", log.fd, log.fd, "ipc"] });
		} finally { await log.close(); }
		child.on("error", () => {});
		const control = { address: randomBytes(16).toString("hex"), secret: randomBytes(32).toString("hex") };
		const command = `${process.execPath} ${script}`, config = { start: command, port: 4321, keep: true, ready: { timeout: 1 } };
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("legacy supervisor startup timed out")), 10000);
			child!.once("error", error => { clearTimeout(timer); reject(error); });
			child!.once("exit", () => { clearTimeout(timer); reject(new Error("legacy supervisor exited during startup")); });
			child!.on("message", (value: { action?: string; error?: string }) => {
				if (value?.action === "ready") { clearTimeout(timer); resolve(); }
				if (value?.action === "error") { clearTimeout(timer); reject(new Error(value.error)); }
			});
			child!.send({ action: "launch", ...control, command: trustCommand(command, [command]), options: { cwd: dir, env: process.env } });
		});
		assert.ok(child.pid);
		const stat = await readFile(`/proc/${child.pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		owner = { pid: child.pid, start: fields[19], boot: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(), control };
		const key = JSON.stringify([dir, join(dir, "spec.yaml")]);
		const record: OwnedServer = { version: 1, key, configHash: createHash("sha256").update(canonicalJson(config)).digest("hex"), identity: owner, url: "http://127.0.0.1:4321", port: 4321, logPath, startedAt: Date.now(), keep: true, detached: false };
		await first.save(record);
		await new Promise<void>((resolve, reject) => child!.send({ action: "release" }, error => error ? reject(error) : resolve()));
		child.disconnect(); child.unref(); child.channel?.unref();
		const manager = new CaptureServer(second, [command]);
		assert.equal((await manager.status(dir, "spec.yaml", config)).alive, true);
		assert.equal((await manager.start(dir, "spec.yaml", config)).alive, true);
		await manager.shutdown(dir, [{ path: "spec.yaml", server: config }]);
		assert.ok(await second.load(key));
		second.unhealthy = true;
		await assert.rejects(manager.start(dir, "spec.yaml", config), /Automatic server launch is unavailable/);
		assert.equal(await first.verify(owner), true);
		await assert.rejects(manager.stop(dir, "spec.yaml", config), /legacy launch containment cannot be verified; ownership record retained/);
		assert.deepEqual(await second.load(key), record);
		const deadline = Date.now() + 3000;
		while (await first.verify(owner) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
		assert.equal(await first.verify(owner), false);
	} finally {
		if (child?.connected) child.disconnect();
		if (owner && await first.verify(owner)) await first.stop(owner, false).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	}
});
