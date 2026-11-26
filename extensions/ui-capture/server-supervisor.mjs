// LEGACY / PENDING: nothing launches this supervisor. HostServerRuntime.launch and assertLaunchSupported
// always throw (see server-runtime.ts), so it is kept only for its tests and for a future safe launcher.
// The hello/stop/result proof format below must stay identical to the client in server-control.ts.
import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

export function proof(secret, message) {
	return createHmac("sha256", secret).update(message).digest("hex");
}
function equalProof(actual, expected) {
	if (typeof actual !== "string" || !/^[a-f0-9]{64}$/.test(actual)) return false;
	return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

// One connection owns one fresh challenge. No command contains a PID or group ID.
export function controlSession(secret, stop) {
	let nonce;
	let used = false;
	return async message => {
		if (!nonce && message?.action === "hello" && typeof message.nonce === "string" && /^[a-f0-9]{64}$/.test(message.nonce)) {
			nonce = message.nonce;
			return { proof: proof(secret, `hello:${nonce}`) };
		}
		if (!nonce || used || message?.action !== "stop" || !equalProof(message.proof, proof(secret, `stop:${nonce}`))) throw new Error("Unverified control request");
		used = true;
		let error = "";
		try { await stop(); } catch (reason) { error = String(reason); }
		return { error, proof: proof(secret, `result:${nonce}:${error}`) };
	};
}

async function stat(pid) {
	try {
		const text = await readFile(`/proc/${pid}/stat`, "utf8");
		const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
		return { state: fields[0], group: Number(fields[2]), session: Number(fields[3]) };
	} catch (error) {
		if (error.code === "ENOENT" || error.code === "ESRCH") return null;
		throw error;
	}
}

export async function signalOwnGroup(self, readStat, signal) {
	const own = await readStat(self.pid);
	if (!own || own.group !== self.pid || own.session !== self.pid) throw new Error("Supervisor is not its session and group leader");
	// The caller is the live session and process-group leader at this syscall.
	// Its PID and group ID cannot be reused until it exits; if it exits before
	// the syscall, it cannot execute the signal. No recorded numeric ID is used.
	signal(-self.pid, "SIGTERM");
}

async function membersRemain(pid) {
	for (const name of await readdir("/proc")) {
		if (!/^\d+$/.test(name) || Number(name) === pid) continue;
		const member = await stat(Number(name));
		if (member && member.state !== "Z" && member.group === pid && member.session === pid) return true;
	}
	return false;
}

async function run() {
	let released = false, started = false, stopping = false, finished = false;
	let server;
	process.on("SIGTERM", () => {});
	const stop = async () => {
		if (stopping) throw new Error("Stop is already in progress");
		stopping = true;
		try {
			await signalOwnGroup(process, stat, process.kill.bind(process));
			const deadline = Date.now() + 5000;
			while (await membersRemain(process.pid)) {
				if (Date.now() >= deadline) throw new Error("Owned server did not stop after SIGTERM; ownership record retained");
				await new Promise(resolve => setTimeout(resolve, 50));
			}
			finished = true;
		} finally { stopping = false; }
	};
	const abort = async () => {
		if (!started) { server?.close(); process.exitCode = 1; return; }
		try { await stop(); server?.close(); } catch (error) { console.error(String(error)); }
	};
	process.on("disconnect", () => { if (!released) void abort(); });
	process.on("message", async message => {
		if (message?.action === "release") { released = true; return; }
		if (message?.action !== "launch" || server) return;
		const { secret, address, command, options } = message;
		server = createServer(socket => {
			const session = controlSession(secret, stop);
			let buffer = "", busy = false;
			socket.setEncoding("utf8");
			socket.setTimeout(8000, () => socket.destroy());
			socket.on("error", () => socket.destroy());
			socket.on("data", chunk => {
				buffer += chunk;
				if (buffer.length > 4096 || busy) { socket.destroy(); return; }
				const end = buffer.indexOf("\n");
				if (end < 0) return;
				const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
				busy = true;
				void (async () => {
					try {
						const result = await session(JSON.parse(line));
						if (finished) socket.end(`${JSON.stringify(result)}\n`, () => { server.close(); });
						else { busy = false; socket.write(`${JSON.stringify(result)}\n`); }
					} catch { socket.destroy(); }
				})();
			});
		});
		try {
			await new Promise((resolve, reject) => { server.once("error", reject); server.listen(`\0ui-capture-${address}`, resolve); });
			const child = spawn(command.shell ? command.command : command.argv[0], command.shell ? [] : command.argv.slice(1), {
				cwd: options.cwd, env: options.env, shell: command.shell, stdio: ["ignore", "inherit", "inherit"],
			});
			child.on("error", error => console.error(`Server launch failed: ${String(error)}`));
			await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
			started = true;
			if (!process.connected) { await abort(); return; }
			process.send({ action: "ready" });
		} catch (error) {
			console.error(String(error));
			if (process.connected) process.send({ action: "error", error: String(error) });
			await abort();
			if (process.connected) process.disconnect();
		}
	});
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void run();
