import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, link, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { Worker } from "node:worker_threads";

const MAX_BYTES = 24 * 1024;
const MAX_LINES = 1000;
const MAX_GREP_LINE_BYTES = 8 * 1024 * 1024;
const GREP_TIMEOUT_MS = 4000;
const PIPE_IDLE_MS = 2000;
const KILL_GRACE_MS = 1000;
// Reserve a fixed-size header so the larger capture can become the final log.
const HEADER_DIGITS = 20;
const header = (name: string, size: number) => Buffer.from(`--- ${name} (${String(size).padStart(HEADER_DIGITS, "0")} bytes) ---\n`);

function clip(text: string, bytes: number, tail: boolean): string {
	const buffer = Buffer.from(text);
	if (buffer.length <= bytes) return text;
	if (bytes <= 0) return "";
	if (!tail) return new StringDecoder("utf8").write(buffer.subarray(0, bytes));
	let start = buffer.length - bytes;
	while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
	return buffer.subarray(start).toString("utf8");
}

class Display {
	private lines: string[] = [];
	private bytes = 0;
	private fragment = "";
	private fragmentBytes = 0;
	private fragmentClipped = false;
	private decoder = new StringDecoder("utf8");
	truncated = false;
	matched = false;

	private readonly tail: number | undefined;
	constructor(tail: number | undefined) {
		this.tail = tail;
	}

	get isTail(): boolean { return this.tail !== undefined; }

	write(chunk: Buffer): void {
		this.consume(this.decoder.write(chunk));
	}

	finish(): string {
		this.consume(this.decoder.end());
		if (this.fragmentBytes || this.fragmentClipped) this.line(false);
		return this.lines.join("");
	}

	private consume(text: string): void {
		let start = 0;
		for (;;) {
			const end = text.indexOf("\n", start);
			const part = end < 0 ? text.slice(start) : text.slice(start, end);
			this.addFragment(part);
			if (end < 0) return;
			this.line(true);
			start = end + 1;
		}
	}

	private addFragment(part: string): void {
		const added = Buffer.byteLength(part);
		this.fragmentBytes += added;
		if (this.fragmentBytes <= MAX_BYTES) {
			this.fragment += part;
		} else {
			this.fragment = clip(this.fragment + part, MAX_BYTES, this.tail !== undefined);
			this.fragmentClipped = true;
		}
	}

	private line(newline: boolean): void {
		this.addLine(this.fragment + (newline ? "\n" : ""), this.fragmentClipped);
		this.fragment = "";
		this.fragmentBytes = 0;
		this.fragmentClipped = false;
	}

	addLine(line: string, clipped: boolean): void {
		const isTail = this.tail !== undefined;
		const maxLines = isTail ? Math.min(this.tail!, MAX_LINES) : MAX_LINES;
		if (!isTail && (this.lines.length >= maxLines || this.bytes >= MAX_BYTES)) {
			this.truncated = true;
			return;
		}
		if (clipped || Buffer.byteLength(line) > MAX_BYTES) this.truncated = true;
		line = clip(line, MAX_BYTES, isTail);
		this.lines.push(line);
		this.bytes += Buffer.byteLength(line);
		if (isTail) {
			while (this.lines.length > maxLines) {
				this.bytes -= Buffer.byteLength(this.lines.shift()!);
				this.truncated = true;
			}
			while (this.bytes > MAX_BYTES && this.lines.length > 1) {
				const excess = this.bytes - MAX_BYTES;
				const first = this.lines[0];
				const size = Buffer.byteLength(first);
				if (size <= excess) {
					this.lines.shift();
					this.bytes -= size;
				} else {
					this.lines[0] = clip(first, size - excess, true);
					this.bytes += Buffer.byteLength(this.lines[0]) - size;
				}
				this.truncated = true;
			}
		} else if (this.bytes > MAX_BYTES) {
			const last = this.lines.length - 1;
			const size = Buffer.byteLength(this.lines[last]);
			this.lines[last] = clip(this.lines[last], size - (this.bytes - MAX_BYTES), false);
			this.bytes += Buffer.byteLength(this.lines[last]) - size;
			this.truncated = true;
		}
	}
}

async function writeAll(file: FileHandle, buffer: Buffer, onWrite?: (chunk: Buffer) => void): Promise<void> {
	let offset = 0;
	while (offset < buffer.length) {
		const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset);
		if (!bytesWritten) throw new Error("Could not write output file");
		onWrite?.(buffer.subarray(offset, offset + bytesWritten));
		offset += bytesWritten;
	}
}

function countNewlines(buffer: Buffer): number {
	let count = 0;
	for (let offset = 0; (offset = buffer.indexOf(10, offset)) !== -1; offset++) count++;
	return count;
}

async function privateDir(path: string): Promise<FileHandle> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const before = await lstat(path);
	if (!before.isDirectory() || (typeof process.getuid === "function" && before.uid !== process.getuid())) {
		throw new Error(`Output directory is not a private directory owned by the current user: ${path}`);
	}
	if (before.mode & 0o077) throw new Error(`Output directory is not private: ${path}`);
	const dir = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
	try {
		const after = await dir.stat();
		if (before.dev !== after.dev || before.ino !== after.ino || !after.isDirectory() || (after.mode & 0o077) || (typeof process.getuid === "function" && after.uid !== process.getuid())) {
			throw new Error(`Output directory changed or is not private: ${path}`);
		}
		return dir;
	} catch (error) { await dir.close(); throw error; }
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
	if (!child.pid) return;
	try {
		if (process.platform !== "win32") process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch { /* The process or group may already have exited. */ }
}

// A process group ID can be reused after its last member exits. On Linux, only
// signal an exited leader's group if a member from the cancellation snapshot is
// still in that group with the same process start time.
async function groupMembers(group: number): Promise<Map<number, string>> {
	const members = new Map<number, string>();
	if (process.platform !== "linux") return members;
	const names = await readdir("/proc");
	let next = 0;
	await Promise.all(Array.from({ length: 32 }, async () => {
		while (next < names.length) {
			const name = names[next++];
			if (!/^\d+$/.test(name)) continue;
			try {
				const stat = await readFile(`/proc/${name}/stat`, "utf8");
				const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
				if (Number(fields[2]) === group) members.set(Number(name), fields[19]);
			} catch { /* Processes can disappear while /proc is read. */ }
		}
	}));
	return members;
}

async function sameGroupMember(group: number, members: Map<number, string>): Promise<boolean> {
	for (const [pid, start] of members) {
		try {
			const stat = await readFile(`/proc/${pid}/stat`, "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			if (Number(fields[2]) === group && fields[19] === start && fields[0] !== "Z") return true;
		} catch { /* This member has exited. */ }
	}
	return false;
}

// Matching happens only in this worker, which can be terminated even when a
// JavaScript regexp backtracks forever. Messages are acknowledged to bound the
// amount of filtered output queued in memory.
const GREP_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { readSync } = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const pattern = new RegExp(workerData.source, workerData.flags);
const decoder = new StringDecoder('utf8');
let fragment = '', bytes = 0, oversized = false, incomplete = false;
let batch = [], batchBytes = 0;
async function flush() {
  if (!batch.length) return;
  const items = batch; batch = []; batchBytes = 0;
  await new Promise(resolve => { parentPort.once('message', resolve); parentPort.postMessage({ items }); });
}
async function line(newline) {
  if (oversized) incomplete = true;
  else {
    pattern.lastIndex = 0;
    if (pattern.test(fragment)) {
      let data = Buffer.from(fragment + (newline ? '\n' : ''));
      const clipped = data.length > workerData.displayLimit;
      if (clipped) {
        if (workerData.tail) {
          let start = data.length - workerData.displayLimit;
          while (start < data.length && (data[start] & 0xc0) === 0x80) start++;
          data = data.subarray(start);
        } else {
          const d = new StringDecoder('utf8');
          data = Buffer.from(d.write(data.subarray(0, workerData.displayLimit)));
        }
      }
      batch.push({ text: data.toString('utf8'), clipped }); batchBytes += data.length + 32;
      if (batchBytes >= 65536 || batch.length >= 512) await flush();
    }
  }
  fragment = ''; bytes = 0; oversized = false;
}
async function consume(text) {
  let start = 0;
  for (;;) {
    const end = text.indexOf('\n', start);
    const part = end < 0 ? text.slice(start) : text.slice(start, end);
    bytes += Buffer.byteLength(part);
    if (bytes > workerData.lineLimit) { oversized = true; fragment = ''; }
    else if (!oversized) fragment += part;
    if (end < 0) return;
    await line(true); start = end + 1;
  }
}
(async () => {
  const buffer = Buffer.allocUnsafe(65536);
  let position = workerData.start, left = workerData.size;
  while (left > 0) {
    const n = readSync(workerData.fd, buffer, 0, Math.min(buffer.length, left), position);
    if (!n) { incomplete = true; break; }
    position += n; left -= n;
    await consume(decoder.write(buffer.subarray(0, n)));
    parentPort.postMessage({ progress: true });
  }
  if (left === 0) {
    await consume(decoder.end());
    if (bytes || oversized) await line(false);
  } else if (bytes || oversized) incomplete = true;
  await flush();
  parentPort.postMessage({ done: true, incomplete });
})().catch(error => parentPort.postMessage({ error: String(error) }));
`;

async function filterOutput(file: FileHandle, size: number, pattern: RegExp, display: Display, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return true;
	return new Promise<boolean>((resolveFilter) => {
		let worker: Worker;
		try {
			worker = new Worker(GREP_WORKER, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 }, workerData: {
				fd: file.fd, start: header("stdout", 0).length, size, source: pattern.source, flags: pattern.flags,
				lineLimit: MAX_GREP_LINE_BYTES, displayLimit: MAX_BYTES, tail: displayIsTail(display),
			} });
		} catch { resolveFilter(true); return; }
		let done = false;
		const finish = (incomplete: boolean) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			void worker.terminate().then(() => resolveFilter(incomplete), () => resolveFilter(true));
		};
		const abort = () => finish(true);
		let timer = setTimeout(() => finish(true), GREP_TIMEOUT_MS);
		const progress = () => { clearTimeout(timer); timer = setTimeout(() => finish(true), GREP_TIMEOUT_MS); };
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) { abort(); return; }
		worker.on("message", (message: { items?: { text: string; clipped: boolean }[]; progress?: boolean; done?: boolean; incomplete?: boolean; error?: string }) => {
			if (done) return;
			if (message.items) {
				for (const item of message.items) { display.matched = true; display.addLine(item.text, item.clipped); }
				progress();
				worker.postMessage(null);
			} else if (message.progress) progress();
			else if (message.done) finish(!!message.incomplete);
			else if (message.error) finish(true);
		});
		worker.once("error", () => finish(true));
		worker.once("exit", () => finish(true));
	});
}

function displayIsTail(display: Display): boolean {
	return display.isTail;
}

export async function runJust(argv: string[], options: { cwd: string; signal?: AbortSignal; grep?: RegExp; tail?: number; outputDir?: string }): Promise<{ stdout: string; stderr: string; code: number; killed: boolean; cancelled: boolean; truncated: boolean; matched?: boolean; filterIncomplete: boolean; fullOutputPath: string; fullOutputLines?: number; incomplete: boolean; logError?: string; capturePaths?: string[]; outputUnavailable?: boolean }> {
	if (options.tail !== undefined && (!Number.isSafeInteger(options.tail) || options.tail < 1)) throw new Error("tail must be a positive integer");
	const outputDir = resolve(options.outputDir ?? "/tmp/just-tools/outputs");
	if (!options.outputDir) { const parent = await privateDir("/tmp/just-tools"); await parent.close(); }
	const dir = await privateDir(outputDir);
	const anchor = process.platform === "linux" ? `/proc/self/fd/${dir.fd}` : outputDir;
	let workDir: string | undefined;
	let stdoutFile: FileHandle | undefined;
	let stderrFile: FileHandle | undefined;
	let committed = false;
	let linked = false;
	let dirClosed = false;
	let outputUnavailable = false;
	let cancelled = !!options.signal?.aborted;
	let incomplete = cancelled;
	let filterIncomplete = false;
	let killed = false;
	let code = -1;
	let child: ChildProcess | undefined;
	let captureActive = false;
	let exited = false;
	let stopTask: Promise<void> | undefined;
	const errors: string[] = [];
	const captureLines = { stdout: 0, stderr: 0 };
	let captureCountReliable = true;
	const name = `${randomUUID()}.out`;
	let actualDir = outputDir;
	const onAbort = () => {
		cancelled = true;
		incomplete = true;
		if (!captureActive || !child || stopTask) return;
		const target = child;
		stopTask = (async () => {
			let members = new Map<number, string>();
			let canVerifyGroup = process.platform === "linux";
			if (target.pid && canVerifyGroup) {
				try { members = await groupMembers(target.pid); } catch { canVerifyGroup = false; }
			}
			if (!exited || (target.pid && await sameGroupMember(target.pid, members))) signalProcess(target, "SIGTERM");
			await new Promise((resolveWait) => setTimeout(resolveWait, KILL_GRACE_MS));
			if (!exited || (target.pid && await sameGroupMember(target.pid, members))) signalProcess(target, "SIGKILL");
			else if (!canVerifyGroup) errors.push("Cannot verify the exited process group; descendant force-kill was skipped to avoid signalling a reused group ID");
		})();
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	if (options.signal?.aborted) onAbort();
	try {
		workDir = await mkdtemp(join(anchor, ".capture-"));
		stdoutFile = await open(join(workDir, "stdout"), "wx+", 0o600);
		stderrFile = await open(join(workDir, "stderr"), "wx+", 0o600);
		await writeAll(stdoutFile, header("stdout", 0));
		await writeAll(stderrFile, header("stderr", 0));
		const stdout = new Display(options.tail);
		const stderr = new Display(options.tail);
		if (!cancelled) {
			child = spawn("just", argv, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", shell: false });
			captureActive = true;
			let forcedClose = false;
			let activeWrites = 0;
			let pipeTimer: ReturnType<typeof setTimeout> | undefined;
			const running = child;
			const refreshPipeTimer = () => {
				if (!exited) return;
				if (pipeTimer) clearTimeout(pipeTimer);
				pipeTimer = setTimeout(() => {
					if (activeWrites) { refreshPipeTimer(); return; }
					incomplete = true;
					forcedClose = true;
					running.stdout?.destroy();
					running.stderr?.destroy();
				}, PIPE_IDLE_MS);
			};
			const status = new Promise<void>((resolveStatus) => {
				running.once("error", (error) => { errors.push(`Process error: ${error.message}`); incomplete = true; exited = true; resolveStatus(); });
				running.once("exit", (exitCode, signal) => {
					exited = true; code = exitCode ?? -1; killed = signal !== null;
					if (killed) incomplete = true;
					refreshPipeTimer(); resolveStatus();
				});
			});
			const capture = async (stream: Readable, file: FileHandle, display: Display, filtered: boolean, name: "stdout" | "stderr") => {
				let writable = true;
				try {
					for await (const chunk of stream) {
						const buffer = chunk as Buffer;
						if (writable) {
							activeWrites++;
							try { await writeAll(file, buffer, (written) => { captureLines[name] += countNewlines(written); }); }
							catch (error) { writable = false; captureCountReliable = false; incomplete = true; errors.push(`Capture write failed: ${String(error)}`); }
							finally { activeWrites--; }
						}
						if (!filtered) display.write(buffer);
						refreshPipeTimer();
					}
				} catch (error) {
					if (!forcedClose || (error as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE") {
						incomplete = true; errors.push(`Capture read failed: ${String(error)}`);
					}
				}
			};
			if (options.signal?.aborted) onAbort();
			await Promise.all([status, capture(running.stdout!, stdoutFile, stdout, !!options.grep, "stdout"), capture(running.stderr!, stderrFile, stderr, false, "stderr")]);
			captureActive = false;
			if (pipeTimer) clearTimeout(pipeTimer);
			if (stopTask) await stopTask;
		}

		try {
			const files = { stdout: stdoutFile, stderr: stderrFile };
			const sizes = { stdout: (await stdoutFile.stat()).size - header("stdout", 0).length, stderr: (await stderrFile.stat()).size - header("stderr", 0).length };
			if (options.grep) filterIncomplete = (await filterOutput(stdoutFile, sizes.stdout, options.grep, stdout, options.signal)) || incomplete;
			for (const stream of ["stdout", "stderr"] as const) {
				const data = header(stream, sizes[stream]);
				let offset = 0;
				while (offset < data.length) {
					const { bytesWritten } = await files[stream].write(data, offset, data.length - offset, offset);
					if (!bytesWritten) throw new Error("Could not write output header");
					offset += bytesWritten;
				}
			}
			// Hard-link the larger capture into place and append only the smaller
			// one. On failure both original captures remain available.
			const first = sizes.stdout >= sizes.stderr ? "stdout" : "stderr";
			const second = first === "stdout" ? "stderr" : "stdout";
			await link(join(workDir, first), join(anchor, name));
			linked = true;
			await writeAll(files[first], Buffer.from("\n"));
			const buffer = Buffer.allocUnsafe(64 * 1024);
			let position = 0;
			for (;;) {
				const { bytesRead } = await files[second].read(buffer, 0, buffer.length, position);
				if (!bytesRead) break;
				await writeAll(files[first], buffer.subarray(0, bytesRead));
				position += bytesRead;
			}
			await writeAll(files[first], Buffer.from("\n"));
			await stdoutFile.close(); stdoutFile = undefined;
			await stderrFile.close(); stderrFile = undefined;
			committed = true;
		} catch (error) {
			incomplete = true;
			if (options.grep) filterIncomplete = true;
			errors.push(`Log finalization failed: ${String(error)}`);
		}
		const closed = await Promise.allSettled([stdoutFile?.close(), stderrFile?.close()]);
		stdoutFile = undefined; stderrFile = undefined;
		for (const result of closed) {
			if (result.status === "rejected") { incomplete = true; errors.push(`Capture close failed: ${String(result.reason)}`); }
		}
		if (process.platform === "linux") {
			try {
				actualDir = await readlink(anchor);
				if (actualDir.endsWith(" (deleted)")) { outputUnavailable = true; incomplete = true; errors.push("Output directory was removed; its files are unavailable by path"); }
			} catch (error) { outputUnavailable = true; incomplete = true; errors.push(`Cannot locate output directory: ${String(error)}`); }
		}
		const captureDir = join(actualDir, workDir.slice(workDir.lastIndexOf("/") + 1));
		const fullOutputPath = join(actualDir, name);
		if (committed) {
			try { await rm(workDir, { recursive: true, force: true }); }
			catch (error) { errors.push(`Capture cleanup failed: ${String(error)}`); }
		}
		dirClosed = true;
		try { await dir.close(); }
		catch (error) { incomplete = true; errors.push(`Output directory close failed: ${String(error)}`); }
		return {
			stdout: stdout.finish(), stderr: stderr.finish(), code, killed, cancelled,
			truncated: stdout.truncated || stderr.truncated, ...(options.grep ? { matched: stdout.matched } : {}),
			filterIncomplete, fullOutputPath, incomplete,
			// The finalized log has two header newlines and two separator newlines.
			...(committed && !outputUnavailable && captureCountReliable && Number.isSafeInteger(captureLines.stdout + captureLines.stderr + 4) ? { fullOutputLines: captureLines.stdout + captureLines.stderr + 4 } : {}),
			...(errors.length ? { logError: errors.join("; ") } : {}),
			...(!committed && !outputUnavailable ? { capturePaths: [join(captureDir, "stdout"), join(captureDir, "stderr"), ...(linked ? [fullOutputPath] : [])] } : {}),
			...(outputUnavailable ? { outputUnavailable: true } : {}),
		};
	} catch (error) {
		const location = workDir ? `; captures retained in ${join(outputDir, workDir.slice(workDir.lastIndexOf("/") + 1))}` : "";
		throw new Error(`${String(error)}${location}`);
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		await Promise.allSettled([stdoutFile?.close(), stderrFile?.close()]);
		if (!dirClosed) await dir.close();
	}
}
