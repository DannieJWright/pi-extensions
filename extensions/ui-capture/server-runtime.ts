import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, readlink, unlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer, createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { controlSupervisor } from "./server-control.ts";
import type { Identity, OwnedServer, Probe, ServerRuntime } from "./server.ts";
import type { TrustedCommand } from "./trust.ts";

// Linux process start ticks plus boot ID distinguish a reused PID from the launcher.
async function processStat(pid: number): Promise<{ state: string; group: number; session: number; start: string } | null> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return { state: fields[0], group: Number(fields[2]), session: Number(fields[3]), start: fields[19] };
	} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") return null; throw error; }
}
async function bootId(): Promise<string> { return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(); }
async function verified(identity: Identity): Promise<boolean> {
	if (process.platform !== "linux" || !Number.isSafeInteger(identity.pid) || identity.pid <= 1) return false;
	const stat = await processStat(identity.pid);
	return !!stat && stat.state !== "Z" && stat.group === identity.pid && stat.session === identity.pid && stat.start === identity.start && await bootId() === identity.boot;
}
async function verifiedOwner(identity: Identity): Promise<boolean> {
	if (!await verified(identity)) return false;
	try { await controlSupervisor(identity, "verify"); return true; } catch { return false; }
}
async function listenerInodes(port: number): Promise<Set<string>> {
	const result = new Set<string>();
	for (const name of ["tcp", "tcp6"]) {
		const text = await readFile(`/proc/net/${name}`, "utf8");
		for (const line of text.split("\n").slice(1)) {
			const fields = line.trim().split(/\s+/);
			if (fields[3] !== "0A") continue;
			const [address, portHex] = fields[1].split(":");
			// Only IPv4 loopback or wildcard sockets can own our 127.0.0.1 endpoint.
			if (name === "tcp" && address !== "0100007F" && address !== "00000000") continue;
			if (name === "tcp6" && address !== "00000000000000000000000000000000") continue;
			if (parseInt(portHex, 16) === port && fields[9]) result.add(fields[9]);
		}
	}
	return result;
}
async function ownedListener(identity: Identity, port: number): Promise<boolean> {
	if (!await verifiedOwner(identity)) return false;
	const inodes = await listenerInodes(port);
	if (!inodes.size) return false;
	const names = await readdir("/proc");
	const owned = new Set<string>();
	for (const name of names) {
		if (!/^\d+$/.test(name)) continue;
		const pid = Number(name), stat = await processStat(pid);
		if (!stat || stat.group !== identity.pid || stat.session !== identity.pid || stat.state === "Z") continue;
		let descriptors: string[];
		try { descriptors = await readdir(`/proc/${pid}/fd`); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
		for (const fd of descriptors) {
			try {
				const target = await readlink(`/proc/${pid}/fd/${fd}`);
				const match = /^socket:\[(\d+)\]$/.exec(target);
				if (match && inodes.has(match[1])) owned.add(match[1]);
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
	}
	// Multiple listeners on the same endpoint cannot all be attributed safely.
	return owned.size === inodes.size && await verifiedOwner(identity);
}
// A WHATWG URL keeps brackets around an IPv6 literal, which getaddrinfo cannot resolve. Only the
// socket host is normalised; the HTTP or HTTPS health request uses the URL exactly as configured.
function socketHost(url: URL): string {
	const host = url.hostname;
	return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}
async function connect(url: URL): Promise<boolean> {
	return new Promise(resolveConnect => {
		const socket = createConnection({ host: socketHost(url), port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) });
		const done = (value: boolean) => { socket.destroy(); resolveConnect(value); };
		socket.setTimeout(1000, () => done(false)); socket.once("connect", () => done(true)); socket.once("error", () => done(false));
	});
}
// `timeout` is only an idle-socket timeout, so a trickling response could hold the probe open; the
// overall deadline bounds the whole request.
const healthDeadlineMs = 1000;
async function health(url: URL): Promise<boolean> {
	return new Promise(resolveHealth => {
		let settled = false;
		const finish = (value: boolean) => { if (settled) return; settled = true; clearTimeout(deadline); resolveHealth(value); };
		const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: "GET", timeout: healthDeadlineMs }, response => {
			response.resume(); finish((response.statusCode ?? 500) < 400);
		});
		const deadline = setTimeout(() => { request.destroy(); finish(false); }, healthDeadlineMs);
		request.once("timeout", () => { request.destroy(); finish(false); });
		request.once("error", () => finish(false)); request.end();
	});
}

export class HostServerRuntime implements ServerRuntime {
	private readonly directory: string;
	constructor(directory = join(homedir(), ".pi", "agent", "ui-capture-servers")) { this.directory = resolve(directory); }
	now(): number { return Date.now(); }
	sleep(ms: number): Promise<void> { return new Promise(resolveSleep => setTimeout(resolveSleep, ms)); }
	private async prepare(): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const stat = await lstat(this.directory);
		if (!stat.isDirectory() || (stat.mode & 0o077) || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error(`Server record directory is not private: ${this.directory}`);
	}
	private name(key: string): string { return createHash("sha256").update(key).digest("hex"); }
	private recordPath(key: string): string { return join(this.directory, `${this.name(key)}.json`); }
	async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
		await this.prepare();
		const path = join(this.directory, `${this.name(key)}.lock`);
		let lock;
		try { lock = await open(path, "wx", 0o600); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Server record is locked: ${path}; inspect the stale lock before removing it`); throw error; }
		try { return await fn(); }
		finally { await lock.close(); await unlink(path); }
	}
	async load(key: string): Promise<OwnedServer | null> {
		await this.prepare();
		let file;
		try { file = await open(this.recordPath(key), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
		try {
			const stat = await file.stat();
			if (!stat.isFile() || (stat.mode & 0o077) || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("Unverified ownership record");
			return JSON.parse(await file.readFile("utf8")) as OwnedServer;
		} finally { await file.close(); }
	}
	async save(record: OwnedServer): Promise<void> {
		await this.prepare();
		await writeFile(this.recordPath(record.key), JSON.stringify(record), { flag: "wx", mode: 0o600 });
	}
	async remove(key: string): Promise<void> { await unlink(this.recordPath(key)); }
	async pickPort(): Promise<number> {
		return new Promise((resolvePort, reject) => {
			const server = createServer(); server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				if (!address || typeof address === "string") { server.close(); reject(new Error("Could not select a port")); return; }
				server.close(error => error ? reject(error) : resolvePort(address.port));
			});
		});
	}
	async probe(text: string, identity?: Identity): Promise<Probe> {
		const url = new URL(text);
		const listener = await connect(url);
		if (!listener) return { listener: false, healthy: false };
		const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
		const before = identity ? await ownedListener(identity, port) : undefined;
		const healthy = await health(url);
		const owned = identity ? before && await ownedListener(identity, port) : undefined;
		return { listener, healthy, ...(identity ? { owned } : {}) };
	}
	assertLaunchSupported(): never {
		throw new Error("Automatic server launch is unavailable: safe containment cannot be guaranteed; start the server yourself and use server.url");
	}
	async launch(_command: TrustedCommand, _options: { cwd: string; env: Record<string, string>; detached: boolean }): Promise<{ identity: Identity; logPath: string }> {
		return this.assertLaunchSupported();
	}
	verify(identity: Identity): Promise<boolean> { return verifiedOwner(identity); }
	async stop(identity: Identity, detached: boolean): Promise<void> {
		if (detached || !await verified(identity)) throw new Error("Cannot stop: ownership cannot be verified");
		await controlSupervisor(identity, "stop");
		throw new Error("Supervisor group stopped, but legacy launch containment cannot be verified; ownership record retained. Inspect for escaped processes before manual cleanup.");
	}
	async logs(path: string, tail: number): Promise<string> {
		if (dirname(resolve(path)) !== this.directory) throw new Error("Unverified log path");
		const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const stat = await file.stat();
			if (!stat.isFile() || (stat.mode & 0o077) || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("Unverified log file");
			const size = Math.min(stat.size, 256 * 1024), buffer = Buffer.alloc(size);
			const { bytesRead } = await file.read(buffer, 0, size, stat.size - size);
			return buffer.subarray(0, bytesRead).toString("utf8").split("\n").slice(-tail - 1).join("\n");
		} finally { await file.close(); }
	}
}
