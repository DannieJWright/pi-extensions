import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

export const OUTPUT_LIMIT = 64 * 1024;
export const TIMEOUT_MS = 10_000;
type Kind = "diff" | "status" | "log" | "show";
type Input = Record<string, unknown>;
type RunOptions = { cwd: string; signal?: AbortSignal; timeoutMs?: number; outputLimit?: number; executable?: string };

type ProcessResult = { text: string; code: number | null; truncated: boolean; cancelled: boolean; timedOut: boolean; error?: string };

// Keep Git's repository/config selection and pathspec interpretation independent of the caller's environment.
export async function runGit(args: string[], options: RunOptions): Promise<ProcessResult> {
 const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
 Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat", LC_ALL: "C" });
 const limit = options.outputLimit ?? OUTPUT_LIMIT;
 return new Promise((resolve) => {
  let child: ReturnType<typeof spawn>;
  try { child = spawn(options.executable ?? "git", ["--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "color.ui=false", "-c", "diff.external=", "-c", "log.showSignature=false", ...args], { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: false }); }
  catch (error) { resolve({ text: "", code: null, truncated: false, cancelled: false, timedOut: false, error: String(error) }); return; }
  const chunks: Buffer[] = []; let size = 0; let truncated = false; let cancelled = false; let timedOut = false; let error: string | undefined;
  const stop = () => { if (!child.killed) child.kill("SIGKILL"); };
  const abort = () => { cancelled = true; stop(); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? TIMEOUT_MS);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const collect = (chunk: Buffer) => { const remaining = Math.max(0, limit - size); if (remaining) chunks.push(chunk.subarray(0, remaining)); size += chunk.length; if (size > limit) { truncated = true; stop(); } };
  child.stdout!.on("data", collect); child.stderr!.on("data", collect);
  child.on("error", (e) => { error = e.message; });
  child.on("close", (code) => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); resolve({ text: stripVTControlCharacters(Buffer.concat(chunks).toString("utf8")).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""), code, truncated, cancelled, timedOut, error }); });
 });
}

function validate(kind: Kind, input: Input): { paths: string[]; refs: string[]; args: string[] } {
 if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected an argument object");
 const allowed = kind === "diff" ? ["mode", "from", "to", "paths"] : kind === "status" ? [] : kind === "log" ? ["ref", "limit", "paths"] : ["ref", "paths"];
 for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`Unknown parameter: ${key}`);
 const paths = input.paths === undefined ? [] : input.paths;
 if (!Array.isArray(paths) || paths.length > 100 || paths.some((p) => typeof p !== "string" || !p || p.length > 4096 || p.includes("\0"))) throw new Error("paths must be an array of at most 100 nonempty path strings");
 const refs: string[] = [];
 const ref = (value: unknown, name: string) => {
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes("..") || value.endsWith(".") || value.includes("//")) throw new Error(`Invalid ${name}: use a simple commit, branch, or tag name`);
  refs.push(value);
 };
 let args: string[] = [];
 if (kind === "diff") {
  const mode = input.mode ?? "unstaged";
  if (!["unstaged", "staged", "range"].includes(mode as string)) throw new Error("mode must be unstaged, staged, or range");
  if (mode === "range") { ref(input.from, "from"); ref(input.to, "to"); }
  else if (input.from !== undefined || input.to !== undefined) throw new Error("from and to are only valid for range diffs");
  args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", ...(mode === "staged" ? ["--cached"] : [])];
 } else if (kind === "status") args = ["status", "--porcelain=v1", "--branch", "--untracked-files=all"];
 else if (kind === "log") {
  if (input.ref !== undefined) ref(input.ref, "ref");
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new Error("limit must be an integer from 1 to 100");
  args = ["log", "--no-color", "--no-decorate", "--format=%H %s", `--max-count=${limit}`];
 } else { ref(input.ref, "ref"); args = ["show", "--no-ext-diff", "--no-textconv", "--no-color", "--format=fuller"]; }
 return { paths, refs, args };
}

export async function inspectGit(kind: Kind, input: Input, options: RunOptions) {
 try {
  const { paths, refs, args } = validate(kind, input);
  const hashes: string[] = [];
  for (const ref of refs) {
   const result = await runGit(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], options);
   if (result.code !== 0 || result.truncated || result.cancelled || result.timedOut || result.error) return report(result, `Could not resolve ref ${ref}`);
   hashes.push(result.text.trim());
  }
  const result = await runGit([...args, ...hashes, "--", ...paths], options);
  return report(result, "Git inspection");
 } catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], details: {}, isError: true }; }
}

function report(result: ProcessResult, label: string) {
 const notes = [result.truncated && "Output truncated at limit; process stopped.", result.timedOut && "Git timed out; process stopped.", result.cancelled && "Git cancelled; process stopped.", result.error && `Could not start Git: ${result.error}`, !result.truncated && result.code !== 0 && !result.timedOut && !result.cancelled && !result.error && `Git failed (exit ${result.code}).`].filter(Boolean);
 return { content: [{ type: "text" as const, text: `${label}:\n${result.text}${notes.length ? `\n[${notes.join(" ")}]` : ""}` }], details: { exitCode: result.code, truncated: result.truncated, timedOut: result.timedOut, cancelled: result.cancelled }, isError: !!(result.error || result.timedOut || result.cancelled || (!result.truncated && result.code !== 0)) };
}
