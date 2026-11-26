import { existsSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { CaptureService } from "./capture.ts";
import { publishArtifact } from "./artifacts.ts";
import type { ServerRuntime } from "./server.ts";

const [root, spec, artifacts, action, marker, release, value, blockAt] = process.argv.slice(2);
async function gate() {
	await writeFile(marker, "ready");
	const deadline = Date.now() + 15000;
	while (!existsSync(release)) { if (Date.now() > deadline) throw new Error("fixture timed out"); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const runtime = { locked: async (_key: string, fn: () => Promise<unknown>) => fn(), now: () => Date.now(), probe: async () => ({ healthy: true, listener: true }) } as ServerRuntime;
const service = new CaptureService({ runtime, allowedCommands: [], artifacts, codec: () => ({ async decode(data) { return { width: 1, height: 1, data: Uint8Array.from([data[0], 0, 0, 255]) }; }, async encode(image) { return Buffer.from(image.data); } }), createDriver: async options => {
	const shots: Array<{ name: string; path: string; bounds: Record<string, never> }> = [];
	return {
		shots, consoleErrors: [], page: {},
		async perform() {
			const shot = { name: "full", path: `${options.phase}-full.png`, bounds: {} };
			await publishArtifact(options.outputDir, shot.path, value);
			if (marker !== "-" && blockAt !== "close") await gate();
			shots.push(shot); return value;
		},
		async inspect() { return []; }, async wait() {}, now: () => Date.now(), async screenshot() { throw new Error("unexpected screenshot"); }, async close() { if (blockAt === "close") await gate(); },
	} as any;
} });

const answers = { visible: true, conditions_match: true, only_difference_is_the_feature: true, same_target: true, preserved: [], note: "reviewed", get measurements() {
	if (++reads === 3 && marker !== "-") {
		writeFileSync(marker, "ready");
		const deadline = Date.now() + 15000;
		while (!existsSync(release)) { if (Date.now() > deadline) throw new Error("fixture timed out"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
	}
	return [];
} };
let reads = 0;
try {
	const result = action === "check" ? await service.check(root, spec, answers) : await service.run(root, spec, action as "before" | "after");
	process.send?.({ result });
} catch (error) { process.send?.({ error: error instanceof Error ? error.message : String(error) }); }
