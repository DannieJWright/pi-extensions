import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson, substitutePort } from "./spec.ts";
import { redactUrl } from "./redact.ts";
import { trustCommand, type TrustedCommand } from "./trust.ts";

export type ServerSpec = Record<string, unknown>;
export type Identity = { pid: number; start: string; boot: string; control?: { address: string; secret: string } };
export type OwnedServer = { version: 1; key: string; configHash: string; identity: Identity; url: string; port: number; logPath: string; startedAt: number; keep: boolean; detached: boolean };
export type Probe = { healthy: boolean; listener: boolean; pid?: number; owned?: boolean };
export type ServerRuntime = {
	now(): number;
	sleep(ms: number): Promise<void>;
	pickPort(): Promise<number>;
	probe(url: string, identity?: Identity): Promise<Probe>;
	assertLaunchSupported(): void;
	launch(command: TrustedCommand, options: { cwd: string; env: Record<string, string>; detached: boolean }): Promise<{ identity: Identity; logPath: string }>;
	verify(identity: Identity): Promise<boolean>;
	stop(identity: Identity, detached: boolean): Promise<void>;
	logs(path: string, tail: number): Promise<string>;
	load(key: string): Promise<OwnedServer | null>;
	save(record: OwnedServer): Promise<void>;
	remove(key: string): Promise<void>;
	locked<T>(key: string, fn: () => Promise<T>): Promise<T>;
};
export type ServerResult = { url: string; alive: boolean; uptime: number | null; logs: string | null; logPath?: string; restarted?: boolean };

function readyUrl(base: string, server: ServerSpec): string {
	const ready = server.ready && typeof server.ready === "object" && !Array.isArray(server.ready) ? server.ready as Record<string, unknown> : {};
	if (ready.path !== undefined && typeof ready.path !== "string") throw new Error("server.ready.path must be a string");
	const url = new URL(base);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("server URL must use http or https");
	if (ready.path !== undefined) {
		const target = new URL(ready.path as string, url);
		if (target.origin !== url.origin) throw new Error("server.ready.path must stay on the server origin");
		return target.href;
	}
	return url.href;
}
function timeoutMs(server: ServerSpec): number {
	const ready = server.ready && typeof server.ready === "object" && !Array.isArray(server.ready) ? server.ready as Record<string, unknown> : {};
	const seconds = ready.timeout ?? 60;
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) throw new Error("server.ready.timeout must be positive seconds");
	return seconds * 1000;
}
function tailValue(tail: number): number {
	if (!Number.isSafeInteger(tail) || tail < 1) throw new Error("tail must be a positive integer");
	return tail;
}
export { redactUrl };
export function frameworkLockMessage(log: string): string | null {
	if (!/another next dev server is already running|unable to acquire lock/i.test(log)) return null;
	const pid = /\bpid\s*[:=]?\s*(\d+)/i.exec(log)?.[1] ?? "unknown";
	const url = /https?:\/\/[^\s]+/.exec(log)?.[0] ?? "unknown";
	return `Framework lock: PID ${pid}; URL ${redactUrl(url)}. No lock was removed.`;
}
function recordValid(record: OwnedServer, key: string): boolean {
	return record.version === 1 && record.key === key && typeof record.configHash === "string" && /^[a-f0-9]{64}$/.test(record.configHash) && !!record.identity && Number.isSafeInteger(record.identity.pid) && record.identity.pid > 0 && typeof record.identity.start === "string" && !!record.identity.start && typeof record.identity.boot === "string" && !!record.identity.boot && typeof record.url === "string" && Number.isInteger(record.port) && record.port > 0 && record.port < 65536 && typeof record.logPath === "string" && Number.isFinite(record.startedAt) && typeof record.keep === "boolean" && typeof record.detached === "boolean";
}

export class CaptureServer {
	private readonly runtime: ServerRuntime;
	private readonly allowedCommands: string[];
	constructor(runtime: ServerRuntime, allowedCommands: string[]) { this.runtime = runtime; this.allowedCommands = allowedCommands; }
	private key(worktree: string, specPath: string): string { return JSON.stringify([resolve(worktree), resolve(worktree, specPath)]); }
	private async owned(key: string): Promise<OwnedServer | null> {
		const record = await this.runtime.load(key);
		if (record && !recordValid(record, key)) throw new Error("Unverified ownership record; refusing server control");
		return record;
	}
	private async checkedProbe(record: OwnedServer, server: ServerSpec): Promise<Probe> {
		if (!await this.runtime.verify(record.identity)) return { healthy: false, listener: false };
		return this.runtime.probe(readyUrl(record.url, server), record.identity);
	}
	private result(record: OwnedServer, alive: boolean, logs: string): ServerResult {
		return { url: redactUrl(record.url), alive, uptime: Math.max(0, this.runtime.now() - record.startedAt), logs, logPath: record.logPath };
	}
	// An external URL has no ownership record, so its health check does not take the ownership lock or
	// touch the record directory. Readiness polling, timeout, cancellation and URL validation are unchanged.
	private async external(configured: string, server: ServerSpec, checkCancellation: () => void): Promise<ServerResult> {
		const url = readyUrl(configured, server), deadline = this.runtime.now() + timeoutMs(server);
		for (;;) {
			checkCancellation();
			const probe = await this.runtime.probe(url); checkCancellation();
			if (probe.healthy) return { url: redactUrl(configured), alive: true, uptime: null, logs: null };
			if (this.runtime.now() >= deadline) throw new Error(`External server is unavailable: ${redactUrl(configured)}`);
			await this.runtime.sleep(Math.min(100, deadline - this.runtime.now()));
		}
	}
	async start(worktree: string, specPath: string, server: ServerSpec, onStarted?: (identity: Identity) => void, signal?: AbortSignal): Promise<ServerResult> {
		const checkCancellation = () => { if (signal?.aborted) throw new Error("capture cancelled"); };
		if (typeof server.url === "string" && !server.start) return this.external(server.url, server, checkCancellation);
		const key = this.key(worktree, specPath);
		return this.runtime.locked(key, async () => {
			checkCancellation();
			if (typeof server.start !== "string" || !server.start || server.url) throw new Error("server requires exactly one of url or start");
			const old = await this.owned(key);
			const configHash = createHash("sha256").update(canonicalJson(server)).digest("hex");
			if (old && old.configHash !== configHash) throw new Error("Server configuration changed; stop the recorded server first");
			if (!old) this.runtime.assertLaunchSupported();
			const port = server.port === "auto" ? (old?.port ?? await this.runtime.pickPort()) : server.port;
			if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) throw new Error("server.port must be auto or a port number");
			const expanded = substitutePort(server, port as number);
			const start = trustCommand(expanded.start as string, this.allowedCommands);
			if (server.stop !== undefined) {
				if (typeof server.stop !== "string" || !server.stop) throw new Error("server.stop must be a command");
				trustCommand(server.stop.replaceAll("{port}", String(port)), this.allowedCommands);
			}
			const detached = server.detached === true;
			if (detached && !server.stop) throw new Error("detached server requires stop");
			const cwd = resolve(worktree, typeof server.cwd === "string" ? server.cwd : ".");
			const env = expanded.env === undefined ? {} : expanded.env;
			if (!env || typeof env !== "object" || Array.isArray(env) || !Object.values(env).every(v => typeof v === "string")) throw new Error("server.env must map strings to strings");
			const url = `http://127.0.0.1:${port}`;
			const probeUrl = readyUrl(url, server);
			const duration = timeoutMs(server);
			if (old && old.port !== port) throw new Error("Server port changed; stop the recorded server first");
			let previousLogs = "";
			if (old) {
				previousLogs = await this.runtime.logs(old.logPath, 25);
				if (!await this.runtime.verify(old.identity)) throw new Error("Ownership cannot be verified; refusing restart and retaining the record");
				const current = await this.checkedProbe(old, server);
				checkCancellation();
				if (current.healthy && current.owned) return this.result(old, true, previousLogs);
				if (current.listener && !current.owned) throw new Error(`Foreign listener: PID ${current.pid ?? "unknown"}; URL ${redactUrl(old.url)}`);
				this.runtime.assertLaunchSupported();
				await this.runtime.stop(old.identity, old.detached);
				await this.runtime.remove(key);
			}
			const before = await this.runtime.probe(probeUrl);
			if (before.listener) throw new Error(`Foreign listener: PID ${before.pid ?? "unknown"}; URL ${redactUrl(url)}`);
			checkCancellation();
			this.runtime.assertLaunchSupported();
			const launched = await this.runtime.launch(start, { cwd, env: env as Record<string, string>, detached });
			const record: OwnedServer = { version: 1, key, configHash, identity: launched.identity, url, port: port as number, logPath: launched.logPath, startedAt: this.runtime.now(), keep: server.keep === true, detached };
			let saved = false;
			try {
				checkCancellation();
				if (!recordValid(record, key) || !await this.runtime.verify(record.identity)) throw new Error("Launcher did not provide a verifiable process identity");
				await this.runtime.save(record); saved = true;
				const deadline = this.runtime.now() + duration;
				for (;;) {
					checkCancellation();
					const log = await this.runtime.logs(record.logPath, 25);
					const lock = frameworkLockMessage(log); if (lock) throw new Error(lock);
					if (!await this.runtime.verify(record.identity)) throw new Error("Server process exited or ownership changed during startup");
					const probe = await this.runtime.probe(probeUrl, record.identity);
					checkCancellation();
					if (probe.listener && !probe.owned) throw new Error(`Foreign listener or bind race: PID ${probe.pid ?? "unknown"}; URL ${redactUrl(url)}`);
					if (probe.healthy && probe.owned) {
						onStarted?.(record.identity);
						return { ...this.result(record, true, old ? previousLogs : log), ...(old ? { restarted: true } : {}) };
					}
					if (this.runtime.now() >= deadline) throw new Error(`Server readiness timed out after ${duration / 1000} seconds; URL ${redactUrl(url)}; log: ${log}`);
					await this.runtime.sleep(Math.min(100, deadline - this.runtime.now()));
				}
			} catch (error) {
				try { await this.runtime.stop(record.identity, detached); if (saved) await this.runtime.remove(key); }
				catch (cleanup) { throw new Error(`${String(error)}; cleanup refused or failed: ${String(cleanup)}`); }
				throw error;
			}
		});
	}
	async status(worktree: string, specPath: string, server: ServerSpec, tail = 25): Promise<ServerResult> {
		tailValue(tail);
		if (typeof server.url === "string" && !server.start) return { url: redactUrl(server.url), alive: (await this.runtime.probe(readyUrl(server.url, server))).healthy, uptime: null, logs: null };
		const record = await this.owned(this.key(worktree, specPath));
		if (!record) throw new Error("No ownership record for this server");
		const probe = await this.checkedProbe(record, server);
		return this.result(record, probe.healthy && probe.owned === true, await this.runtime.logs(record.logPath, tail));
	}
	async logs(worktree: string, specPath: string, server: ServerSpec, tail = 25): Promise<string | null> {
		tailValue(tail);
		if (typeof server.url === "string" && !server.start) return null;
		const record = await this.owned(this.key(worktree, specPath));
		if (!record) throw new Error("No ownership record for this server");
		return this.runtime.logs(record.logPath, tail);
	}
	async stop(worktree: string, specPath: string, server: ServerSpec): Promise<boolean> {
		if (typeof server.url === "string" && !server.start) return false;
		const key = this.key(worktree, specPath);
		await this.runtime.locked(key, async () => {
			const record = await this.owned(key);
			if (!record || !await this.runtime.verify(record.identity)) throw new Error("Cannot stop: ownership cannot be verified");
			await this.runtime.stop(record.identity, record.detached);
			await this.runtime.remove(key);
		});
		return true;
	}
	async stopIfOwned(worktree: string, specPath: string, identity: Identity): Promise<void> {
		const key = this.key(worktree, specPath);
		await this.runtime.locked(key, async () => {
			const record = await this.owned(key);
			if (!record || record.keep || canonicalJson(record.identity) !== canonicalJson(identity)) return;
			if (!await this.runtime.verify(record.identity)) throw new Error("Cannot stop: ownership cannot be verified");
			await this.runtime.stop(record.identity, record.detached);
			await this.runtime.remove(key);
		});
	}
	async shutdown(worktree: string, specs: Array<{ path: string; server: ServerSpec }>): Promise<void> {
		for (const spec of specs) {
			const record = await this.owned(this.key(worktree, spec.path));
			if (!record || record.keep) continue;
			await this.stopIfOwned(worktree, spec.path, record.identity);
		}
	}
}
