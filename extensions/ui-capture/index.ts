import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { CaptureService } from "./capture.ts";

const schema = (properties: object, required: string[]) => ({ type: "object", properties, required, additionalProperties: false }) as unknown as TSchema;
const spec = { type: "string", description: "Capture spec path, relative to the Git root" };
const answers = { type: "object", properties: {
	visible: { type: "boolean" }, conditions_match: { type: "boolean" }, only_difference_is_the_feature: { type: "boolean" }, same_target: { type: "boolean" },
	preserved: { type: "array", items: { type: "string" } }, measurements: { type: "array", items: { type: "string" } }, note: { type: "string" },
}, required: ["visible", "conditions_match", "only_difference_is_the_feature", "same_target", "preserved", "measurements", "note"], additionalProperties: false };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function uiCapture(pi: ExtensionAPI): void {
	const service = new CaptureService();
	pi.on("session_start", async () => {
		pi.registerTool({
			name: "capture_server", label: "Capture server", executionMode: "sequential",
			description: "Start, stop, inspect or read logs from the capture server. External URL servers are never stopped.",
			parameters: schema({ action: { type: "string", enum: ["start", "stop", "status", "logs"] }, spec, tail: { type: "integer", minimum: 1 } }, ["action", "spec"]),
			async execute(_id, args, signal, _update, ctx) {
				try { const data = await service.server(ctx.cwd, args.action, args.spec, args.tail, signal); return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data }; }
				catch (error) { return { content: [{ type: "text", text: `capture_server: ${message(error)}` }], details: {}, isError: true }; }
			},
		});
		pi.registerTool({
			name: "capture_run", label: "Capture run", executionMode: "sequential",
			description: "Capture a before or after phase; returns the selected current screenshots and diff inline.",
			parameters: schema({ spec, phase: { type: "string", enum: ["before", "after"] }, build: { type: "string", description: "Optional build label" }, packageDirectory: { type: "string", minLength: 1, description: "Playwright package directory, relative to the Git root or absolute; defaults to server.cwd, then the Git root" } }, ["spec", "phase"]),
			async execute(_id, args, signal, _update, ctx) {
				try {
					const { images, ...data } = await service.run(ctx.cwd, args.spec, args.phase, args.build, signal, args.packageDirectory);
					const text = JSON.stringify({ image_paths: images.map(image => image.path), ...data }, null, 2);
					return { content: [{ type: "text", text: text.length > 24000 ? `${text.slice(0, 24000)}\n[Output truncated; full evidence is in sidecar.json.]` : text }, ...images.map(image => ({ type: "image" as const, data: image.data, mimeType: "image/png" }))], details: data, isError: !data.ok };
				} catch (error) { return { content: [{ type: "text", text: `capture_run: ${message(error)}` }], details: {}, isError: true }; }
			},
		});
		pi.registerTool({
			name: "capture_check", label: "Capture check", executionMode: "sequential",
			description: "Record a pair check only for current successful evidence. Force replaces an existing check for the same evidence.",
			parameters: schema({ spec, answers, force: { type: "boolean" } }, ["spec", "answers"]),
			async execute(_id, args, _signal, _update, ctx) {
				try { const data = await service.check(ctx.cwd, args.spec, args.answers, args.force); return { content: [{ type: "text", text: JSON.stringify(data.pair_check, null, 2) }], details: data.pair_check }; }
				catch (error) { return { content: [{ type: "text", text: `capture_check: ${message(error)}` }], details: {}, isError: true }; }
			},
		});
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		try { await service.shutdown(); } catch (error) { ctx.ui.notify(`ui-capture shutdown: ${message(error)}`, "warning"); }
	});
}
