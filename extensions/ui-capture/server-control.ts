// Client side of the supervisor control protocol. The `hello:`/`stop:`/`result:` proof messages must stay
// identical to the server side in server-supervisor.mjs (legacy, not launched by HostServerRuntime).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createConnection } from "node:net";
import type { Identity } from "./server.ts";

type ControlConnection = { request(message: object): Promise<unknown>; close(): void };
type ConnectControl = (address: string) => Promise<ControlConnection>;

function proof(secret: string, message: string): string {
	return createHmac("sha256", secret).update(message).digest("hex");
}
function validProof(actual: unknown, expected: string): boolean {
	return typeof actual === "string" && /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

async function connectControl(address: string): Promise<ControlConnection> {
	const socket = createConnection(`\0ui-capture-${address}`);
	socket.setEncoding("utf8");
	let buffer = "";
	let pending: { resolve(value: unknown): void; reject(error: Error): void } | undefined;
	let failure: Error | undefined;
	const fail = (error: Error) => { failure = error; pending?.reject(error); pending = undefined; socket.destroy(); };
	socket.setTimeout(8000, () => fail(new Error("Supervisor control timed out")));
	socket.on("error", fail);
	socket.on("close", () => { if (!failure) fail(new Error("Supervisor control closed")); });
	socket.on("data", chunk => {
		buffer += chunk;
		if (buffer.length > 4096) { fail(new Error("Invalid supervisor response")); return; }
		const end = buffer.indexOf("\n");
		if (end < 0) return;
		if (!pending || end !== buffer.length - 1) { fail(new Error("Unexpected supervisor response")); return; }
		try { const response = JSON.parse(buffer.slice(0, end)); buffer = ""; const request = pending; pending = undefined; request.resolve(response); }
		catch { fail(new Error("Invalid supervisor response")); }
	});
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	return {
		request(message) {
			if (failure) return Promise.reject(failure);
			if (pending) return Promise.reject(new Error("Supervisor request already pending"));
			return new Promise((resolve, reject) => { pending = { resolve, reject }; socket.write(`${JSON.stringify(message)}\n`); });
		},
		close() { socket.destroy(); },
	};
}

export async function controlSupervisor(identity: Identity, action: "verify" | "stop", connect: ConnectControl = connectControl): Promise<void> {
	const control = identity.control;
	if (!control || !/^[a-f0-9]{32}$/.test(control.address) || !/^[a-f0-9]{64}$/.test(control.secret)) throw new Error("Unverified supervisor identity");
	const connection = await connect(control.address);
	try {
		const nonce = randomBytes(32).toString("hex");
		const hello = await connection.request({ action: "hello", nonce }) as { proof?: unknown };
		if (!hello || !validProof(hello.proof, proof(control.secret, `hello:${nonce}`))) throw new Error("Unverified supervisor response");
		if (action === "stop") {
			const result = await connection.request({ action: "stop", proof: proof(control.secret, `stop:${nonce}`) }) as { proof?: unknown; error?: unknown };
			if (!result || typeof result.error !== "string" || !validProof(result.proof, proof(control.secret, `result:${nonce}:${result.error}`))) throw new Error("Unverified supervisor result");
			if (result.error) throw new Error(result.error);
		}
	} finally { connection.close(); }
}
