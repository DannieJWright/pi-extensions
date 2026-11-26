import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { openArtifactDirectory, readArtifact } from "./artifacts.ts";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { diffScreenshots, withCanvasCodec, type DiffResult, type ImageCodec, type ShotEvidence } from "./diff.ts";
import { combineCleanupErrors, createDriver, gitRoot } from "./driver.ts";
import { CaptureServer, type Identity, type ServerRuntime } from "./server.ts";
import { HostServerRuntime } from "./server-runtime.ts";
import { buildPhase, checkPair, ignoredOutputWarning, publishSidecar, savePhase, validateCurrentPair, type PhaseName } from "./sidecar.ts";
import { parseSpec, type CaptureSpec } from "./spec.ts";
import { runSteps, type CaptureDriver, type StepsResult } from "./steps.ts";
import { redactUrl } from "./redact.ts";
import { readAllowedCommands } from "./trust.ts";

type Driver = CaptureDriver & { shots: ShotEvidence[]; consoleErrors: string[]; page: unknown; screenshot(value?: unknown): Promise<ShotEvidence>; close(): Promise<void> };
type Dependencies = { runtime?: ServerRuntime; allowedCommands?: string[]; createDriver?: typeof createDriver; codec?: (page: unknown) => ImageCodec; artifacts?: string };
type Input = { root: string; path: string; text: string; spec: CaptureSpec };
const errorText = (error: unknown) => redactUrl(error instanceof Error ? error.message : String(error));
const git = promisify(execFile);
// The recorded build state describes the project, not the active capture: its own artifact lock is held for the whole operation, so exactly that path is excluded here. Nothing else in the artifact directory is hidden, and an artifact directory outside the repository cannot appear in its status at all.
async function projectDirty(root: string, lockPath: string): Promise<boolean> {
	const args = ["status", "--porcelain"];
	const relativeLock = relative(root, lockPath);
	if (relativeLock && !isAbsolute(relativeLock) && !relativeLock.startsWith("..")) args.push("--", `:(exclude)${relativeLock}`);
	return (await git("git", args, { cwd: root })).stdout.trim() !== "";
}
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error("capture cancelled"); };
const emptyFailure = (message: string): StepsResult => ({ ok: false, outcomes: [], measured: {}, read: { error: message } });

export class CaptureService {
	private runtime: ServerRuntime;
	private deps: Dependencies;
	private owned = new Map<string, { root: string; path: string; identity: Identity }>();
	constructor(deps: Dependencies = {}) { this.deps = deps; this.runtime = deps.runtime ?? new HostServerRuntime(); }
	private async input(cwd: string, specPath: string): Promise<Input> {
		const root = await gitRoot(cwd), path = resolve(root, specPath), text = await readFile(path, "utf8");
		return { root, path, text, spec: parseSpec(text) };
	}
	private async manager(): Promise<CaptureServer> { return new CaptureServer(this.runtime, this.deps.allowedCommands ?? await readAllowedCommands()); }
	private async start(input: Input, signal?: AbortSignal) {
		cancelled(signal);
		const manager = await this.manager(), key = JSON.stringify([input.root, input.path]);
		const result = await manager.start(input.root, input.path, input.spec.server, identity => {
			this.owned.set(key, { root: input.root, path: input.path, identity });
		}, signal);
		cancelled(signal);
		return result;
	}
	async server(cwd: string, action: "start" | "stop" | "status" | "logs", specPath: string, tail?: number, signal?: AbortSignal): Promise<unknown> {
		const input = await this.input(cwd, specPath); cancelled(signal);
		if (action === "start") return this.start(input, signal);
		const manager = await this.manager();
		if (action === "stop") {
			const stopped = await manager.stop(input.root, input.path, input.spec.server);
			if (stopped) this.owned.delete(JSON.stringify([input.root, input.path]));
			return { stopped };
		}
		if (action === "status") return manager.status(input.root, input.path, input.spec.server, tail);
		if (action === "logs") return { logs: await manager.logs(input.root, input.path, input.spec.server, tail) };
		throw new Error(`Unknown server action: ${action}`);
	}
	async shutdown(): Promise<void> {
		const manager = await this.manager();
		const errors: string[] = [];
		for (const item of this.owned.values()) {
			try { await manager.stopIfOwned(item.root, item.path, item.identity); } catch (error) { errors.push(errorText(error)); }
		}
		this.owned.clear();
		if (errors.length) throw new Error(errors.join("; "));
	}
	private async directory(input: Input) { return openArtifactDirectory(input.root, input.spec, this.deps.artifacts ?? process.env.UI_CAPTURE_ARTIFACTS ?? "artifacts"); }
	async check(cwd: string, specPath: string, answers: unknown, force = false) {
		const input = await this.input(cwd, specPath);
		const directory = await this.directory(input);
		try { return await checkPair(directory, input.text, answers, force); } finally { await directory.close(); }
	}
	async run(cwd: string, specPath: string, phase: PhaseName, label?: string, signal?: AbortSignal, packageDirectory?: string) {
		if (phase !== "before" && phase !== "after") throw new Error("phase must be before or after");
		if (packageDirectory !== undefined && !packageDirectory) throw new Error("packageDirectory must be a non-empty path");
		const input = await this.input(cwd, specPath), directory = await this.directory(input), dir = directory;
		try {
			const hash = (await git("git", ["rev-parse", "--short", "HEAD"], { cwd: input.root })).stdout.trim();
			const dirty = await projectDirty(input.root, directory.lockPath);
			const build = `${hash}${dirty ? " dirty" : " clean"}${label ? ` (${label})` : ""}`;
			await savePhase({ dir, specText: input.text, phase, result: emptyFailure("capture started"), imageNames: [], build, url: "" });
			let driver: Driver | undefined, closing: Promise<void> | undefined, url = "", result: StepsResult = emptyFailure("capture failed");
			const close = () => closing ??= driver ? driver.close() : Promise.resolve();
			const abort = () => { void close().catch(() => {}); };
			let cleanupReported = false;
			try {
				const server = await this.start(input, signal); url = server.url;
				// The result url is redacted; the driver needs the configured external URL with any credentials.
				const baseUrl = typeof input.spec.server.url === "string" && !input.spec.server.start ? input.spec.server.url : server.url;
				driver = await (this.deps.createDriver ?? createDriver)({ root: input.root, spec: input.spec, baseUrl, outputDir: dir, phase, signal, packageDirectory }) as Driver;
				signal?.addEventListener("abort", abort, { once: true });
				cancelled(signal);
				const guarded: CaptureDriver = {
					perform: async (...args) => { cancelled(signal); const value = await driver!.perform(...args); cancelled(signal); return value; },
					inspect: async (...args) => { cancelled(signal); const value = await driver!.inspect(...args); cancelled(signal); return value; },
					wait: async ms => { cancelled(signal); await driver!.wait(ms); cancelled(signal); }, now: () => driver!.now(),
				};
				result = await runSteps(guarded, input.spec);
				cancelled(signal);
				if (result.ok && !input.spec.steps.some(step => step.verb === "screenshot")) await driver.screenshot();
				cancelled(signal);
				const shots = result.ok ? driver.shots : [];
				// The completed phase is published only after browser cleanup has succeeded, so a process interrupted before this point or a failed cleanup cannot leave approvable evidence.
				const sidecar = await buildPhase({ dir, specText: input.text, phase, result, imageNames: shots.map(shot => shot.path), build, url, consoleErrors: driver.consoleErrors, shots });
				let pair = false;
				try { await validateCurrentPair(sidecar, dir, input.spec); pair = true; } catch { /* No current complete pair yet. */ }
				let diff: DiffResult | undefined;
				if (pair) {
					const before = sidecar.phases.before!, after = sidecar.phases.after!;
					const beforeShots = before.shots, afterShots = after.shots;
					if (!beforeShots || !afterShots) throw new Error("Current pair lacks screenshot bounds");
					const compare = (codec: ImageCodec) => diffScreenshots({ dir, before: beforeShots, after: afterShots, diff: input.spec.diff, codec });
					// The recorded mask hash and the phase evidence it was computed from are what a later pair check verifies.
					diff = this.deps.codec ? await compare(this.deps.codec(driver.page)) : await withCanvasCodec(driver.page, compare);
					cancelled(signal);
					sidecar.diff = { conditions_match: true, ...diff, evidence: { before: before.evidence_id, after: after.evidence_id } };
				}
				const name = input.spec.diff?.screenshot;
				if (name !== undefined && (typeof name !== "string" || !name)) throw new Error("diff.screenshot must be a screenshot name");
				if (shots.length > 1 && !name) throw new Error("diff.screenshot is required when more than one screenshot exists");
				const images: Array<{ path: string; data: string }> = [];
				if (result.ok) {
					for (const evidence of pair ? [sidecar.phases.before!, sidecar.phases.after!] : [sidecar.phases[phase]!]) {
						const selected = evidence.shots?.filter(shot => name === undefined || shot.name === name) ?? [];
						if (selected.length !== 1 || !evidence.images.some(image => image.path === selected[0].path)) throw new Error("Selected screenshot is not current evidence");
						images.push({ path: selected[0].path, data: (await readArtifact(dir, selected[0].path)).toString("base64") });
					}
					if (diff) images.push({ path: diff.mask, data: (await readArtifact(dir, diff.mask)).toString("base64") });
				}
				const evidence = pair ? [sidecar.phases.before!, sidecar.phases.after!] : [sidecar.phases[phase]!];
				const files = ["capture.yaml", "sidecar.json", ...evidence.flatMap(item => item.images.map(image => image.path)), ...(diff ? [diff.mask] : [])];
				const response = { ok: result.ok, phase, dir: directory.dir, build, url, restarted: server.restarted ?? false, log: server.restarted ? server.logs : undefined, outcomes: result.outcomes, measured: result.measured, read: result.read, diff, warning: await ignoredOutputWarning(input.root, directory.dir, files), images };
				try { await close(); } catch (cleanupError) {
					cleanupReported = true;
					const failedStep = result.outcomes.find(outcome => !outcome.ok);
					if (failedStep) throw combineCleanupErrors(new Error(failedStep.error ?? "capture step failed"), cleanupError);
					throw cleanupError;
				}
				cancelled(signal);
				await publishSidecar(dir, input.text, sidecar);
				return response;
			} catch (error) {
				let failure = error;
				if (driver && !cleanupReported) {
					try { await close(); } catch (cleanupError) { failure = combineCleanupErrors(error, cleanupError); }
				}
				// When this write fails the last published record still reports the run as incomplete, so it cannot be approved.
				try { await savePhase({ dir, specText: input.text, phase, result: result.ok ? emptyFailure(errorText(failure)) : { ...result, read: { ...result.read, error: errorText(failure) } }, imageNames: [], build, url, consoleErrors: driver?.consoleErrors }); } catch (writeError) { failure = combineCleanupErrors(failure, writeError); }
				throw failure;
			} finally { signal?.removeEventListener("abort", abort); }
		} finally { await directory.close(); }
	}
}
