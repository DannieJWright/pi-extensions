#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { CaptureService } from "./capture.ts";

const usage = "Usage: node extensions/ui-capture/cli.ts server <start|stop|status|logs> <spec> [tail] | run <before|after> <spec> [build] [--package-directory <dir>] | check <spec> <answers.json> [--force]";
export async function main(args: string[], cwd = process.cwd(), service = new CaptureService()): Promise<unknown> {
	const [command, ...rest] = args;
	if (command === "server") {
		const [action, spec, rawTail, ...extra] = rest;
		if (!spec || !["start", "stop", "status", "logs"].includes(action) || extra.length || (rawTail !== undefined && (!/^\d+$/.test(rawTail) || !["status", "logs"].includes(action)))) throw new Error(usage);
		return service.server(cwd, action as "start" | "stop" | "status" | "logs", spec, rawTail === undefined ? undefined : Number(rawTail));
	}
	if (command === "run") {
		const [phase, spec, ...options] = rest;
		if (!spec || (phase !== "before" && phase !== "after")) throw new Error(usage);
		let build: string | undefined, packageDirectory: string | undefined;
		for (let i = 0; i < options.length; i++) {
			if (options[i] === "--package-directory") {
				const value = options[++i];
				if (packageDirectory !== undefined || !value || value === "--package-directory") throw new Error(usage);
				packageDirectory = value;
			} else if (build === undefined) build = options[i];
			else throw new Error(usage);
		}
		const { images, ...result } = await service.run(cwd, spec, phase, build, undefined, packageDirectory);
		if (!result.ok) throw new Error(JSON.stringify(result));
		return { ...result, images: images.map(image => image.path) };
	}
	if (command === "check") {
		const [spec, path, force, ...extra] = rest;
		if (!spec || !path || (force !== undefined && force !== "--force") || extra.length) throw new Error(usage);
		const result = await service.check(cwd, spec, JSON.parse(await readFile(path, "utf8")), force === "--force");
		return result.pair_check;
	}
	throw new Error(usage);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2)), error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
