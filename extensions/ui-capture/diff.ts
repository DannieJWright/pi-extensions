import { createHash } from "node:crypto";
import { publishArtifact, readArtifact, type ArtifactLocation } from "./artifacts.ts";
import { basename } from "node:path";
import { safeComponent } from "./spec.ts";
import { combineCleanupErrors } from "./driver.ts"; // driver imports these types only, so this stays one-way
import type { Box } from "./steps.ts";

export type ShotEvidence = { name?: string; path: string; bounds: Record<string, Box | null> };
export type Pixels = { width: number; height: number; data: Uint8Array };
export type ImageCodec = { decode(png: Buffer): Promise<Pixels>; encode(image: Pixels): Promise<Buffer> };
export type RegionDiff = { before: Box; after: Box; moved: boolean; differing: number; total: number; percent: number };
// The mask is reported with the content hash of the bytes actually published, so a later pair check
// can verify that the file on disk is still the mask this result describes.
export type DiffResult = { screenshot?: string; mask: string; sha256: string; regions: Record<string, RegionDiff> };
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

// A fresh browser context has neither the application's CSP nor its init scripts or storage.
// Keep the canvas in Chromium rather than adding a host PNG dependency.
export async function withCanvasCodec<T>(page: any, use: (codec: ImageCodec) => Promise<T>): Promise<T> {
	const browser = page.context().browser();
	if (!browser) throw new Error("capture browser unavailable for image diff");
	const context = await browser.newContext();
	// A failing close must not replace the decoding or comparison failure, so both causes are reported as the driver reports them.
	let result: T;
	try { result = await use(canvasCodec(await context.newPage())); }
	catch (error) {
		try { await context.close(); } catch (cleanupError) { throw combineCleanupErrors(error, cleanupError); }
		throw error;
	}
	await context.close();
	return result;
}
function canvasCodec(page: any): ImageCodec {
	return {
		async decode(png) {
			const image = await page.evaluate(async (base64: string) => {
				const img = new Image(); img.src = `data:image/png;base64,${base64}`; await img.decode();
				const canvas = document.createElement("canvas"); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
				const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("canvas context unavailable");
				ctx.drawImage(img, 0, 0); return { width: canvas.width, height: canvas.height, data: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data) };
			}, png.toString("base64"));
			return { ...image, data: Uint8Array.from(image.data) };
		},
		async encode(image) {
			const base64 = await page.evaluate(({ width, height, data }: { width: number; height: number; data: number[] }) => {
				const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
				const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("canvas context unavailable");
				ctx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
				return canvas.toDataURL("image/png").split(",")[1];
			}, { width: image.width, height: image.height, data: Array.from(image.data) });
			return Buffer.from(base64, "base64");
		},
	};
}
function choose(shots: ShotEvidence[], name: string | undefined, phase: string): ShotEvidence {
	if (!shots.length) throw new Error(`no ${phase} screenshots`);
	if (shots.length > 1 && !name) throw new Error("diff.screenshot is required when more than one screenshot exists");
	const found = name === undefined ? shots : shots.filter(shot => shot.name === name);
	if (found.length !== 1) throw new Error(`expected one ${phase} screenshot${name ? ` named ${name}` : ""}`);
	const shot = found[0];
	if (basename(shot.path) !== shot.path || !shot.path.endsWith(".png")) throw new Error(`invalid screenshot path: ${shot.path}`);
	return shot;
}
function validatePixels(image: Pixels): void {
	if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width <= 0 || image.height <= 0 || image.data.length !== image.width * image.height * 4) throw new Error("invalid decoded screenshot pixels");
}
function bounds(value: unknown, image: Pixels, region: string, phase: string): Box {
	const b = Array.isArray(value) && value.length === 4 ? { x: value[0], y: value[1], width: value[2], height: value[3] } : value as Box | null;
	if (!b) throw new Error(`missing ${phase} region: ${region}`);
	if (![b.x, b.y, b.width, b.height].every(Number.isSafeInteger) || b.x < 0 || b.y < 0 || b.width <= 0 || b.height <= 0 || b.x + b.width > image.width || b.y + b.height > image.height) throw new Error(`${phase} region out of bounds: ${region}`);
	return { x: b.x, y: b.y, width: b.width, height: b.height };
}

// Masks cover the entire before screenshot; red opaque pixels mark differences in the
// before crop's coordinates, and all other pixels are transparent. Named masks are diff-<name>.png.
export async function diffScreenshots(options: { dir: ArtifactLocation; before: ShotEvidence[]; after: ShotEvidence[]; diff?: Record<string, unknown>; codec: ImageCodec }): Promise<DiffResult> {
	const config = options.diff ?? {};
	if (config.screenshot !== undefined && (typeof config.screenshot !== "string" || !config.screenshot)) throw new Error("diff.screenshot must be a screenshot name");
	const name = config.screenshot as string | undefined;
	if (name) safeComponent(name, "diff screenshot name");
	const beforeShot = choose(options.before, name, "before"), afterShot = choose(options.after, name, "after");
	const before = await options.codec.decode(await readArtifact(options.dir, beforeShot.path));
	const after = await options.codec.decode(await readArtifact(options.dir, afterShot.path));
	validatePixels(before); validatePixels(after);
	let regions = config.regions;
	if (regions === undefined) {
		if (before.width !== after.width || before.height !== after.height) throw new Error("unequal crop dimensions for screenshot");
		regions = { screenshot: [0, 0, before.width, before.height] };
	}
	if (!regions || typeof regions !== "object" || Array.isArray(regions) || !Object.keys(regions).length) throw new Error("diff.regions must be a non-empty mapping");
	const mask: Pixels = { width: before.width, height: before.height, data: new Uint8Array(before.width * before.height * 4) };
	const result: Record<string, RegionDiff> = {};
	for (const [region, definition] of Object.entries(regions)) {
		const isFixed = Array.isArray(definition);
		if (!isFixed && (!definition || typeof definition !== "object" || typeof (definition as Record<string, unknown>).target !== "string")) throw new Error(`invalid diff region: ${region}`);
		const b = bounds(isFixed ? definition : beforeShot.bounds[region], before, region, "before");
		const a = bounds(isFixed ? definition : afterShot.bounds[region], after, region, "after");
		if (b.width !== a.width || b.height !== a.height) throw new Error(`unequal crop dimensions for region: ${region}`);
		let differing = 0;
		for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
			const bi = ((b.y + y) * before.width + b.x + x) * 4, ai = ((a.y + y) * after.width + a.x + x) * 4;
			if ([0, 1, 2, 3].some(c => before.data[bi + c] !== after.data[ai + c])) { differing++; mask.data.set([255, 0, 0, 255], bi); }
		}
		const total = b.width * b.height;
		result[region] = { before: b, after: a, moved: b.x !== a.x || b.y !== a.y, differing, total, percent: 100 * differing / total };
	}
	const maskName = `diff${name ? `-${name}` : ""}.png`;
	const png = await options.codec.encode(mask);
	await publishArtifact(options.dir, maskName, png);
	return { ...(name ? { screenshot: name } : {}), mask: maskName, sha256: digest(png), regions: result };
}
