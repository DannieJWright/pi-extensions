import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { CaptureServer, frameworkLockMessage, redactUrl, type Identity, type OwnedServer, type Probe, type ServerRuntime } from "./server.ts";
import { HostServerRuntime } from "./server-runtime.ts";
import { createServer as createHttpServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { TrustedCommand } from "./trust.ts";

class FakeRuntime implements ServerRuntime {
	time = 1000; port = 4321; records = new Map<string, OwnedServer>();
	launches: Array<{ command: TrustedCommand; options: { cwd: string; env: Record<string, string>; detached: boolean } }> = [];
	stops: Identity[] = []; verified = true; log = "server log\n"; probes: Probe[] = [];
	identity: Identity = { pid: 42, start: "one", boot: "boot" }; detachedProof = false; launchAvailable = true;
	now() { return this.time; }
	assertLaunchSupported() { if (!this.launchAvailable) throw new Error("Automatic server launch is unavailable"); }
	async sleep(ms: number) { this.time += ms; }
	async pickPort() { return this.port; }
	async probe(_url: string, identity?: Identity) { return this.probes.shift() ?? (identity ? { listener: true, healthy: true, owned: true } : { listener: false, healthy: false }); }
	async launch(command: TrustedCommand, options: { cwd: string; env: Record<string, string>; detached: boolean }) {
		if (options.detached && !this.detachedProof) throw new Error("Detached launcher lacks a verified identity-scoped stop mechanism");
		this.launches.push({ command, options }); return { identity: { ...this.identity }, logPath: "/log" };
	}
	async verify(identity: Identity) { return this.verified && identity.pid === this.identity.pid && identity.start === this.identity.start && identity.boot === this.identity.boot; }
	async stop(identity: Identity) { if (!await this.verify(identity)) throw new Error("unverified"); this.stops.push(identity); }
	async logs(_path: string, _tail: number) { return this.log; }
	async load(key: string) { return this.records.get(key) ?? null; }
	async save(record: OwnedServer) { if (this.records.has(record.key)) throw new Error("exists"); this.records.set(record.key, record); }
	async remove(key: string) { this.records.delete(key); }
	lockAttempts: string[] = []; lockHeld = false;
	async locked<T>(key: string, fn: () => Promise<T>) {
		this.lockAttempts.push(key);
		if (this.lockHeld) throw new Error(`Server record is locked: ${key}; inspect the stale lock before removing it`);
		return fn();
	}
}
const project = "/project", spec = "spec.yaml";
// The key CaptureServer builds internally for these arguments, so a test can name the same record.
const derivedKey = () => JSON.stringify([resolve(project), resolve(project, spec)]);
const config = () => ({ start: "just serve --port {port}", port: "auto", cwd: "web", env: { PORT: "{port}", PATH: "/trusted/bin" }, ready: { path: "/health", timeout: 1 } });

test("launch substitutes port, passes cwd and environment, persists identity and reuses a healthy server", async () => {
	const runtime = new FakeRuntime(); const manager = new CaptureServer(runtime, []);
	const first = await manager.start(project, spec, config());
	assert.equal(first.url, "http://127.0.0.1:4321"); assert.equal(first.logPath, "/log");
	assert.deepEqual(runtime.launches[0].command.argv, ["just", "serve", "--port", "4321"]);
	assert.deepEqual(runtime.launches[0].options, { cwd: "/project/web", env: { PORT: "4321", PATH: "/trusted/bin" }, detached: false });
	const next = await new CaptureServer(runtime, []).start(project, spec, config());
	assert.equal(next.url, first.url); assert.equal(runtime.launches.length, 1);
	await assert.rejects(manager.start(project, spec, { ...config(), start: "just different" }), /configuration changed/);
	assert.equal((await manager.status(project, spec, config())).alive, true);
	assert.equal(await manager.logs(project, spec, config()), runtime.log);
	assert.equal(await manager.stop(project, spec, config()), true);
	assert.deepEqual(runtime.stops, [runtime.identity]); assert.equal(runtime.records.size, 0);
});

test("URL mode checks health, never stops and reports unavailable owned fields", async () => {
	const runtime = new FakeRuntime(); const manager = new CaptureServer(runtime, []); const server = { url: "http://localhost:3000", ready: { path: "/health" } };
	runtime.probes.push({ listener: true, healthy: true });
	assert.deepEqual(await manager.start(project, spec, server), { url: server.url, alive: true, uptime: null, logs: null });
	runtime.probes.push({ listener: false, healthy: false });
	assert.equal((await manager.status(project, spec, server)).alive, false);
	assert.equal(await manager.logs(project, spec, server), null);
	assert.equal(await manager.stop(project, spec, server), false); assert.equal(runtime.stops.length, 0);
	runtime.probes.push({ listener: false, healthy: false });
	await assert.rejects(manager.start(project, spec, server), /unavailable/);
});

// An external URL has no ownership record, so its health check does not take the ownership lock. Managed
// record operations keep using it and fail closed while another run holds it.
test("URL mode takes no ownership lock while managed record work still does", async () => {
	const runtime = new FakeRuntime(), manager = new CaptureServer(runtime, []), key = derivedKey();
	runtime.lockHeld = true; // a stale lock left by another run; nothing here removes it
	runtime.probes.push({ listener: true, healthy: true }, { listener: true, healthy: true });
	assert.deepEqual(await manager.start(project, spec, { url: "http://external.example:3000" }), { url: "http://external.example:3000", alive: true, uptime: null, logs: null });
	assert.equal((await manager.status(project, spec, { url: "http://external.example:3000" })).alive, true);
	assert.equal(await manager.logs(project, spec, { url: "http://external.example:3000" }), null);
	assert.equal(await manager.stop(project, spec, { url: "http://external.example:3000" }), false);
	assert.deepEqual(runtime.lockAttempts, []); assert.equal(runtime.records.size, 0); assert.equal(runtime.stops.length, 0);
	await assert.rejects(manager.start(project, spec, config()), /Server record is locked/);
	assert.deepEqual(runtime.lockAttempts, [key]); assert.equal(runtime.launches.length, 0);
	runtime.lockHeld = false; // this fixture releases only the contention it created itself
	await manager.start(project, spec, config());
	assert.deepEqual(runtime.lockAttempts, [key, key]); assert.equal(runtime.records.size, 1);
	await manager.stop(project, spec, config());
	assert.deepEqual(runtime.lockAttempts, [key, key, key]); assert.equal(runtime.records.size, 0);
	assert.deepEqual(runtime.stops, [runtime.identity]);
});

test("foreign listeners, bind races and wrong ports fail closed without stopping foreign processes", async () => {
	const runtime = new FakeRuntime(); const manager = new CaptureServer(runtime, []);
	runtime.probes.push({ listener: true, healthy: true, pid: 123 });
	await assert.rejects(manager.start(project, spec, { ...config(), port: 4321 }), /Foreign listener: PID 123/);
	assert.equal(runtime.launches.length, 0);
	runtime.probes.push({ listener: false, healthy: false }, { listener: true, healthy: true, owned: false });
	await assert.rejects(manager.start(project, spec, config()), /bind race: PID unknown/);
	assert.equal(runtime.stops.length, 1);
	runtime.probes.push({ listener: false, healthy: false });
	for (let i = 0; i < 11; i++) runtime.probes.push({ listener: false, healthy: false, owned: false });
	await assert.rejects(manager.start(project, spec, config()), /timed out after 1 seconds/);
	assert.equal(runtime.stops.length, 2);
});

test("cancellation during startup cleans only the newly verified server", async () => {
	const runtime = new FakeRuntime(), controller = new AbortController();
	const probe = runtime.probe.bind(runtime);
	runtime.probe = async (url, identity) => {
		const result = await probe(url, identity);
		if (identity) controller.abort();
		return result;
	};
	await assert.rejects(new CaptureServer(runtime, []).start(project, spec, config(), undefined, controller.signal), /cancelled/);
	assert.equal(runtime.stops.length, 1); assert.equal(runtime.records.size, 0);
});

test("startup retries on an injected clock and timeout includes logs", async () => {
	const runtime = new FakeRuntime(); const manager = new CaptureServer(runtime, []);
	runtime.probes.push({ listener: false, healthy: false }, { listener: false, healthy: false }, { listener: true, healthy: true, owned: true });
	await manager.start(project, spec, config()); assert.equal(runtime.time, 1100);
});

test("frameworkLockMessage ignores benign lockfile logs and recognizes conflict details", () => {
	for (const log of ["Using lockfile /project/package-lock.json", "lockfile found\nServer ready", "Using LOCKFILE /project/.next/lock"]) {
		assert.equal(frameworkLockMessage(log), null);
	}
	assert.equal(frameworkLockMessage("Another next dev server is already running"), "Framework lock: PID unknown; URL unknown. No lock was removed.");
	assert.equal(frameworkLockMessage("Unable to acquire lock at /project/.next/dev/lock\nPID: 87 http://localhost:3000"), "Framework lock: PID 87; URL http://localhost:3000. No lock was removed.");
});

test("startup allows a healthy server that logs a lockfile", async () => {
	const runtime = new FakeRuntime(); runtime.log = "Using lockfile /project/package-lock.json\nServer ready";
	const result = await new CaptureServer(runtime, []).start(project, spec, config());
	assert.equal(result.alive, true); assert.equal(result.logs, runtime.log);
	assert.equal(runtime.launches.length, 1); assert.equal(runtime.stops.length, 0); assert.equal(runtime.records.size, 1);
});

test("framework lock reports known or unknown details and cleans only verified launch", async () => {
	for (const [log, expected] of [["Another next dev server is already running", /PID unknown; URL unknown\. No lock was removed/], ["Unable to acquire lock at /project/.next/dev/lock\nPID: 87 http://localhost:3000", /PID 87; URL http:\/\/localhost:3000\. No lock was removed/]] as const) {
		const runtime = new FakeRuntime(); runtime.log = log;
		await assert.rejects(new CaptureServer(runtime, []).start(project, spec, config()), expected);
		assert.deepEqual(runtime.stops, [runtime.identity]); assert.equal(runtime.records.size, 0);
	}
});

test("untrusted start and stop fail before launch; detached needs scoped identity", async () => {
	const runtime = new FakeRuntime(); const manager = new CaptureServer(runtime, []);
	await assert.rejects(manager.start(project, spec, { ...config(), start: "just run; echo bad" }), /Untrusted/);
	await assert.rejects(manager.start(project, spec, { ...config(), stop: "node stop --port {port}" }), /node stop --port 4321/);
	await assert.rejects(manager.start(project, spec, { ...config(), detached: true, stop: "just stop" }), /identity-scoped/);
	assert.equal(runtime.launches.length, 0);
});

test("unhealthy owned server restarts once and reports its old log", async () => {
	const runtime = new FakeRuntime(); const manager = new CaptureServer(runtime, []);
	await manager.start(project, spec, config()); runtime.log = "old error";
	runtime.probes.push({ listener: true, healthy: false, owned: true }, { listener: false, healthy: false }, { listener: true, healthy: true, owned: true });
	const result = await manager.start(project, spec, config());
	assert.equal(result.restarted, true); assert.equal(result.logs, "old error"); assert.equal(runtime.launches.length, 2); assert.equal(runtime.stops.length, 1);
});

test("unavailable launch containment preserves an unhealthy existing record instead of stopping it", async () => {
	const runtime = new FakeRuntime(); const manager = new CaptureServer(runtime, []);
	await manager.start(project, spec, config());
	runtime.launchAvailable = false;
	runtime.probes.push({ listener: true, healthy: false, owned: true });
	await assert.rejects(manager.start(project, spec, config()), /Automatic server launch is unavailable/);
	assert.equal(runtime.stops.length, 0); assert.equal(runtime.records.size, 1);
});

test("reused PID and lost identity do not authorize stop or cleanup", async () => {
	const runtime = new FakeRuntime(); const manager = new CaptureServer(runtime, []);
	await manager.start(project, spec, config()); runtime.identity.start = "reused";
	await assert.rejects(manager.stop(project, spec, config()), /ownership cannot be verified/);
	assert.equal(runtime.stops.length, 0); assert.equal((await manager.status(project, spec, config())).alive, false);
	// An unverifiable record is retained, even if a listener exists at its old URL.
	runtime.probes.push({ listener: true, healthy: true, pid: 42 });
	await assert.rejects(manager.start(project, spec, config()), /Ownership cannot be verified/);
	assert.equal(runtime.stops.length, 0); assert.equal(runtime.records.size, 1);
});

test("lost identity during failed startup retains its record and refuses cleanup", async () => {
	const runtime = new FakeRuntime(); const manager = new CaptureServer(runtime, []);
	const probe = runtime.probe.bind(runtime);
	runtime.probe = async (url, identity) => {
		if (identity) { runtime.verified = false; return { listener: false, healthy: false }; }
		return probe(url, identity);
	};
	await assert.rejects(manager.start(project, spec, config()), /cleanup refused or failed/);
	assert.equal(runtime.stops.length, 0); assert.equal(runtime.records.size, 1);
});

test("detached adapter can stop only the identity it verified", async () => {
	const runtime = new FakeRuntime(); runtime.detachedProof = true;
	const manager = new CaptureServer(runtime, []), server = { ...config(), detached: true, stop: "just stop" };
	await manager.start(project, spec, server);
	await manager.stop(project, spec, server);
	assert.deepEqual(runtime.stops, [runtime.identity]);
});

test("host ownership records persist across runtime instances and missing identity cannot stop", async () => {
	const directory = await mkdtemp(join(tmpdir(), "capture-record-"));
	try {
		const first = new HostServerRuntime(directory), second = new HostServerRuntime(directory);
		const record: OwnedServer = { version: 1, configHash: "a".repeat(64), key: "worktree\\nspec", identity: { pid: 99999999, start: "1", boot: "boot" }, url: "http://127.0.0.1:1234", port: 1234, logPath: join(directory, "log"), startedAt: 1, keep: true, detached: false };
		await first.locked(record.key, () => first.save(record));
		assert.deepEqual(await second.load(record.key), record);
		await assert.rejects(second.stop(record.identity, false), /ownership cannot be verified/);
		await assert.rejects(first.locked(record.key, () => second.locked(record.key, async () => {})), /locked/);
		await second.locked(record.key, () => second.remove(record.key));
		assert.equal(await first.load(record.key), null);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("URL-mode stop preserves owned records for verified shutdown, including keep and unverified records", async () => {
	const runtime = new FakeRuntime(); const manager = new CaptureServer(runtime, []);
	const url = { url: "http://foreign.example:3000" };
	await manager.start(project, "normal.yaml", config());
	await manager.start(project, "kept.yaml", { ...config(), keep: true });
	assert.equal(await manager.stop(project, "normal.yaml", url), false);
	assert.equal(await manager.stop(project, "kept.yaml", url), false);
	assert.equal(runtime.stops.length, 0); assert.equal(runtime.records.size, 2);
	await manager.shutdown(project, [{ path: "normal.yaml", server: url }, { path: "kept.yaml", server: url }]);
	assert.deepEqual(runtime.stops, [runtime.identity]); assert.equal(runtime.records.size, 1);
	await manager.start(project, "unverified.yaml", config());
	runtime.verified = false;
	assert.equal(await manager.stop(project, "unverified.yaml", url), false);
	await assert.rejects(manager.shutdown(project, [{ path: "unverified.yaml", server: url }]), /ownership cannot be verified/);
	assert.equal(runtime.stops.length, 1); assert.equal(runtime.records.size, 2);
});

test("shutdown respects keep and worktree isolation", async () => {
	const runtime = new FakeRuntime(); const manager = new CaptureServer(runtime, []);
	await manager.start(project, "one.yaml", config());
	await manager.start(project, "two.yaml", { ...config(), keep: true });
	await manager.shutdown("/other", [{ path: "one.yaml", server: config() }]); assert.equal(runtime.stops.length, 0);
	await manager.shutdown(project, [{ path: "one.yaml", server: config() }, { path: "two.yaml", server: config() }]);
	assert.equal(runtime.stops.length, 1); assert.equal(runtime.records.size, 1);
});

// Real loopback listeners for URL-mode probes. The recorded request authority shows the URL the health
// request actually used, so a bracketed IPv6 URL must stay bracketed there even though the socket host
// is normalised.
function observedListener(requests: Array<{ authority: string; path: string }>): Server {
	return createHttpServer((request, response) => { requests.push({ authority: request.headers.host ?? "", path: request.url ?? "" }); response.writeHead(200); response.end("ok"); });
}
async function boundPort(listener: Server, host?: string): Promise<number> {
	return new Promise((resolvePort, rejectPort) => {
		listener.once("error", rejectPort);
		const listening = () => {
			const address = listener.address();
			if (!address || typeof address === "string") return rejectPort(new Error(`Could not bind ${host ?? "any address"}`));
			resolvePort(address.port);
		};
		if (host === undefined) listener.listen(0, listening); else listener.listen(0, host, listening);
	});
}
async function closeListener(listener: Server): Promise<void> { await new Promise(resolveClose => listener.close(() => resolveClose())); }

function skipWhenUnavailable(t: TestContext, error: unknown, label: string): void {
	t.skip(`${label} is unavailable in this environment: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
}

const urlConfig = (url: string) => ({ url, ready: { path: "/health", timeout: 3 } });

test("bracketed IPv6 URL mode reaches the real listener through the bare socket address and keeps the configured URL for the health request", { timeout: 20000 }, async t => {
	const dir = await mkdtemp(join(tmpdir(), "capture-ipv6-")), requests: Array<{ authority: string; path: string }> = [];
	const listener = observedListener(requests);
	try {
		let port: number | undefined;
		try { port = await boundPort(listener, "::1"); }
		catch (error) { skipWhenUnavailable(t, error, "IPv6 loopback"); return; }
		const manager = new CaptureServer(new HostServerRuntime(join(dir, "records")), []), config = urlConfig(`http://[::1]:${port}`);
		assert.equal((await manager.start(project, spec, config)).alive, true);
		assert.equal((await manager.status(project, spec, config)).alive, true);
		// The socket host was normalised to ::1 while the health request still carried the bracketed authority.
		assert.ok(requests.length > 0 && requests.every(r => r.authority === `[::1]:${port}` && r.path === "/health"), `observed requests: ${JSON.stringify(requests)}`);
		assert.equal(await manager.stop(project, spec, config), false); // an external server is never adopted or stopped
	} finally { await closeListener(listener); await rm(dir, { recursive: true, force: true }); }
});

test("URL mode still reaches an IPv4 literal and a DNS hostname against a real listener", { timeout: 20000 }, async t => {
	const dir = await mkdtemp(join(tmpdir(), "capture-ipv4-")), requests: Array<{ authority: string; path: string }> = [];
	const listener = observedListener(requests);
	try {
		// Bound to every address so a name that resolves to either family still reaches it.
		let port: number | undefined;
		try { port = await boundPort(listener); }
		catch (error) { skipWhenUnavailable(t, error, "loopback binding"); return; }
		const manager = new CaptureServer(new HostServerRuntime(join(dir, "records")), []);
		for (const host of ["127.0.0.1", "localhost"]) {
			assert.equal((await manager.status(project, `${host}.yaml`, urlConfig(`http://${host}:${port}`))).alive, true);
		}
		assert.deepEqual([...new Set(requests.map(r => r.authority))].sort(), [`127.0.0.1:${port}`, `localhost:${port}`]);
		assert.ok(requests.every(r => r.path === "/health"), `observed paths: ${JSON.stringify(requests)}`);
	} finally { await closeListener(listener); await rm(dir, { recursive: true, force: true }); }
});

test("unavailable endpoints stay unhealthy for both address forms", { timeout: 20000 }, async t => {
	const dir = await mkdtemp(join(tmpdir(), "capture-unreachable-"));
	const runtime = new HostServerRuntime(join(dir, "records")), manager = new CaptureServer(runtime, []);
	try {
		// A port selected by binding and closing has nothing listening on it.
		const port = await runtime.pickPort();
		for (const url of [`http://127.0.0.1:${port}`, `http://[::1]:${port}`]) {
			assert.equal((await manager.status(project, url, urlConfig(url))).alive, false);
			await assert.rejects(manager.start(project, url, urlConfig(url)), /External server is unavailable/);
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});

// HostServerRuntime derives the record name from the key CaptureServer builds for these arguments.
const recordName = (key: string): string => createHash("sha256").update(key).digest("hex");

test("a stale record lock does not block a healthy external URL and is never removed", { timeout: 20000 }, async t => {
	const dir = await mkdtemp(join(tmpdir(), "capture-stale-record-lock-")), records = join(dir, "records");
	const requests: Array<{ authority: string; path: string }> = [], listener = observedListener(requests);
	try {
		let port: number | undefined;
		try { port = await boundPort(listener, "127.0.0.1"); }
		catch (error) { skipWhenUnavailable(t, error, "loopback binding"); return; }
		await mkdir(records, { mode: 0o700 });
		const runtime = new HostServerRuntime(records), manager = new CaptureServer(runtime, []), key = derivedKey();
		const lockPath = join(records, `${recordName(key)}.lock`), content = "stale lock left by a dead process";
		await writeFile(lockPath, content); // created here, so this run has no live owner of it
		assert.equal((await manager.start(project, spec, urlConfig(`http://127.0.0.1:${port}`))).alive, true);
		assert.ok(requests.some(r => r.path === "/health"), `observed paths: ${JSON.stringify(requests)}`);
		assert.deepEqual(await readdir(records), [`${recordName(key)}.lock`]); // no record was written for the external URL
		// Managed record work still goes through the same ownership lock and fails closed on it.
		await assert.rejects(manager.start(project, spec, config()), /Server record is locked/);
		assert.equal(await readFile(lockPath, "utf8"), content);
	} finally { await closeListener(listener); await rm(dir, { recursive: true, force: true }); }
});

test("an unwritable record directory does not block a healthy external URL while managed record work still fails safely", { timeout: 20000 }, async t => {
	const dir = await mkdtemp(join(tmpdir(), "capture-unwritable-records-")), records = join(dir, "records");
	const requests: Array<{ authority: string; path: string }> = [], listener = observedListener(requests);
	try {
		let port: number | undefined;
		try { port = await boundPort(listener, "127.0.0.1"); }
		catch (error) { skipWhenUnavailable(t, error, "loopback binding"); return; }
		// Private and readable, but nothing can be recorded or locked in it.
		await mkdir(records, { mode: 0o700 }); await chmod(records, 0o500);
		const runtime = new HostServerRuntime(records), manager = new CaptureServer(runtime, []), key = derivedKey();
		assert.equal((await manager.start(project, spec, urlConfig(`http://127.0.0.1:${port}`))).alive, true);
		assert.deepEqual(await readdir(records), []); // an external URL writes no record and takes no lock
		await assert.rejects(manager.stop(project, spec, config()), /EACCES/);
		assert.deepEqual(await readdir(records), []);
	} finally { await closeListener(listener); await rm(dir, { recursive: true, force: true }); }
});

test("external server errors do not echo URL credentials", { timeout: 20000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "capture-redact-"));
	const runtime = new HostServerRuntime(join(dir, "records")), manager = new CaptureServer(runtime, []);
	try {
		const port = await runtime.pickPort(), url = `http://user:secret@127.0.0.1:${port}`;
		await assert.rejects(manager.start(project, url, { url, ready: { path: "/health", timeout: 1 } }), (error: Error) => /External server is unavailable/.test(error.message) && !error.message.includes("secret") && !error.message.includes("user:"));
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("health probe has an overall deadline even when response headers trickle", { timeout: 10000 }, async () => {
	const { createServer: createTcpServer } = await import("node:net");
	const sockets = new Set<import("node:net").Socket>();
	const listener = createTcpServer(socket => {
		sockets.add(socket); socket.on("error", () => {});
		socket.write("HTTP/1.1 200 OK\r\n");
		const timer = setInterval(() => socket.write("X-Pad: 1\r\n"), 200);
		socket.on("close", () => clearInterval(timer));
	});
	await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
	const port = (listener.address() as { port: number }).port;
	try {
		const start = Date.now();
		const probe = await new HostServerRuntime(join(tmpdir(), "unused-records")).probe(`http://127.0.0.1:${port}/`);
		assert.equal(probe.healthy, false);
		assert.ok(Date.now() - start < 3000);
	} finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => listener.close(() => resolve())); }
});

test("redactUrl removes everything up to the last @ of the authority", () => {
	assert.equal(redactUrl("http://user:pass@host:3000/p"), "http://host:3000/p");
	assert.equal(redactUrl("http://user:p@ss@host/p"), "http://host/p");
	assert.equal(redactUrl("http://user:p%40ss@[::1]:3000/a@b"), "http://[::1]:3000/a@b");
	assert.equal(redactUrl("http://user@"), "http://");
	assert.equal(redactUrl("http://host/path?x=a@b#c@d"), "http://host/path?x=a@b#c@d");
	assert.equal(redactUrl("not a url"), "not a url");
});

test("external start and status return a redacted url", async () => {
	const runtime = new FakeRuntime(); const manager = new CaptureServer(runtime, []); const server = { url: "http://user:p@ss@localhost:3000" };
	runtime.probes.push({ listener: true, healthy: true });
	assert.equal((await manager.start(project, spec, server)).url, "http://localhost:3000");
	runtime.probes.push({ listener: true, healthy: true });
	assert.equal((await manager.status(project, spec, server)).url, "http://localhost:3000");
});
