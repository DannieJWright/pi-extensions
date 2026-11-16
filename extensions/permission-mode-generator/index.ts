// Pi extension: run the generator at startup and on /reload, then report the result.
// The factory runs before any session_start, so pi-permission-modes reads the file this extension writes.

import { defaultPaths, formatResult, run } from "./generate.ts";

type Notify = (message: string, level?: "info" | "warning" | "error") => void;

interface SessionStartContext {
	hasUI: boolean;
	ui?: { notify: Notify };
}

interface ExtensionApi {
	on(event: "session_start", handler: (event: unknown, ctx: SessionStartContext) => void | Promise<void>): void;
}

export default async function (pi: ExtensionApi): Promise<void> {
	const result = run({ ...defaultPaths, action: "gen", force: false });
	const report = formatResult(result, defaultPaths);

	pi.on("session_start", async (_event, ctx) => {
		if (!report) return;
		if (ctx.hasUI && ctx.ui) {
			ctx.ui.notify(report, result.status === "error" ? "error" : "info");
		} else {
			process.stderr.write(`${report}\n`);
		}
	});
}
