// Locks compatible with Pi's proper-lockfile and pi-subagents' physical settings lease.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const STALE_MS = 10_000;

function errorCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
function processStart(pid: number): string | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
	} catch { return undefined; }
}
interface Owner { token: string; pid: number; hostname: string; processStart?: string }
function readOwner(lock: string): Owner | undefined {
	try {
		const owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")) as Owner;
		if (typeof owner.token !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(owner.token) || typeof owner.hostname !== "string" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return undefined;
		return owner;
	} catch { return undefined; }
}
function dead(owner: Owner): boolean {
	if (owner.hostname !== os.hostname()) return false;
	try { process.kill(owner.pid, 0); } catch (error) { return errorCode(error) === "ESRCH"; }
	const current = processStart(owner.pid);
	return owner.processStart !== undefined && current !== undefined && owner.processStart !== current;
}
interface HeldLock { assert(): void; release(): void }

async function lease(lock: string): Promise<HeldLock> {
	const owner: Owner = { token: randomUUID(), pid: process.pid, hostname: os.hostname(), processStart: processStart(process.pid) };
	const deadline = Date.now() + 10_000;
	for (;;) {
		try {
			fs.mkdirSync(lock, { mode: 0o700 });
			const created = fs.statSync(lock);
			try { fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 }); }
			catch (error) {
				try {
					const current = fs.statSync(lock);
					if (current.dev === created.dev && current.ino === created.ino && !fs.existsSync(path.join(lock, "owner.json"))) fs.rmdirSync(lock);
				} catch { /* best effort; never remove a replacement */ }
				throw error;
			}
			return {
				assert() { if (readOwner(lock)?.token !== owner.token) throw new Error(`Lock compromised: ${lock}`); },
				release() { if (readOwner(lock)?.token === owner.token) fs.rmSync(lock, { recursive: true }); },
			};
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
			const previous = readOwner(lock);
			if (previous && dead(previous)) {
				const retired = `${lock}.retired-${previous.token}`;
				try { fs.renameSync(lock, retired); }
				catch (renameError) {
					if (errorCode(renameError) !== "ENOENT" && readOwner(retired)?.token !== previous.token) throw renameError;
					continue;
				}
				if (readOwner(retired)?.token !== previous.token) throw new Error(`Retired lock owner changed during recovery: ${lock}`);
				continue;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock: ${lock}`);
			await sleep(10);
		}
	}
}

async function properLock(lock: string): Promise<HeldLock> {
	const deadline = Date.now() + 20_000;
	for (;;) {
		try { fs.mkdirSync(lock); break; }
		catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
			try {
				if (fs.statSync(lock).mtimeMs < Date.now() - STALE_MS) { fs.rmdirSync(lock); continue; }
			} catch (statError) { if (errorCode(statError) !== "ENOENT") throw statError; }
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock: ${lock}`);
			await sleep(20);
		}
	}
	let initial: fs.Stats;
	try { initial = fs.statSync(lock); } catch (error) { try { fs.rmdirSync(lock); } catch {} throw error; }
	let expectedMtime = initial.mtimeMs;
	let compromised = false;
	const same = () => {
		try { const stat = fs.statSync(lock); return stat.ino === initial.ino && stat.dev === initial.dev && stat.mtimeMs === expectedMtime; }
		catch { return false; }
	};
	const timer = setInterval(() => {
		try {
			if (!same()) { compromised = true; return; }
			const now = new Date();
			fs.utimesSync(lock, now, now);
			expectedMtime = fs.statSync(lock).mtimeMs;
		} catch { compromised = true; }
	}, STALE_MS / 2);
	timer.unref();
	return {
		assert() { if (compromised || !same()) throw new Error(`Lock compromised: ${lock}`); },
		release() { clearInterval(timer); if (!compromised && same()) fs.rmdirSync(lock); },
	};
}

/** Resolve file links and existing directory links, including missing output targets. */
export function physicalPath(file: string): string {
	let current = path.resolve(file);
	const seen = new Set<string>();
	for (;;) {
		if (seen.has(current)) throw new Error(`Symlink cycle: ${file}`);
		seen.add(current);
		try { return fs.realpathSync.native(current); }
		catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
		let parent = path.dirname(current);
		const suffix = [path.basename(current)];
		while (!fs.existsSync(parent)) {
			const next = path.dirname(parent);
			if (next === parent) throw new Error(`Cannot resolve path: ${file}`);
			suffix.unshift(path.basename(parent)); parent = next;
		}
		const candidate = path.join(fs.realpathSync.native(parent), ...suffix);
		try {
			const text = fs.readlinkSync(candidate);
			current = path.isAbsolute(text) ? text : path.resolve(path.dirname(candidate), text);
		} catch (error) {
			if (errorCode(error) === "ENOENT" || errorCode(error) === "EINVAL") return candidate;
			throw error;
		}
	}
}

/** Coordinate all generator output/baseline paths, then Pi's requested lock and the physical lease. */
export async function withOutputLocks<T>(files: string[], settingsPath: string | undefined, action: (assertOwned: () => void) => Promise<T> | T): Promise<T> {
	const locks: HeldLock[] = [];
	try {
		for (const file of [...new Set(files.map(physicalPath))].sort()) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			locks.push(await lease(`${file}.generator-lock`));
		}
		if (settingsPath) {
			const requested = path.resolve(settingsPath);
			fs.mkdirSync(path.dirname(requested), { recursive: true });
			locks.push(await properLock(`${requested}.lock`));
			const target = physicalPath(requested);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			locks.push(await lease(`${target}.write-lock`));
		}
		const assertOwned = () => { for (const lock of locks) lock.assert(); };
		assertOwned();
		const result = await action(assertOwned);
		assertOwned();
		return result;
	} finally {
		for (const lock of locks.reverse()) lock.release();
	}
}
