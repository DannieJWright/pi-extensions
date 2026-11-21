// Locks compatible with Pi's proper-lockfile and pi-subagents' physical settings lease.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";

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

export function syncDirectory(directory: string): void {
	const fd = fs.openSync(directory, "r");
	try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

const mkdirIntent = "pi-permission-generator:mkdir-v1";
const mkdirIntentName = /^\.generator-mkdir-[a-f0-9]{64}$/;

function rejectMkdirIntentName(name: string, file: string): void {
	if (mkdirIntentName.test(name)) throw new Error(`Path uses reserved directory creation intent name: ${file}`);
}

function hasMkdirIntent(marker: string): boolean {
	try {
		if (fs.readlinkSync(marker) !== mkdirIntent) throw new Error(`Directory creation intent conflicts with existing path: ${marker}`);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		if (errorCode(error) === "EINVAL") throw new Error(`Directory creation intent conflicts with existing path: ${marker}`);
		throw error;
	}
}

/** Persist each created entry, retaining recoverable intent until its parent is synced. */
export function mkdirDurably(directory: string): void {
	const target = path.resolve(directory), root = path.parse(target).root;
	let parent = root;
	const names = path.relative(root, target).split(path.sep).filter(Boolean);
	for (const name of names) rejectMkdirIntentName(name, target);
	for (const name of names) {
		const child = path.join(parent, name);
		const marker = path.join(parent, `.generator-mkdir-${createHash("sha256").update(name).digest("hex")}`);
		let exists: boolean;
		try { fs.statSync(child); exists = true; }
		catch (error) { if (errorCode(error) !== "ENOENT") throw error; exists = false; }
		if (!exists) {
			// The intent must be visible before mkdir, including to a competing creator.
			for (;;) {
				try { fs.symlinkSync(mkdirIntent, marker); break; }
				catch (error) {
					if (errorCode(error) !== "EEXIST") throw error;
					if (hasMkdirIntent(marker)) break;
				}
			}
			syncDirectory(parent);
			try { fs.mkdirSync(child); }
			catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
		} else if (!hasMkdirIntent(marker)) {
			parent = child;
			continue;
		}
		syncDirectory(child);
		syncDirectory(parent);
		try { fs.unlinkSync(marker); }
		catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
		parent = child;
	}
}

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

/** Resolve links component by component, including missing targets, without traversing reserved names. */
export function physicalPath(file: string): string {
	const absolute = path.isAbsolute(file) ? file : `${process.cwd()}${path.sep}${file}`;
	let current = path.parse(absolute).root;
	let components = absolute.slice(current.length).split(path.sep);
	let missing = false, links = 0;
	while (components.length) {
		const name = components.shift()!;
		if (!name || name === ".") continue;
		if (name === "..") {
			if (missing) throw new Error(`Cannot resolve path through a missing directory and ..: ${file}`);
			current = path.dirname(current);
			continue;
		}
		rejectMkdirIntentName(name, file);
		const candidate = path.join(current, name);
		if (!missing) {
			try {
				const stat = fs.lstatSync(candidate);
				if (stat.isSymbolicLink()) {
					if (++links > 40) throw new Error(`Symlink cycle or too many links: ${file}`);
					const text = fs.readlinkSync(candidate);
					if (path.isAbsolute(text)) current = path.parse(text).root;
					components = (path.isAbsolute(text) ? text.slice(current.length) : text).split(path.sep).concat(components);
					continue;
				}
				if (components.length && !stat.isDirectory()) {
					const error = new Error(`Not a directory: ${candidate}`) as NodeJS.ErrnoException;
					error.code = "ENOTDIR";
					throw error;
				}
			} catch (error) {
				if (errorCode(error) !== "ENOENT") throw error;
				missing = true;
			}
		}
		current = candidate;
	}
	return current;
}

/** Coordinate all generator output/baseline paths, then Pi's requested lock and the physical lease. */
export async function withOutputLocks<T>(files: string[], settingsPath: string | undefined, action: (assertOwned: () => void) => Promise<T> | T): Promise<T> {
	const locks: HeldLock[] = [];
	try {
		for (const file of [...new Set(files.map(physicalPath))].sort()) {
			mkdirDurably(path.dirname(file));
			locks.push(await lease(`${file}.generator-lock`));
		}
		if (settingsPath) {
			const requested = path.resolve(settingsPath);
			mkdirDurably(path.dirname(requested));
			locks.push(await properLock(`${requested}.lock`));
			const target = physicalPath(requested);
			mkdirDurably(path.dirname(target));
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
