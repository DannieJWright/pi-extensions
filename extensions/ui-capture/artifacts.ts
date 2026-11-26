import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safeComponent, type CaptureSpec } from "./spec.ts";

// An open capture or pair check holds this exclusive file in its artifact directory for the whole operation.
export const ARTIFACT_LOCK = ".ui-capture.lock";
export type ArtifactDirectory = { dir: string; lockPath: string; read(name: string): Promise<Buffer>; publish(name: string, data: string | Buffer): Promise<void>; close(): Promise<void> };
export type ArtifactLocation = string | ArtifactDirectory;

function validName(name: string): void {
	if (!name || basename(name) !== name || name === "." || name === ".." || name === ARTIFACT_LOCK) throw new Error(`invalid artifact name: ${name}`);
}

// A child with a pinned cwd gives Node relative directory operations on Linux
// and macOS without changing the host process's cwd or relying on /proc.
export async function openArtifactDirectory(gitRoot: string, spec: CaptureSpec, override = "artifacts"): Promise<ArtifactDirectory> {
	if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("secure artifact directories require Linux or macOS");
	const root = resolve(gitRoot, override);
	const feature = safeComponent(spec.feature, "feature"), subphase = safeComponent(spec.subphase, "subphase");
	await mkdir(root, { recursive: true });
	const canonicalRoot = await realpath(root);
	const handle = await open(canonicalRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const rootStat = await handle.stat();
		const child = fork(fileURLToPath(new URL("./artifact-worker.cjs", import.meta.url)), [], { cwd: canonicalRoot, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
		let sequence = 0, ended: Error | undefined, spawned = false, exited = false, locked = false;
		const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
		const fail = (error: Error) => { ended ??= error; for (const request of pending.values()) request.reject(error); pending.clear(); };
		child.on("spawn", () => { spawned = true; });
		child.on("error", fail);
		child.on("disconnect", () => fail(new Error("artifact worker disconnected")));
		child.on("exit", (code, signal) => { exited = true; fail(new Error(`artifact worker exited (${signal ?? code})`)); });
		child.on("message", (response: any) => {
			const request = pending.get(response.id); if (!request) return;
			pending.delete(response.id);
			if (response.error) { const error = new Error(response.error.message) as NodeJS.ErrnoException; error.code = response.error.code; request.reject(error); }
			else request.resolve(response.value);
		});
		const request = (op: string, args: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
			if (ended || !child.connected) { reject(ended ?? new Error("artifact worker disconnected")); return; }
			const id = ++sequence; pending.set(id, { resolve, reject });
			child.send({ id, op, ...args }, error => { if (error && pending.delete(id)) reject(error); });
		});
		const close = async () => {
			try { if (locked) { locked = false; await request("unlock"); } }
			finally {
				if (child.connected) child.disconnect();
				if (spawned && !exited) await new Promise<void>(resolve => child.once("exit", () => resolve()));
			}
		};
		try { await request("init", { root: { dev: rootStat.dev, ino: rootStat.ino }, feature, subphase }); locked = true; }
		catch (error) { await close(); throw error; }
		const dir = join(root, feature, subphase);
		return {
			dir, lockPath: join(dir, ARTIFACT_LOCK),
			read: async name => { validName(name); return Buffer.from(await request("read", { name }), "base64"); },
			publish: async (name, data) => { validName(name); await request("publish", { name, data: Buffer.from(data).toString("base64") }); },
			close,
		};
	} finally { await handle.close(); }
}

export async function readArtifact(dir: ArtifactLocation, name: string): Promise<Buffer> {
	validName(name);
	return typeof dir === "string" ? readFile(join(dir, name), { flag: constants.O_RDONLY | constants.O_NOFOLLOW }) : dir.read(name);
}

// Publish through a new exclusive file and rename, never opening the destination
// for writing. The rename replaces a destination symlink rather than following it.
export async function publishArtifact(dir: ArtifactLocation, name: string, data: string | Buffer): Promise<void> {
	validName(name);
	if (typeof dir !== "string") return dir.publish(name, data);
	const temporary = join(dir, `.ui-capture-${randomUUID()}.tmp`);
	const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666);
	try {
		await handle.writeFile(data);
		await handle.close();
		await rename(temporary, join(dir, name));
	} finally {
		await handle.close();
		await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
	}
}
