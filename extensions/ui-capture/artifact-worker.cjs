// A separate process lets relative filesystem operations use a pinned working
// directory on both Linux and macOS, without process-wide chdir in the host.
const { constants } = require("node:fs");
const { lstat, mkdir, open, readFile, rename, stat, unlink } = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { basename } = require("node:path");

const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const lockName = ".ui-capture.lock";
let lock;
const sameDirectory = (a, b) => a.dev === b.dev && a.ino === b.ino;
function validName(name) {
	if (typeof name !== "string" || basename(name) !== name || name === "." || name === ".." || name === lockName || !name) throw new Error(`invalid artifact name: ${name}`);
}
async function enter(name) {
	try { await mkdir(name); } catch (error) { if (error.code !== "EEXIST") throw error; }
	let handle;
	try { handle = await open(name, flags); }
	catch (error) {
		if (["ELOOP", "ENOTDIR"].includes(error.code)) throw new Error("artifact directory escapes artifact root or is not a directory");
		throw error;
	}
	try {
		process.chdir(name);
		if (!sameDirectory(await handle.stat(), await stat("."))) throw new Error("artifact directory changed while opening");
	} finally { await handle.close(); }
}
async function acquireLock() {
	try { lock = await open(lockName, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
	catch (error) {
		if (error.code === "EEXIST") throw new Error(`artifact directory is locked: ${lockName}; do not remove a live lock`);
		throw error;
	}
}
async function releaseLock() {
	const heldLock = lock;
	if (!heldLock) return;
	lock = undefined;
	try {
		const held = await heldLock.stat(), current = await lstat(lockName);
		if (!sameDirectory(held, current)) throw new Error("artifact lock changed; refusing to remove it");
		await unlink(lockName);
	} finally { await heldLock.close().catch(() => {}); }
}
async function publish(name, data) {
	validName(name);
	const temporary = `.ui-capture-${randomUUID()}.tmp`;
	const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666);
	try {
		await handle.writeFile(Buffer.from(data, "base64"));
	} catch (error) {
		await handle.close().catch(() => {});
		await unlink(temporary).catch(() => {});
		throw error;
	}
	try {
		await handle.close();
		await rename(temporary, name);
	} finally {
		await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
	}
}
function reply(id, value, error) {
	if (process.connected) process.send({ id, value, error: error && { message: error.message, code: error.code } });
}
// A host crash disconnects the channel; release the lock so later captures are not blocked forever.
process.on("disconnect", () => { releaseLock().catch(() => {}).finally(() => process.exit(0)); });
process.on("message", async message => {
	try {
		if (message.op === "init") {
			if (!sameDirectory(await stat("."), message.root)) throw new Error("artifact root changed while opening");
			await enter(message.feature); await enter(message.subphase);
			await acquireLock();
			reply(message.id, true);
		} else if (message.op === "unlock") {
			await releaseLock(); reply(message.id, true);
		} else if (message.op === "read") {
			validName(message.name);
			const data = await readFile(message.name, { flag: constants.O_RDONLY | constants.O_NOFOLLOW });
			reply(message.id, data.toString("base64"));
		} else if (message.op === "publish") {
			await publish(message.name, message.data); reply(message.id, true);
		} else throw new Error("unknown artifact operation");
	} catch (error) { reply(message.id, null, error); }
});
