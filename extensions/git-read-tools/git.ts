import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

export const OUTPUT_LIMIT = 64 * 1024;
export const TIMEOUT_MS = 10_000;
type Kind = "diff" | "status" | "log" | "show";
type Input = Record<string, unknown>;
type RunOptions = { cwd: string; signal?: AbortSignal; timeoutMs?: number; outputLimit?: number; executable?: string };

type ProcessResult = { text: string; stdout: string; stderr: string; code: number | null; truncated: boolean; cancelled: boolean; timedOut: boolean; error?: string };

// Keep Git's repository/config selection and pathspec interpretation independent of the caller's environment.
export async function runGit(args: string[], options: RunOptions): Promise<ProcessResult> {
 const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
 Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat", LC_ALL: "C" });
 const limit = options.outputLimit ?? OUTPUT_LIMIT;
 return new Promise((resolve) => {
  let child: ReturnType<typeof spawn>;
  try { child = spawn(options.executable ?? "git", ["--no-lazy-fetch", "--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "color.ui=false", "-c", "diff.external=", "-c", "log.showSignature=false", ...args], { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: false, detached: process.platform !== "win32" }); }
  catch (error) { resolve({ text: "", stdout: "", stderr: "", code: null, truncated: false, cancelled: false, timedOut: false, error: String(error) }); return; }
  const chunks: Buffer[] = [], stdout: Buffer[] = [], stderr: Buffer[] = [];
  let size = 0, truncated = false, cancelled = false, timedOut = false, settled = false;
  let error: string | undefined;
  const clean = (parts: Buffer[]) => stripVTControlCharacters(Buffer.concat(parts).toString("utf8")).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  const finish = (code: number | null) => {
   if (settled) return;
   settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
   resolve({ text: clean(chunks), stdout: clean(stdout), stderr: clean(stderr), code, truncated, cancelled, timedOut, error });
  };
  const stop = () => {
   // Kill the POSIX process group and close pipes even if a descendant escaped it.
   if (process.platform !== "win32" && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }
   else child.kill("SIGKILL");
   child.stdout?.destroy(); child.stderr?.destroy(); finish(null);
  };
  const abort = () => { cancelled = true; stop(); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? TIMEOUT_MS);
  options.signal?.addEventListener("abort", abort, { once: true });
  const collect = (target: Buffer[]) => (chunk: Buffer) => {
   const remaining = Math.max(0, limit - size);
   if (remaining) { const part = chunk.subarray(0, remaining); chunks.push(part); target.push(part); }
   size += chunk.length; if (size > limit) { truncated = true; stop(); }
  };
  child.stdout!.on("data", collect(stdout)); child.stderr!.on("data", collect(stderr));
  child.on("error", (e) => { error = e.message; });
  child.on("close", (code) => finish(code));
  if (options.signal?.aborted) abort();
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
  const mode = input.mode === undefined ? "unstaged" : input.mode;
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
 } else { ref(input.ref, "ref"); args = ["show", "--no-ext-diff", "--no-textconv", "--no-color", "--format=fuller", "--first-parent", "-m"]; }
 return { paths, refs, args };
}

export async function inspectGit(kind: Kind, input: Input, options: RunOptions) {
 try {
  const { paths, refs, args } = validate(kind, input);
  // Worktree comparisons and status can run repository-configured clean/process filters.
  // Refuse rather than silently produce an unfiltered, misleading comparison.
  if (kind === "status" || (kind === "diff" && (input.mode === undefined || input.mode === "unstaged"))) {
   const filters = await runGit(["config", "--get-regexp", "^filter\\."], options);
   if (filters.truncated) throw new Error("Working-tree inspection refused: filter configuration check exceeded output limit.");
   if (filters.code !== 1 || filters.cancelled || filters.timedOut || filters.error) {
    if (filters.code === 0 && !filters.cancelled && !filters.timedOut && !filters.error) throw new Error("Working-tree inspection refused: repository config contains filter drivers.");
    return report(filters, "Could not check repository filter configuration");
   }
   // Git may inspect a submodule's working tree using that repository's filters.
   // Check the whole superproject index even when called from a subdirectory.
   const root = await runGit(["rev-parse", "--show-cdup"], options);
   if (root.truncated) throw new Error("Working-tree inspection refused: repository root check exceeded output limit.");
   if (root.code !== 0 || root.cancelled || root.timedOut || root.error) return report(root, "Could not locate repository root");
   const cdup = root.stdout.trim();
   if (cdup && !/^(?:\.\.\/)+$/.test(cdup)) throw new Error("Could not locate repository root: unexpected Git output");
   const index = await runGit(["ls-files", "--stage", "--full-name", "--", ...(cdup ? [cdup] : [])], options);
   if (index.truncated) throw new Error("Working-tree inspection refused: submodule check exceeded output limit.");
   if (index.code !== 0 || index.cancelled || index.timedOut || index.error) return report(index, "Could not check repository submodules");
   if (/^160000 [0-9a-f]+ [0-3]\t/m.test(index.stdout)) throw new Error("Working-tree inspection refused: index contains submodules, whose filters cannot be safely checked.");
  }
  const hashes: string[] = [];
  for (const ref of refs) {
   const result = await runGit(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], options);
   if (result.code !== 0 || result.truncated || result.cancelled || result.timedOut || result.error) return report(result, `Could not resolve ref ${ref}`);
   const hash = result.stdout.trim();
   if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)) throw new Error(`Could not resolve ref ${ref}: unexpected Git output`);
   hashes.push(hash);
  }
  const result = await runGit([...args, ...hashes, "--", ...paths], options);
  return report(result, "Git inspection");
 } catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], details: {}, isError: true }; }
}

function report(result: ProcessResult, label: string) {
 const notes = [result.truncated && "Output truncated at limit; process stopped.", result.timedOut && "Git timed out; process stopped.", result.cancelled && "Git cancelled; process stopped.", result.error && `Could not start Git: ${result.error}`, !result.truncated && result.code !== 0 && !result.timedOut && !result.cancelled && !result.error && `Git failed (exit ${result.code}).`].filter(Boolean);
 return { content: [{ type: "text" as const, text: `${label}:\n${result.text}${notes.length ? `\n[${notes.join(" ")}]` : ""}` }], details: { exitCode: result.code, truncated: result.truncated, timedOut: result.timedOut, cancelled: result.cancelled }, isError: !!(result.error || result.timedOut || result.cancelled || (!result.truncated && result.code !== 0)) };
}
