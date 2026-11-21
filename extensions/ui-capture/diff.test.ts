import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { diffScreenshots, withCanvasCodec, type ImageCodec, type Pixels, type ShotEvidence } from "./diff.ts";

test("canvas codec uses and closes an isolated context, forwarding bytes and pixels", async () => {
	const calls: unknown[] = [];
	const pixels = { width: 1, height: 1, data: [1, 2, 3, 4] };
	const isolatedPage = { evaluate: async (_fn: unknown, argument: unknown) => {
		calls.push(argument);
		return typeof argument === "string" ? pixels : Buffer.from("encoded mask").toString("base64");
	} };
	const context = { newPage: async () => isolatedPage, close: async () => { calls.push("close"); } };
	const browser = { newContext: async (...args: unknown[]) => { assert.deepEqual(args, []); calls.push("newContext"); return context; } };
	const page = { context: () => ({ browser: () => browser }), evaluate: () => assert.fail("application page must not be used") };
	await withCanvasCodec(page, async codec => {
		const image = await codec.decode(Buffer.from("png"));
		assert.deepEqual(image, { ...pixels, data: Uint8Array.from(pixels.data) });
		assert.deepEqual(await codec.encode(image), Buffer.from("encoded mask"));
	});
	assert.deepEqual(calls, ["newContext", Buffer.from("png").toString("base64"), pixels, "close"]);
});

test("canvas codec closes its isolated context on setup or comparison failure", async () => {
	let closed = 0;
	const context = { newPage: async () => ({}), close: async () => { closed++; } };
	const page = { context: () => ({ browser: () => ({ newContext: async () => context }) }) };
	await assert.rejects(withCanvasCodec(page, async () => { throw new Error("comparison failed"); }), /comparison failed/);
	context.newPage = async () => { throw new Error("page failed"); };
	await assert.rejects(withCanvasCodec(page, async () => assert.fail()), /page failed/);
	assert.equal(closed, 2);
	await assert.rejects(withCanvasCodec({ context: () => ({ browser: () => null }) }, async () => assert.fail()), /browser unavailable/);
});

// A failing close cannot replace the decoding or comparison failure, and one cause is never paired with an invented second one.
test("canvas codec reports both causes when the isolated context also fails to close", async () => {
	async function run(decoding?: string, cleanup?: string) {
		let closed = 0;
		const context = { newPage: async () => ({}), close: async () => { closed++; if (cleanup) throw new Error(cleanup); } };
		const page = { context: () => ({ browser: () => ({ newContext: async () => context }) }) };
		const error = await withCanvasCodec(page, async () => { if (decoding) throw new Error(decoding); }).catch((error: unknown) => error);
		return { error, closed };
	}
	const both = await run("decode failed", "isolated context close failed");
	assert.ok(both.error instanceof AggregateError);
	assert.deepEqual(both.error.errors.map(e => e.message), ["decode failed", "isolated context close failed"]);
	assert.equal(both.error.message, "decode failed; cleanup failed: isolated context close failed");
	assert.equal(both.closed, 1);
	for (const single of [{ decoding: "decode failed", expected: "decode failed" }, { cleanup: "isolated context close failed", expected: "isolated context close failed" }]) {
		const only = await run(single.decoding, single.cleanup);
		assert.ok(!(only.error instanceof AggregateError));
		assert.equal(only.error.message, single.expected);
		assert.equal(only.closed, 1);
	}
});

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
async function fixture(fn: (dir: string, codec: ImageCodec, masks: Pixels[]) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "capture-diff-")); const masks: Pixels[] = [];
	const images: Record<string, Pixels> = {
		before: { width: 4, height: 3, data: Uint8Array.from(Array.from({ length: 12 }, (_, i) => [i, 0, 0, 255]).flat()) },
		after: { width: 5, height: 3, data: Uint8Array.from(Array.from({ length: 15 }, () => [0, 0, 0, 255]).flat()) },
	};
	// Corresponding 2x2 crops move right one pixel; one pixel changes.
	for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) images.after.data[((y + 1) * 5 + x + 2) * 4] = images.before.data[((y + 1) * 4 + x + 1) * 4];
	images.after.data[(2 * 5 + 3) * 4] = 200;
	const codec: ImageCodec = { decode: async bytes => structuredClone(images[bytes.toString()]), encode: async image => { masks.push(image); return Buffer.from("mask"); } };
	try { for (const [file, value] of Object.entries({ "before-crop.png": "before", "after-crop.png": "after", "before-full.png": "before", "after-full.png": "after" })) await writeFile(join(dir, file), value); await fn(dir, codec, masks); }
	finally { await rm(dir, { recursive: true, force: true }); }
}
const shot = (phase: string, name: string, bounds: Record<string, any> = {}): ShotEvidence => ({ name, path: `${phase}-${name}.png`, bounds });
test("named cropped screenshots compare moved regions and write the mask in before coordinates", async () => fixture(async (dir, codec, masks) => {
	const before = [shot("before", "full"), shot("before", "crop", { region: box(1, 1, 2, 2) })];
	const after = [shot("after", "full"), shot("after", "crop", { region: box(2, 1, 2, 2) })];
	const result = await diffScreenshots({ dir, codec, before, after, diff: { screenshot: "crop", regions: { region: { target: "#region" } } } });
	// The reported hash is the content of the published mask file, which is what a later pair check verifies.
	assert.deepEqual(result, { screenshot: "crop", mask: "diff-crop.png", sha256: createHash("sha256").update(Buffer.from("mask")).digest("hex"), regions: { region: { before: box(1, 1, 2, 2), after: box(2, 1, 2, 2), moved: true, differing: 1, total: 4, percent: 25 } } });
	assert.equal(result.sha256, createHash("sha256").update(await readFile(join(dir, "diff-crop.png"))).digest("hex"));
	assert.equal(masks[0].width, 4); assert.equal(masks[0].height, 3);
	assert.deepEqual([...masks[0].data.slice((2 * 4 + 2) * 4, (2 * 4 + 2) * 4 + 4)], [255, 0, 0, 255]);
	assert.equal(masks[0].data.filter((_, i) => i % 4 === 3 && masks[0].data[i] === 255).length, 1);
	await assert.rejects(diffScreenshots({ dir, codec, before, after }), /screenshot is required/);
	await assert.rejects(diffScreenshots({ dir, codec, before, after, diff: { screenshot: "missing" } }), /named missing/);
}));
test("fixed regions and missing, out-of-bounds, and unequal selector crops fail clearly", async () => fixture(async (dir, codec) => {
	const before = [shot("before", "crop", { r: box(1, 1, 2, 2) })], after = [shot("after", "crop", { r: box(2, 1, 2, 2) })];
	const run = (regions: any) => diffScreenshots({ dir, codec, before, after, diff: { regions } });
	const fixed = await run({ fixed: [0, 0, 1, 1] }); assert.equal(fixed.regions.fixed.total, 1); assert.equal(fixed.mask, "diff.png");
	await assert.rejects(run({ absent: { target: "#missing" } }), /missing before region: absent/);
	after[0].bounds.r = null; await assert.rejects(run({ r: { target: "#r" } }), /missing after region/);
	after[0].bounds.r = box(4, 1, 2, 2); await assert.rejects(run({ r: { target: "#r" } }), /after region out of bounds/);
	after[0].bounds.r = box(2, 1, 1, 2); await assert.rejects(run({ r: { target: "#r" } }), /unequal crop dimensions/);
	await assert.rejects(run({ invalid: [-1, 0, 1, 1] }), /before region out of bounds/);
	await assert.rejects(diffScreenshots({ dir, codec, before, after }), /unequal crop dimensions for screenshot/);
}));
