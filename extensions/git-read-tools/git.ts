import { spawn } from "node:child_process";
import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

export const OUTPUT_LIMIT = 64 * 1024;
export const TIMEOUT_MS = 10_000;
type Kind = "diff" | "status" | "log" | "show";
type Input = Record<string, unknown>;
// What report() needs to build its header: the caller's working directory, the resolved run directory, and the
// top level. top stays undefined until the discovery lookup resolves one, so a bare repository or a directory in
// no repository gets the run-directory part alone. Nothing is shown when nothing differs.
type ReportScope = { cwd: string; target: string; top?: string };
type RunOptions = { cwd: string; signal?: AbortSignal; timeoutMs?: number; outputLimit?: number; executable?: string };

type ProcessResult = { text: string; stdout: string; stderr: string; code: number | null; truncated: boolean; cancelled: boolean; timedOut: boolean; error?: string };

// Keep Git's repository/config selection and pathspec interpretation independent of the caller's environment.
export async function runGit(args: string[], options: RunOptions): Promise<ProcessResult> {
 return runGitProcess(args, options);
}

async function runGitProcess(args: string[], options: RunOptions, onStdout?: (chunk: Buffer) => void): Promise<ProcessResult> {
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
  child.stdout!.on("data", onStdout ?? collect(stdout)); child.stderr!.on("data", collect(stderr));
  child.on("error", (e) => { error = e.message; });
  child.on("close", (code) => finish(code));
  if (options.signal?.aborted) abort();
 });
}

// Parse NUL-delimited index records without retaining paths or the complete index.
export function createSubmoduleIndexParser() {
 let header = "", inPath = false, pathLength = 0, invalid = false, hasSubmodule = false;
 return {
  write(chunk: Buffer) {
   for (const byte of chunk) {
    if (inPath) {
     if (byte === 0) { if (!pathLength) invalid = true; inPath = false; pathLength = 0; }
     else pathLength = 1;
    } else if (byte === 9) {
     if (!/^(?:100644|100755|120000|160000) (?:[0-9a-f]{40}|[0-9a-f]{64}) [0-3]$/.test(header)) invalid = true;
     if (header.startsWith("160000 ")) hasSubmodule = true;
     header = ""; inPath = true;
    } else if (byte === 0 || header.length >= 80 || byte > 127) invalid = true;
    else header += String.fromCharCode(byte);
   }
  },
  finish() { return { invalid: invalid || inPath || header.length > 0, hasSubmodule }; },
 };
}

async function scanSubmodules(cdup: string, options: RunOptions) {
 const parser = createSubmoduleIndexParser();
 const result = await runGitProcess(["ls-files", "--stage", "--full-name", "-z", "--", ...(cdup ? [cdup] : [])], options, parser.write);
 return { result, ...parser.finish() };
}

// Fails closed on the discovery lookup's output shape: one absolute path, or the chain of ".." segments that is the prefix from the run directory to the top level (empty at the top level itself, and accepting either Git's "../" form or the derived ".." form). clean() keeps tab and newline, so these patterns reject them as well.
const ROOT_PATH = /^(?:[A-Za-z]:)?[\\/][^\x00-\x1f\x7f]*$/;
const PREFIX_CHAIN = /^(?:\.\.\/?)*$/;
// Over-limit keeps its own wording because a truncated-but-successful lookup proves Git found a repository; reporting no-repository-found there would be wrong.
const ROOT_OVER_LIMIT = "Working-tree inspection refused: repository root check exceeded output limit.";
const UNEXPECTED_ROOT_OUTPUT = "Could not locate repository root: unexpected Git output";
// A bare repository has no top level, so the lookup answers with this fatal instead of printing one. Working-tree commands report the same fatal there, so it is matched as a stable substring only, never as a full sentence.
const WORK_TREE_FATAL = /must be run in a work tree/i;

// Nothing is auto-selected when discovery fails: the caller gets candidates for the dir parameter and re-issues. Candidates are immediate children that contain .git as a directory or file; dotfiles count, symlinks are not followed, and the depth limit is one level. Names come from fs.readdir, so they bypass clean(); names containing control characters or newlines are quoted rather than stripped, because stripping makes two different names collide. Candidate detection costs no Git invocation, so each name is an unverified hint: a stale gitfile answers with `fatal: invalid gitfile format: <path>`, exit 128, when the caller runs an inspection there.
const CANDIDATE_SCAN_LIMIT = 50;
const CANDIDATE_REPORT_LIMIT = 20;
const NEEDS_QUOTING = /[\x00-\x1f\x7f-\x9f]/;
// Byte-wise order as defined by the plan. For valid scalar values UTF-8 byte order equals code-point order, so this matches JS default sort; fixture names are restricted to ASCII.
const byteCompare = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
const quoteName = (name: string) => NEEDS_QUOTING.test(name) ? JSON.stringify(name) : name;

// Collect all candidate names first, then sort, then truncate. The scan cap counts every entry read, including entries skipped because they are symlinks or not directories.
async function scanCandidates(target: string) {
 const entries = await readdir(target, { withFileTypes: true }).catch(() => null);
 if (!entries) return { names: [], capped: false };
 const names: string[] = [];
 for (const entry of entries.slice(0, CANDIDATE_SCAN_LIMIT)) {
  if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
  // lstat keeps a symlinked .git from being counted through its target, consistent with not following symlinks.
  const marker = await lstat(path.join(target, entry.name, ".git")).catch(() => null);
  if (marker && (marker.isDirectory() || marker.isFile())) names.push(entry.name);
 }
 return { names: names.sort(byteCompare).slice(0, CANDIDATE_REPORT_LIMIT), capped: entries.length > CANDIDATE_SCAN_LIMIT };
}

// Built as a report() note so Git's own wording, content and details stay intact.
function noRepositoryNote(target: string, candidates: { names: string[]; capped: boolean }) {
 const limits = ["immediate children only", `at most ${CANDIDATE_SCAN_LIMIT} entries scanned${candidates.capped ? `, stopped at that limit` : ""}`, `first ${CANDIDATE_REPORT_LIMIT} reported sorted byte-wise`].join(", ");
 const parts = [`No repository found from ${target}.`, `Pass the "dir" parameter with a directory inside a Git repository or linked worktree.`, `Candidates under this directory (${limits}): ${candidates.names.map(quoteName).join(", ") || "none"}.`];
 if (candidates.names.length) parts.push("Some candidates may not resolve.");
 return parts.join(" ");
}

// Confirming bareness costs an extra invocation, so it runs only after a lookup failed with that fatal. It fails closed on the shape like the lookup above: anything other than exactly true falls back to reporting the failed lookup as no repository found.
async function confirmBare(options: RunOptions) {
 const result = await runGit(["rev-parse", "--is-bare-repository"], options);
 return !result.truncated && result.code === 0 && !result.cancelled && !result.timedOut && !result.error && result.stdout.trim() === "true";
}

// validate() stays synchronous: it resolves dir against the caller's working directory but does not check that it exists, because that is a validation-stage rejection answered by the plain catch path before any header can be built. The existence and directory-type check belongs in inspectGit, which also builds the ReportScope report() needs.
function validate(kind: Kind, input: Input, options: RunOptions): { dir: string; paths: string[]; refs: string[]; args: string[] } {
 if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected an argument object");
 const allowed = kind === "diff" ? ["mode", "from", "to", "paths", "dir"] : kind === "status" ? ["dir"] : kind === "log" ? ["ref", "limit", "paths", "dir"] : ["ref", "paths", "dir"];
 for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`Unknown parameter: ${key}`);
 // Through a tool call the schema maxLength answers first, so an over-long value never reaches this check; direct calls are rejected here with the same rule.
 if (input.dir !== undefined && (typeof input.dir !== "string" || !input.dir || input.dir.length > 4096 || input.dir.includes("\0"))) throw new Error("dir must be a nonempty path string of at most 4096 characters");
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
 return { dir: path.resolve(options.cwd, input.dir ?? "."), paths, refs, args };
}

export async function inspectGit(kind: Kind, input: Input, options: RunOptions) {
 try {
  const { dir, paths, refs, args } = validate(kind, input, options);
  // Compared after normalising, so a trailing separator or an unnormalised path in the caller's cwd does not make a header appear where nothing differs.
  const scope: ReportScope = { cwd: path.resolve(options.cwd), target: dir };
  // A passed dir may itself be a symlink that resolves to a directory; candidate children under it are never followed. lstat is used on the target so a symlink is identified as one instead of being reported by its target's type.
  const link = await lstat(dir).catch(() => null);
  const linked = !!link?.isSymbolicLink();
  const type = linked ? await stat(dir).catch(() => null) : link;
  if (!type?.isDirectory()) throw new Error(`dir must exist and be a directory: ${dir}`);
  const runAt = { ...options, cwd: dir };
  // One bounded discovery lookup runs before anything else, for every kind, so target selection does not depend on which kind needs a working tree. Its result also feeds the submodule scan below instead of a second call.
  const root = await runGit(["rev-parse", "--show-toplevel"], runAt);
  if (root.truncated) throw new Error(ROOT_OVER_LIMIT);
  // Anomalies on this lookup — timeout, cancellation, spawn failure, any non-zero exit — go under the no-repository label, except the work-tree fatal, which is how a bare repository answers. A bare repository has no top level to resolve or print, but log and show still work there, so that case is confirmed before the label is used.
  let bare = false, prefix = "";
  if (root.code !== 0 || root.cancelled || root.timedOut || root.error) {
   if (!(WORK_TREE_FATAL.test(root.text) && await confirmBare(runAt))) return report(root, "Could not locate repository root", scope, [noRepositoryNote(dir, await scanCandidates(dir))]);
   bare = true;
  } else {
   const top = root.stdout.trim();
   if (!ROOT_PATH.test(top)) throw new Error(UNEXPECTED_ROOT_OUTPUT);
   scope.top = top;
   // Prefix for the submodule scan. Deriving it compares the run directory against the physical top level, which is wrong when the target was reached through a symlink: measured on Git 2.53.0 --show-toplevel printed the physical path while --show-cdup printed "../" from the same run directory. So derive only for a direct target and ask Git otherwise, which costs one more invocation. Git reports the physical path, so the two derivations are not equivalent in all cases.
   if (linked) {
    const cdup = await runGit(["rev-parse", "--show-cdup"], runAt);
    if (cdup.truncated) throw new Error(ROOT_OVER_LIMIT);
    if (cdup.code !== 0 || cdup.cancelled || cdup.timedOut || cdup.error) return report(cdup, "Could not locate repository root", scope);
    prefix = cdup.stdout.trim();
   } else {
    prefix = path.relative(dir, top);
   }
   if (!PREFIX_CHAIN.test(prefix)) throw new Error(UNEXPECTED_ROOT_OUTPUT);
  }
  // Worktree comparisons and status can run repository-configured clean/process filters.
  // Refuse rather than silently produce an unfiltered, misleading comparison.
  if (kind === "status" || (kind === "diff" && (input.mode === undefined || input.mode === "unstaged"))) {
   const filters = await runGit(["config", "--get-regexp", "^filter\\."], runAt);
   if (filters.truncated) throw new Error("Working-tree inspection refused: filter configuration check exceeded output limit.");
   if (filters.code !== 1 || filters.cancelled || filters.timedOut || filters.error) {
    if (filters.code === 0 && !filters.cancelled && !filters.timedOut && !filters.error) throw new Error("Working-tree inspection refused: repository config contains filter drivers.");
    return report(filters, "Could not check repository filter configuration", scope);
   }
   // In a bare repository ls-files --stage returns empty output with exit 0, which cannot be read as success, so this scan is skipped there. The kinds that need a working tree reach Git's own fatal instead.
   if (!bare) {
    // Git may inspect a submodule's working tree using that repository's filters.
    // Check the whole superproject index even when called from a subdirectory, using the prefix above.
    const index = await scanSubmodules(prefix, runAt);
    if (index.result.truncated) throw new Error("Working-tree inspection refused: submodule check exceeded output limit.");
    if (index.result.code !== 0 || index.result.cancelled || index.result.timedOut || index.result.error) return report(index.result, "Could not check repository submodules", scope);
    if (index.invalid) throw new Error("Working-tree inspection refused: unexpected submodule check output.");
    if (index.hasSubmodule) throw new Error("Working-tree inspection refused: index contains submodules, whose filters cannot be safely checked.");
   }
  }
  const hashes: string[] = [];
  for (const ref of refs) {
   const result = await runGit(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], runAt);
   if (result.code !== 0 || result.truncated || result.cancelled || result.timedOut || result.error) return report(result, `Could not resolve ref ${ref}`, scope);
   const hash = result.stdout.trim();
   if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)) throw new Error(`Could not resolve ref ${ref}: unexpected Git output`);
   hashes.push(hash);
  }
  const result = await runGit([...args, ...hashes, "--", ...paths], runAt);
  return report(result, "Git inspection", scope);
 } catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], details: {}, isError: true }; }
}

// The header names the run directory and the repository top level only when either differs from the caller's working directory, so the ordinary case keeps the plain label and byte-for-byte output.
function report(result: ProcessResult, label: string, scope: ReportScope, extraNotes: string[] = []) {
 const differs = scope.target !== scope.cwd || (scope.top !== undefined && scope.top !== scope.cwd);
 const header = `${label}${differs ? ` (run directory ${scope.target}${scope.top ? `, repository ${scope.top}` : ""})` : ""}`;
 // Anomaly notes come first, then the guidance for the dir parameter, in the order the caller acts on them.
 const notes = [result.truncated && "Output truncated at limit; process stopped.", result.timedOut && "Git timed out; process stopped.", result.cancelled && "Git cancelled; process stopped.", result.error && `Could not start Git: ${result.error}`, !result.truncated && result.code !== 0 && !result.timedOut && !result.cancelled && !result.error && `Git failed (exit ${result.code}).`, ...extraNotes].filter(Boolean);
 return { content: [{ type: "text" as const, text: `${header}:\n${result.text}${notes.length ? `\n[${notes.join(" ")}]` : ""}` }], details: { exitCode: result.code, truncated: result.truncated, timedOut: result.timedOut, cancelled: result.cancelled }, isError: !!(result.error || result.timedOut || result.cancelled || (!result.truncated && result.code !== 0)) };
}
