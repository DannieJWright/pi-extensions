import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubmoduleIndexParser, inspectGit, runGit } from "./git.ts";
import extension from "./index.ts";

function git(cwd: string, ...args: string[]) { return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" }, encoding: "utf8" }).trim(); }
async function fixture(fn: (dir: string) => Promise<void>) {
 const dir = await mkdtemp(join(tmpdir(), "git-read-tools-"));
 try { git(dir, "init", "-q"); await writeFile(join(dir, "space name"), "first\n"); await writeFile(join(dir, "-dash"), "dash\n"); git(dir, "add", "--", "."); git(dir, "commit", "-qm", "first"); await fn(dir); }
 finally { await rm(dir, { recursive: true, force: true }); }
}
function text(result: Awaited<ReturnType<typeof inspectGit>>) { return result.content[0].text; }
// The first line report() builds: the plain label, or the label with the run directory and top level when either differs.
// Comparing this line exactly lets a test assert both that the header appears and that it does not.
function headerLine(result: Awaited<ReturnType<typeof inspectGit>>) { return text(result).split("\n")[0]; }
// The candidate names report() appends when nothing resolves. Asserting them as one exact string proves byte-wise order rather than membership.
function listedNames(result: Awaited<ReturnType<typeof inspectGit>>) {
 const match = text(result).match(/Candidates under this directory \([^)]*\): (.+?)(?:\. Some candidates may not resolve)?\.\]/);
 assert.ok(match, text(result));
 return match[1];
}
// The worktree records report() appends when another registered worktree exists. Asserting them as one exact string proves porcelain order rather than membership or sorting.
function listedWorktrees(result: Awaited<ReturnType<typeof inspectGit>>) {
 const match = text(result).match(/which lists the main working tree first: (.+?)\. Nothing was auto-selected/);
 assert.ok(match, text(result));
 return match[1];
}
// Live porcelain order is the expected value here, because Git's own record order cannot be assumed from creation order.
function porcelainRecords(cwd: string) { return git(cwd, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9)); }
// Runs one kind and returns the result. `base` is not named `dir` because `dir` is a tool argument.
// Limitation: the helper derives the git dir by running Git at `base`, so index immutability can only be
// checked when `base` is itself inside a repository. For a target outside any repository, assert content only
// and route the index checks through a `base` that is inside one. Extra RunOptions are forwarded to
// inspectGit as-is; without them the run directory stays `base`.
async function unchanged(base: string, kind: Parameters<typeof inspectGit>[0], args: Record<string, unknown> = {}, options?: Parameters<typeof inspectGit>[2]) {
 const before = git(base, "status", "--porcelain=v1", "--untracked-files=all"); const index = await readFile(join(git(base, "rev-parse", "--absolute-git-dir"), "index"));
 const result = await inspectGit(kind, args, { cwd: base, ...options });
 assert.equal(git(base, "status", "--porcelain=v1", "--untracked-files=all"), before); assert.deepEqual(await readFile(join(git(base, "rev-parse", "--absolute-git-dir"), "index")), index);
 return result;
}

test("tool registration has strict typed schemas and child cwd", async () => fixture(async (dir) => {
 const tools: any[] = []; extension({ registerTool(tool: any) { tools.push(tool); } } as any);
 assert.deepEqual(tools.map((t) => t.name), ["git_r_diff", "git_r_status", "git_r_log", "git_r_show"]);
 assert.ok(tools.every((t) => t.parameters.additionalProperties === false && t.description));
 // Every definition carries the shared optional run directory.
 assert.ok(tools.every((t) => t.parameters.properties.dir?.type === "string" && t.parameters.properties.dir.maxLength === 4096 && t.description.includes("dir")));
 const result = await tools[1].execute("id", {}, undefined, undefined, { cwd: dir }); assert.match(text(result), /##/);
}));

test("diff, status, log and show inspect literal paths and ranges without index changes", async () => fixture(async (dir) => {
 const first = git(dir, "rev-parse", "HEAD");
 assert.doesNotMatch(text(await unchanged(dir, "status")), /\?\?/);
 await writeFile(join(dir, "space name"), "second\n"); git(dir, "add", "--", "space name"); await writeFile(join(dir, "-dash"), "changed\n"); await writeFile(join(dir, "untracked"), "new");
 assert.match(text(await unchanged(dir, "status")), /\?\? untracked/);
 assert.match(text(await unchanged(dir, "diff", { mode: "staged", paths: ["space name"] })), /second/);
 assert.match(text(await unchanged(dir, "diff", { paths: ["-dash"] })), /changed/);
 assert.doesNotMatch(text(await unchanged(dir, "diff", { paths: [":(glob)*"] })), /changed/);
 git(dir, "add", "--", "-dash"); git(dir, "commit", "-qm", "second");
 assert.match(text(await unchanged(dir, "diff", { mode: "range", from: first, to: "HEAD", paths: ["-dash"] })), /changed/);
 const log = await unchanged(dir, "log", { limit: 1, ref: "HEAD", paths: ["space name"] }); assert.match(text(log), /second/); assert.doesNotMatch(text(log), /first/);
 assert.match(text(await unchanged(dir, "show", { ref: "HEAD", paths: ["-dash"] })), /changed/);
}));

test("reject injection and invalid inputs and report Git errors", async () => fixture(async (dir) => {
 for (const [kind, args] of [["show", { ref: "--help" }], ["show", { ref: "HEAD;touch-pwn" }], ["diff", { mode: "range", from: "HEAD", to: "HEAD~1" }], ["log", { limit: 101 }], ["status", { flags: "--help" }], ["diff", { paths: ["\0"] }]] as const) assert.equal((await unchanged(dir, kind, args)).isError, true);
 const bad = await unchanged(dir, "show", { ref: "missing-ref" }); assert.equal(bad.isError, true); assert.match(text(bad), /Could not resolve ref/);
 const maliciousPath = "$(touch PWNED);--output=oops"; await writeFile(join(dir, maliciousPath), "old\n"); git(dir, "add", "--", maliciousPath); git(dir, "commit", "-qm", "literal path"); await writeFile(join(dir, maliciousPath), "new\n");
 assert.match(text(await unchanged(dir, "diff", { paths: [maliciousPath] })), /new/); await assert.rejects(readFile(join(dir, "PWNED")), { code: "ENOENT" });
 const outside = await mkdtemp(join(tmpdir(), "git-outside-")); try { const r = await inspectGit("status", {}, { cwd: outside }); assert.equal(r.isError, true); assert.match(text(r), /not a git repository/); } finally { await rm(outside, { recursive: true, force: true }); }
}));

test("linked worktree and external diff, textconv, fsmonitor helpers remain disabled", async () => fixture(async (dir) => {
 const parent = await mkdtemp(join(tmpdir(), "git-worktree-")); const worktree = join(parent, "tree");
 try {
  git(dir, "worktree", "add", "-qb", "linked-test", worktree);
  const marker = join(parent, "ran");
  git(worktree, "config", "core.fsmonitor", `touch ${marker}`); git(worktree, "config", "diff.evil.command", `touch ${marker}`); git(worktree, "config", "diff.evil.textconv", `touch ${marker}`); git(worktree, "config", "diff.external", `touch ${marker}`);
  await writeFile(join(worktree, ".gitattributes"), "* diff=evil\n"); await writeFile(join(worktree, "-dash"), "new\n");
  assert.match(text(await unchanged(worktree, "diff")), /new/); assert.equal((await unchanged(worktree, "status")).isError, false);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
 } finally { git(dir, "worktree", "remove", "--force", worktree); await rm(parent, { recursive: true, force: true }); }
}));

test("worktree inspection refuses configured clean and process filters", async () => fixture(async (dir) => {
 const marker = join(dir, "filter-ran");
 await writeFile(join(dir, ".gitattributes"), "* filter=evil\n");
 await writeFile(join(dir, "-dash"), "changed\n");
 git(dir, "config", "filter.evil.clean", `touch ${marker}; cat`);
 git(dir, "diff"); await readFile(marker); await rm(marker);
 for (const [kind, args] of [["diff", {}], ["status", {}]] as const) {
  const result = await inspectGit(kind, args, { cwd: dir });
  assert.equal(result.isError, true); assert.match(text(result), /refused.*filter drivers/);
 }
 const nullMode = await inspectGit("diff", { mode: null }, { cwd: dir });
 assert.equal(nullMode.isError, true); assert.match(text(nullMode), /mode must be unstaged, staged, or range/);
 // Discovery runs before the filter preflight, so an over-limit value is reached through the root lookup.
 const limited = await inspectGit("diff", {}, { cwd: dir, outputLimit: 1 });
 assert.equal(limited.isError, true); assert.match(text(limited), /repository root check exceeded/);
 assert.equal((await inspectGit("diff", { mode: "staged" }, { cwd: dir })).isError, false);
 await assert.rejects(readFile(marker), { code: "ENOENT" });
 git(dir, "config", "--unset", "filter.evil.clean");
 git(dir, "config", "filter.evil.process", `touch ${marker}; cat`);
 assert.equal((await inspectGit("diff", {}, { cwd: dir })).isError, true);
 await assert.rejects(readFile(marker), { code: "ENOENT" });
}));

test("large index is scanned without truncation, including for a single-path diff", async () => fixture(async (dir) => {
 await mkdir(join(dir, "many"));
 await Promise.all(Array.from({ length: 1400 }, (_, i) => writeFile(join(dir, "many", `ordinary-file-${String(i).padStart(4, "0")}.txt`), "old\n")));
 await writeFile(join(dir, "many", "tab\tand\nnewline"), "old\n");
 git(dir, "add", "--", "many"); git(dir, "commit", "-qm", "large index");
 assert.ok(Buffer.byteLength(git(dir, "ls-files", "--stage")) > 64 * 1024);
 const status = await inspectGit("status", {}, { cwd: dir });
 assert.equal(status.isError, false); assert.match(text(status), /##/);
 const path = `many/ordinary-file-${String(42).padStart(4, "0")}.txt`; await writeFile(join(dir, path), "new content\n");
 const diff = await inspectGit("diff", { mode: "unstaged", paths: [path] }, { cwd: dir });
 assert.equal(diff.isError, false); assert.match(text(diff), /new content/);
 git(dir, "update-index", "--add", "--cacheinfo", `160000,${git(dir, "rev-parse", "HEAD")},zz-submodule`);
 const guarded = await inspectGit("diff", { paths: [path] }, { cwd: dir });
 assert.equal(guarded.isError, true); assert.match(text(guarded), /refused: index contains submodules/);
}));

test("submodule index parser handles arbitrary chunk boundaries and fails closed", () => {
 const hash = "a".repeat(40), hash256 = "b".repeat(64);
 const ordinary = `100644 ${hash} 0\tname-🦊\twith\ncontrols\0`;
 const submodule = `160000 ${hash} 0\tsubmodule/🦊\0`;
 const cases = [
  { name: "empty index", data: "", invalid: false, hasSubmodule: false },
  { name: "ordinary records and submodule", data: `${ordinary}100755 ${hash256} 3\texecutable\0${submodule}120000 ${hash} 1\tlink\0`, invalid: false, hasSubmodule: true },
  { name: "ordinary records only", data: `${ordinary}120000 ${hash} 2\tlink\0`, invalid: false, hasSubmodule: false },
  { name: "invalid mode", data: `100600 ${hash} 0\tpath\0`, invalid: true, hasSubmodule: false },
  { name: "invalid hash", data: `100644 ${"g".repeat(40)} 0\tpath\0`, invalid: true, hasSubmodule: false },
  { name: "invalid stage", data: `100644 ${hash} 4\tpath\0`, invalid: true, hasSubmodule: false },
  { name: "empty path", data: `100644 ${hash} 0\t\0${ordinary}`, invalid: true, hasSubmodule: false },
  { name: "unterminated path", data: `100644 ${hash} 0\tpath`, invalid: true, hasSubmodule: false },
  { name: "unterminated header after submodule", data: `${submodule}100644 ${hash}`, invalid: true, hasSubmodule: true },
  { name: "NUL in header", data: `100644\0 ${hash} 0\tpath\0`, invalid: true, hasSubmodule: false },
  { name: "non-ASCII header", data: `100644 ${hash} 0é\tpath\0`, invalid: true, hasSubmodule: false },
  { name: "oversized header", data: `${"x".repeat(81)}\tpath\0`, invalid: true, hasSubmodule: false },
  { name: "malformed submodule header", data: `160000 bad 0\tpath\0`, invalid: true, hasSubmodule: true },
 ];
 for (const { name, data, invalid, hasSubmodule } of cases) {
  const bytes = Buffer.from(data), expected = { invalid, hasSubmodule };
  // Every pair of boundaries splits headers, delimiters and path bytes, including UTF-8 bytes.
  for (let first = 0; first <= bytes.length; first++) for (let second = first; second <= bytes.length; second++) {
   const parser = createSubmoduleIndexParser();
   parser.write(bytes.subarray(0, first)); parser.write(bytes.subarray(first, second)); parser.write(bytes.subarray(second));
   assert.deepEqual(parser.finish(), expected, `${name}: boundaries ${first}, ${second}`);
  }
  const parser = createSubmoduleIndexParser();
  for (const byte of bytes) parser.write(Buffer.from([byte]));
  assert.deepEqual(parser.finish(), expected, `${name}: one byte per chunk`);
 }
});

test("submodule scan fails closed on malformed output, errors, timeout and cancellation", async () => fixture(async (dir) => {
 const script = join(dir, "fake-git");
 // Only ls-files is intercepted here, so the discovery lookup falls through to real Git inside the fixture repository and these expectations still reach the submodule branch.
 const writeScript = (body: string) => writeFile(script, `#!/bin/sh\ncase " $* " in\n *" ls-files "*) ${body} ;;\n *) exec git "$@" ;;\nesac\n`, { mode: 0o755 });
 for (const [body, expected] of [
  ["printf 'garbage'; exit 0", /unexpected submodule check output/],
  ["printf '100644 bad 0\\tpath\\000'; exit 0", /unexpected submodule check output/],
  ["echo failed >&2; exit 2", /Could not check repository submodules:[\s\S]*failed/],
  ["head -c 200 /dev/zero | tr '\\000' x >&2; exit 0", /submodule check exceeded output limit/],
  ["sleep 2", /Git timed out/],
 ] as const) {
  await writeScript(body);
  const result = await inspectGit("status", {}, { cwd: dir, executable: script, timeoutMs: 300, outputLimit: 100 });
  assert.equal(result.isError, true); assert.match(text(result), expected);
 }
 await writeScript("touch scan-started; sleep 2");
 const controller = new AbortController();
 const pending = inspectGit("status", {}, { cwd: dir, executable: script, signal: controller.signal });
 for (let i = 0; i < 100; i++) {
  try { await readFile(join(dir, "scan-started")); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
 }
 await readFile(join(dir, "scan-started")); controller.abort();
 const cancelled = await pending; assert.equal(cancelled.isError, true); assert.match(text(cancelled), /Git cancelled/);
}));

test("discovery lookup runs first and owns its anomaly labels against the filter preflight", async () => fixture(async (dir) => {
 const script = join(dir, "fake-git");
 // The script answers the lookup itself so these branches are reached through it. Fixture names stay short because these cases use outputLimit: 100.
 const writeScript = (body: string) => writeFile(script, `#!/bin/sh\ncase " $* " in\n *" rev-parse --show-toplevel "*) ${body} ;;\n *" config "*) echo 'filter.evil.clean touch ran'; exit 0 ;;\n *) exec git "$@" ;;\nesac\n`, { mode: 0o755 });
 for (const [body, expected] of [
  ["printf '/'; head -c 120 /dev/zero | tr '\\000' a; exit 0", /^Working-tree inspection refused: repository root check exceeded output limit\./],
  ["echo 'fatal: not a git repository' >&2; exit 128", /^Could not locate repository root:[\s\S]*not a git repository/],
  ["echo failed >&2; exit 2", /^Could not locate repository root:[\s\S]*failed/],
  ["printf 'garbage'; exit 0", /Could not locate repository root: unexpected Git output/],
  ["sleep 2", /^Could not locate repository root:[\s\S]*Git timed out/],
 ] as const) {
  await writeScript(body);
  const result = await inspectGit("status", {}, { cwd: dir, executable: script, timeoutMs: 300, outputLimit: 100 });
  assert.equal(result.isError, true); assert.match(text(result), expected);
  // The configured filter would have answered with its own label, so reaching the root label proves the lookup runs before the preflight.
  assert.doesNotMatch(text(result), /filter configuration|filter drivers/);
 }
 // A truncated-but-successful lookup keeps its own wording rather than no-repository-found: that is the first case above.
 // With the same configured filter, the filter label is reachable only when discovery succeeds.
 await writeScript('exec git "$@"');
 const afterDiscovery = await inspectGit("status", {}, { cwd: dir, executable: script, timeoutMs: 300, outputLimit: 100 });
 assert.equal(afterDiscovery.isError, true); assert.match(text(afterDiscovery), /refused.*filter drivers/);
 // Kinds with no working-tree need resolve the target first as well.
 await writeScript("echo 'fatal: not a git repository' >&2; exit 128");
 for (const [kind, args] of [["log", {}], ["show", { ref: "HEAD" }]] as const) {
  const result = await inspectGit(kind, args, { cwd: dir, executable: script, timeoutMs: 300, outputLimit: 100 });
  assert.equal(result.isError, true); assert.match(text(result), /^Could not locate repository root:/);
 }
 await writeScript("touch lookup-started; sleep 2");
 const controller = new AbortController();
 const pending = inspectGit("status", {}, { cwd: dir, executable: script, signal: controller.signal });
 for (let i = 0; i < 100; i++) {
  try { await readFile(join(dir, "lookup-started")); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
 }
 await readFile(join(dir, "lookup-started")); controller.abort();
 const cancelled = await pending;
 assert.equal(cancelled.isError, true); assert.match(text(cancelled), /^Could not locate repository root:[\s\S]*Git cancelled/);
 // Spawn failure follows the separate precedent in the output-cap test, and is reported under the same label.
 const failedSpawn = await inspectGit("status", {}, { cwd: dir, executable: join(dir, "missing") });
 assert.equal(failedSpawn.isError, true); assert.match(text(failedSpawn), /^Could not locate repository root:[\s\S]*Could not start Git/);
}));

test("submodule scan reuses the discovery lookup result instead of calling --show-cdup again", async () => fixture(async (dir) => {
 const script = join(dir, "fake-git");
 await writeFile(script, `#!/bin/sh\ncase " $* " in\n *" --show-cdup "*) echo 'unexpected second root call' >&2; exit 7 ;;\n *) exec git "$@" ;;\nesac\n`, { mode: 0o755 });
 // A submodule record makes the prefix observable: a wrong prefix scopes ls-files away from it.
 git(dir, "update-index", "--add", "--cacheinfo", `160000,${git(dir, "rev-parse", "HEAD")},zz-submodule`);
 await mkdir(join(dir, "nested"));
 const fromSubdirectory = await unchanged(dir, "status", {}, { cwd: join(dir, "nested"), executable: script });
 assert.equal(fromSubdirectory.isError, true); assert.match(text(fromSubdirectory), /index contains submodules/);
}));

test("a symlinked target falls back to --show-cdup for the prefix because Git reports the physical top level", async () => fixture(async (dir) => {
 git(dir, "update-index", "--add", "--cacheinfo", `160000,${git(dir, "rev-parse", "HEAD")},zz-submodule`);
 await mkdir(join(dir, "nested"));
 const outer = await mkdtemp(join(tmpdir(), "sym-outer-"));
 try {
  await symlink(join(dir, "nested"), join(outer, "link"));
  // Deriving the prefix here would compare the symlink path against the physical top level and fail closed. The fallback asks Git, so the scan still covers the whole superproject index.
  const throughLink = await unchanged(dir, "status", { dir: join(outer, "link") }, { cwd: outer });
  assert.equal(throughLink.isError, true); assert.match(text(throughLink), /index contains submodules/);
 } finally { await rm(outer, { recursive: true, force: true }); }
}));

test("dirty submodule status and diff do not execute submodule clean filters", async () => fixture(async (dir) => {
 const source = await mkdtemp(join(tmpdir(), "git-submodule-source-"));
 try {
  git(source, "init", "-q"); await writeFile(join(source, "file"), "first\n"); git(source, "add", "."); git(source, "commit", "-qm", "first");
  git(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "child"); git(dir, "commit", "-qm", "submodule");
  const child = join(dir, "child"), marker = join(source, "filter-ran");
  await writeFile(join(child, ".gitattributes"), "* filter=evil\n"); await writeFile(join(child, "file"), "other\n");
  git(child, "config", "filter.evil.clean", `touch ${marker}; cat`);
  for (const kind of ["status", "diff"] as const) {
   await rm(marker, { force: true }); git(dir, kind); assert.ok(await readFile(marker), `raw git ${kind} should execute the filter`); await rm(marker);
   const result = await inspectGit(kind, {}, { cwd: dir });
   assert.equal(result.isError, true); assert.match(text(result), /refused: index contains submodules/);
   await assert.rejects(readFile(marker), { code: "ENOENT" });
  }
  await mkdir(join(dir, "nested"));
  for (const [kind, args] of [["status", {}], ["diff", {}], ["diff", { mode: "unstaged", paths: ["-dash"] }]] as const) {
   for (const cwd of [dir, join(dir, "nested")]) {
    const result = await inspectGit(kind, args, { cwd });
    assert.equal(result.isError, true); assert.match(text(result), /refused: index contains submodules/);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
   }
  }
  for (const [kind, args] of [["diff", { mode: "staged" }], ["diff", { mode: "range", from: "HEAD", to: "HEAD" }], ["log", {}], ["show", { ref: "HEAD" }]] as const) {
   const result = await inspectGit(kind, args, { cwd: dir });
   assert.equal(result.isError, false, text(result));
   await assert.rejects(readFile(marker), { code: "ENOENT" });
  }
 } finally { await rm(source, { recursive: true, force: true }); }
}));

test("missing promisor objects do not trigger lazy fetch", async () => fixture(async (dir) => {
 const blob = git(dir, "rev-parse", "HEAD:space name");
 const marker = join(dir, "fetch-ran");
 git(dir, "config", "remote.origin.url", `ext::touch ${marker}`);
 git(dir, "config", "remote.origin.promisor", "true");
 git(dir, "config", "remote.origin.partialclonefilter", "blob:none");
 git(dir, "config", "protocol.ext.allow", "always");
 await rm(join(dir, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
 assert.throws(() => git(dir, "show", "HEAD")); await readFile(marker); await rm(marker);
 const result = await inspectGit("show", { ref: "HEAD" }, { cwd: dir });
 assert.equal(result.isError, true);
 await assert.rejects(readFile(marker), { code: "ENOENT" });
 await assert.rejects(readFile(join(dir, ".git", "objects", blob.slice(0, 2), blob.slice(2))), { code: "ENOENT" });
}));

test("show renders merge changes relative to first parent", async () => fixture(async (dir) => {
 git(dir, "checkout", "-qb", "side"); await writeFile(join(dir, "side-file"), "side change\n"); git(dir, "add", "."); git(dir, "commit", "-qm", "side");
 git(dir, "checkout", "-q", "-"); await writeFile(join(dir, "main-file"), "main change\n"); git(dir, "add", "."); git(dir, "commit", "-qm", "main");
 git(dir, "merge", "--no-ff", "-qm", "merge", "side");
 const result = await inspectGit("show", { ref: "HEAD" }, { cwd: dir });
 assert.equal(result.isError, false); assert.match(text(result), /side change/); assert.doesNotMatch(text(result), /main change/);
}));

test("ambiguous ref warnings do not corrupt the resolved hash", async () => fixture(async (dir) => {
 git(dir, "branch", "ambiguous"); git(dir, "tag", "ambiguous");
 const result = await inspectGit("show", { ref: "ambiguous" }, { cwd: dir });
 assert.equal(result.isError, false); assert.match(text(result), /first/);
}));

test("dir values are rejected like the other scalar arguments through the plain catch path", async () => fixture(async (base) => {
 // Omitting dir keeps the passed working directory as the run directory.
 assert.match(text(await unchanged(base, "status")), /^## /m);
 for (const bad of ["", "\0", "x".repeat(4097), 5]) {
  // A tool call answers at the schema maxLength first, so an over-long value never reaches git.ts; calling inspectGit directly reaches validate().
  const result = await unchanged(base, "show", { ref: "HEAD", dir: bad });
  assert.equal(result.isError, true); assert.match(text(result), /dir must be a nonempty path string/);
 }
 // dir is in the allowed key lists, so an unknown parameter alongside it is still the reported problem.
 const unknown = await unchanged(base, "status", { dir: ".", flags: "--help" });
 assert.equal(unknown.isError, true); assert.match(text(unknown), /Unknown parameter: flags/);
 // Nonexistent and non-directory targets are validation-stage rejections: no label and no header.
 await writeFile(join(base, "plain-file"), "x\n");
 for (const target of [join(base, "no-such-directory"), join(base, "plain-file")]) {
  const result = await unchanged(base, "status", { dir: target });
  assert.equal(result.isError, true); assert.match(text(result), /dir must exist and be a directory/);
  assert.doesNotMatch(text(result), /^(Could not locate repository root|Git inspection):/);
 }
}));

test("dir selects the run directory relative to the working directory, accepts absolute paths outside the session subtree, and follows only the target itself when it is a symlink", async () => {
 const parent = await mkdtemp(join(tmpdir(), "git-dir-outer-"));
 try {
  const main = join(parent, "A");
  await mkdir(main); git(main, "init", "-q"); await writeFile(join(main, "space name"), "first\n"); git(main, "add", "--", "."); git(main, "commit", "-qm", "subject A");
  const outside = await mkdtemp(join(tmpdir(), "git-dir-outside-"));
  try {
   git(outside, "init", "-q"); await writeFile(join(outside, "other file"), "x\n"); git(outside, "add", "--", "."); git(outside, "commit", "-qm", "subject B");
   // The plain parent is not a repository, so a successful call proves the relative value resolved against its cwd.
   const relative = await unchanged(main, "log", { dir: "A", limit: 1 }, { cwd: parent });
   assert.equal(relative.isError, false, text(relative)); assert.match(text(relative), /subject A/); assert.doesNotMatch(text(relative), /subject B/);
   const absolute = await unchanged(main, "log", { dir: main }, { cwd: outside });
   assert.equal(absolute.isError, false, text(absolute)); assert.match(text(absolute), /subject A/); assert.doesNotMatch(text(absolute), /subject B/);
   // The passed target may itself be a symlink that resolves to a directory; children under it are not followed.
   await symlink(main, join(parent, "link-to-A"));
   const throughLink = await unchanged(main, "log", { dir: "link-to-A", limit: 1 }, { cwd: parent });
   assert.equal(throughLink.isError, false, text(throughLink)); assert.match(text(throughLink), /subject A/);
   await symlink(join(main, "space name"), join(parent, "file-link"));
   const notDirectory = await inspectGit("status", { dir: join(parent, "file-link") }, { cwd: parent });
   assert.equal(notDirectory.isError, true); assert.match(text(notDirectory), /dir must exist and be a directory/);
  } finally { await rm(outside, { recursive: true, force: true }); }
 } finally { await rm(parent, { recursive: true, force: true }); }
});

test("the report header names the run directory and top level only when either differs from the caller working directory", async () => fixture(async (dir) => {
 const statusArgs = ["status", "--porcelain=v1", "--branch", "--untracked-files=all"];
 // Nothing differs here: the label stays plain and the body is byte-for-byte what the same call produced through runGit
 // at the same directory. No guidance note exists in this state, so the whole text is compared as it stands.
 assert.equal(text(await unchanged(dir, "status")), `Git inspection:\n${(await runGit(statusArgs, { cwd: dir })).text}`);
 assert.equal(headerLine(await unchanged(dir, "log", { limit: 1 })), "Git inspection:");
 const top = git(dir, "rev-parse", "--show-toplevel");
 // Only the repository differs: the run directory equals the caller working directory while the top level does not.
 await mkdir(join(dir, "nested"));
 const nested = join(dir, "nested");
 assert.equal(headerLine(await unchanged(dir, "status", {}, { cwd: nested })), `Git inspection (run directory ${nested}, repository ${top}):`);
 // Only the run directory differs: the target resolves to its own repository reached through dir from a plain parent
 // outside any repository. Both parts are shown because nothing about the resolved repository matches the caller.
 const parent = await mkdtemp(join(tmpdir(), "header-parent-"));
 try {
  const main = join(parent, "A");
  await mkdir(main); git(main, "init", "-q"); await writeFile(join(main, "file"), "x\n"); git(main, "add", "--", "."); git(main, "commit", "-qm", "subject A");
  assert.equal(headerLine(await unchanged(main, "log", { dir: "A", limit: 1 }, { cwd: parent })), `Git inspection (run directory ${main}, repository ${git(main, "rev-parse", "--show-toplevel")}):`);
  // A dir that resolves to the caller working directory is no difference at all, so the header stays absent.
  assert.equal(headerLine(await unchanged(main, "log", { dir: ".", limit: 1 }, { cwd: main })), "Git inspection:");
  // When no top level resolves, only the run-directory part appears. The notes still reach report() through the header path.
  const plainChild = join(parent, "plain-child");
  await mkdir(plainChild);
  const unresolved = await inspectGit("status", { dir: "plain-child" }, { cwd: parent });
  assert.equal(unresolved.isError, true);
  assert.equal(headerLine(unresolved), `Could not locate repository root (run directory ${plainChild}):`);
  assert.match(text(unresolved), /not a git repository/);
  // report() puts its own anomaly notes first, then the guidance for the dir parameter, so the bracket holds both. An empty target has no candidates, which is reported as none.
  assert.match(text(unresolved), /\[Git failed \(exit 128\)\. No repository found from [^\n]* Candidates under this directory \([^)]*\): none\.\]/);
  assert.deepEqual(unresolved.details, { exitCode: 128, truncated: false, timedOut: false, cancelled: false });
 } finally { await rm(parent, { recursive: true, force: true }); }
}));

test("failed discovery keeps Git wording, names the dir parameter, states the depth limit, lists candidates, and does not auto-select", async () => {
 // These assertions stay inside their own temp parent because upward discovery consults ancestors of it; the test tmpdir is assumed outside any repository, as elsewhere in this file.
 const parent = await mkdtemp(join(tmpdir(), "candidate-parent-"));
 try {
  const main = join(parent, "A");
  await mkdir(main); git(main, "init", "-q");
  await writeFile(join(main, "space name"), "first\n"); git(main, "add", "--", "."); git(main, "commit", "-qm", "subject A");
  // Variant 1 — one child containing .git as a directory. Nothing is auto-selected, so the error keeps Git's wording and names the parameter.
  const single = await inspectGit("status", {}, { cwd: parent });
  assert.equal(single.isError, true);
  assert.match(text(single), /^Could not locate repository root:/);
  assert.match(text(single), /not a git repository/);
  assert.match(text(single), /Pass the "dir" parameter/);
  assert.match(text(single), /\(immediate children only,[^)]*\)/);
  assert.equal(listedNames(single), "A");
  // Variant 2 — a main repository plus its linked worktree. Both contain .git, so both are listed rather than the worktree alone.
  const worktree = join(parent, "B");
  git(main, "worktree", "add", "-qb", "candidate-test", worktree);
  try {
   assert.equal(listedNames(await inspectGit("log", { limit: 1 }, { cwd: parent })), "A, B");
   // Naming a candidate inspects that candidate, and its index is untouched. The helper routes the index check through the candidate itself.
   const named = await unchanged(worktree, "status", { dir: "B" }, { cwd: parent });
   assert.equal(named.isError, false, text(named));
   assert.equal(headerLine(named), `Git inspection (run directory ${worktree}, repository ${git(worktree, "rev-parse", "--show-toplevel")}):`);
   // Paths resolve against the target, not against the caller working directory.
   await writeFile(join(worktree, "space name"), "relative to B\n");
   const diff = await unchanged(worktree, "diff", { dir: "B", paths: ["space name"] }, { cwd: parent });
   assert.equal(diff.isError, false, text(diff));
   assert.match(text(diff), /relative to B/);
  } finally { git(main, "worktree", "remove", "--force", worktree); }
 } finally { await rm(parent, { recursive: true, force: true }); }
});

test("candidates are reported byte-wise sorted rather than in insertion order, and names needing quotes are quoted not stripped", async () => {
 // Fixture names are restricted to ASCII per the plan. Insertion order deliberately differs from Buffer.compare order.
 const parent = await mkdtemp(join(tmpdir(), "candidate-order-"));
 try {
  for (const name of ["zz-last", "mm-middle", "aa-first", "multi\nline"]) { await mkdir(join(parent, name)); await mkdir(join(parent, name, ".git")); }
  const result = await inspectGit("status", {}, { cwd: parent });
  assert.equal(result.isError, true);
  // Names come from fs.readdir, so they bypass clean(); the newline stays and is shown quoted as decided.
  assert.equal(listedNames(result), 'aa-first, mm-middle, "multi\\nline", zz-last');
  assert.match(text(result), /Some candidates may not resolve\./);
 } finally { await rm(parent, { recursive: true, force: true }); }
});

test("symlinked children are not followed as candidates", async () => {
 const parent = await mkdtemp(join(tmpdir(), "candidate-symlink-"));
 try {
  const main = join(parent, "A");
  await mkdir(main); git(main, "init", "-q");
  await writeFile(join(main, "file"), "x\n"); git(main, "add", "--", "."); git(main, "commit", "-qm", "subject A");
  await symlink(main, join(parent, "link-to-A"));
  const result = await inspectGit("status", {}, { cwd: parent });
  assert.equal(result.isError, true);
  assert.equal(listedNames(result), "A");
 } finally { await rm(parent, { recursive: true, force: true }); }
});

test("a candidate whose repository cannot be resolved is an unverified hint that answers with Git's own fatal", async () => {
 const parent = await mkdtemp(join(tmpdir(), "candidate-stale-"));
 try {
  const stale = join(parent, "stale");
  await mkdir(stale); await writeFile(join(stale, ".git"), "/definitely-not-a-worktree\n");
  const listed = await inspectGit("status", {}, { cwd: parent });
  assert.equal(listed.isError, true);
  assert.equal(listedNames(listed), "stale");
  assert.match(text(listed), /Some candidates may not resolve\./);
  // Running an inspection at the candidate itself shows why it is only a hint. Detection here costs no extra invocation because the caller asked for that directory anyway.
  const atCandidate = await inspectGit("status", { dir: "stale" }, { cwd: parent });
  assert.equal(atCandidate.isError, true);
  assert.match(text(atCandidate), /invalid gitfile format/);
  assert.match(text(atCandidate), /Pass the "dir" parameter/);
  assert.equal(atCandidate.details.exitCode, 128);
 } finally { await rm(parent, { recursive: true, force: true }); }
});

test("anomalies on the lookup keep the no-repository label and still reach the guidance line", async () => {
 const parent = await mkdtemp(join(tmpdir(), "candidate-anomaly-"));
 try {
  const candidate = join(parent, "A");
  await mkdir(candidate); await mkdir(join(candidate, ".git"));
  const script = join(parent, "fake-git");
  // The fixture is outside any repository, so only the lookup runs here and every case reaches the same note path.
  await writeFile(script, '#!/bin/sh\ncase " $* " in\n *" rev-parse --show-toplevel "*) sleep 2 ;;\n *) exec git "$@" ;;\nesac\n', { mode: 0o755 });
  const timedOut = await inspectGit("status", {}, { cwd: parent, executable: script, timeoutMs: 300 });
  assert.equal(timedOut.isError, true);
  assert.match(text(timedOut), /^Could not locate repository root:[\s\S]*Git timed out/);
  assert.match(text(timedOut), /Pass the "dir" parameter/);
  assert.equal(listedNames(timedOut), "A");
  const failedSpawn = await inspectGit("status", {}, { cwd: parent, executable: join(parent, "missing") });
  assert.equal(failedSpawn.isError, true);
  assert.match(text(failedSpawn), /^Could not locate repository root:[\s\S]*Could not start Git/);
  assert.equal(listedNames(failedSpawn), "A");
 } finally { await rm(parent, { recursive: true, force: true }); }
});

test("more than 20 candidates prove report truncation and more than 50 entries prove the scan cap by count and format", async () => {
 const reported = await mkdtemp(join(tmpdir(), "candidate-report-limit-"));
 const scanned = await mkdtemp(join(tmpdir(), "candidate-scan-limit-"));
 try {
  // Below the scan cap every entry is seen, so byte-wise order decides which names appear.
  for (let i = 0; i < 25; i++) { const name = `r${String(i).padStart(2, "0")}`; await mkdir(join(reported, name)); await mkdir(join(reported, name, ".git")); }
  const truncated = await inspectGit("status", {}, { cwd: reported });
  assert.equal(truncated.isError, true);
  assert.equal(listedNames(truncated), Array.from({ length: 20 }, (_, i) => `r${String(i).padStart(2, "0")}`).join(", "));
  // Above the scan cap membership depends on readdir order, so this asserts the stated limit plus count and format, not specific names.
  for (let i = 0; i < 60; i++) { const name = `s${String(i).padStart(2, "0")}`; await mkdir(join(scanned, name)); await mkdir(join(scanned, name, ".git")); }
  const capped = await inspectGit("status", {}, { cwd: scanned });
  assert.equal(capped.isError, true);
  assert.match(text(capped), /at most 50 entries scanned, stopped at that limit/);
  const names = listedNames(capped).split(", ");
  assert.equal(names.length, 20);
  assert.ok(names.every((name) => /^s\d{2}$/.test(name)), text(capped));
 } finally { await rm(reported, { recursive: true, force: true }); await rm(scanned, { recursive: true, force: true }); }
});

test("upward discovery wins over the candidate scan", async () => {
 const ancestor = await mkdtemp(join(tmpdir(), "ancestor-repo-"));
 try {
  git(ancestor, "init", "-q");
  await writeFile(join(ancestor, "file"), "x\n"); git(ancestor, "add", "--", "."); git(ancestor, "commit", "-qm", "ancestor repository");
  const nested = join(ancestor, "nested");
  await mkdir(nested);
  // A real candidate inside the run directory. Upward discovery finds the ancestor repository first, so nothing is listed.
  const child = join(nested, "child");
  await mkdir(child); git(child, "init", "-q");
  await writeFile(join(child, "file"), "y\n"); git(child, "add", "--", "."); git(child, "commit", "-qm", "own repository");
  const fromNested = await unchanged(ancestor, "log", { dir: "nested", limit: 1 }, { cwd: ancestor });
  assert.equal(fromNested.isError, false, text(fromNested));
  assert.match(text(fromNested), /ancestor repository/);
  assert.doesNotMatch(text(fromNested), /Candidates under this directory|Pass the "dir" parameter/);
  // The candidate answers with its own repository when it is named directly, which is what the caller would have to do instead.
  const inChild = await unchanged(child, "log", { limit: 1 }, { cwd: child });
  assert.equal(inChild.isError, false, text(inChild));
  assert.match(text(inChild), /own repository/);
 } finally { await rm(ancestor, { recursive: true, force: true }); }
});

// Case 2: discovery succeeded and the repository has other registered worktrees. The names are chosen so byte-wise
// order differs from porcelain order, which is what the comparison against live porcelain output proves.
test("the guidance note lists other registered worktrees in porcelain order, marks the current checkout, and states its own bounds", async () => {
 const parent = await mkdtemp(join(tmpdir(), "guidance-parent-"));
 try {
  const main = join(parent, "zz-main");
  await mkdir(main); git(main, "init", "-q");
  await writeFile(join(main, "file"), "first\n"); git(main, "add", "--", "."); git(main, "commit", "-qm", "subject main");
  const nested = join(main, "nested"); await mkdir(nested);
  // Separate branches make the checkouts distinguishable by content, so a result naming subject main shows nothing was selected elsewhere.
  const linked = join(parent, "aa-linked");
  git(main, "worktree", "add", "-q", "-b", "other", linked, "HEAD");
  git(linked, "commit", "-qm", "subject linked", "--allow-empty");
  const result = await unchanged(main, "log", { dir: "zz-main/nested", limit: 1 }, { cwd: parent });
  assert.equal(result.isError, false, text(result));
  assert.match(text(result), /subject main/); assert.doesNotMatch(text(result), /subject linked/);
  assert.equal(headerLine(result), `Git inspection (run directory ${nested}, repository ${main}):`);
  const records = porcelainRecords(main);
  assert.deepEqual(records, [main, linked]);
  // Byte-wise sort would put aa-linked first, so comparing against live porcelain output shows the note keeps Git's order rather than sorting.
  assert.notDeepEqual(records, [...records].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  assert.equal(listedWorktrees(result), `${main} (current repository, main working tree), ${linked}`);
  assert.match(text(result), /Worktree guidance \(20 records maximum, 81920 bytes of Git output maximum, this appended message is not bounded by the tool output limit\): Records in git worktree list --porcelain order, which lists the main working tree first: /);
  assert.match(text(result), /Nothing was auto-selected; pass the "dir" parameter with a path from this list\.\]/);
 } finally { await rm(parent, { recursive: true, force: true }); }
});

// The negative case that discriminates the trigger: only linked worktrees count, never the main working tree itself,
// even though porcelain prints it first with no flag marking it. Nothing is appended when there is no second record.
test("a single-checkout repository gets no note anywhere, including from a subdirectory of its top level", async () => fixture(async (base) => {
 assert.deepEqual(porcelainRecords(base), [base]);
 const statusArgs = ["status", "--porcelain=v1", "--branch", "--untracked-files=all"];
 assert.equal(text(await unchanged(base, "status")), `Git inspection:\n${(await runGit(statusArgs, { cwd: base })).text}`);
 await mkdir(join(base, "nested"));
 const subdirectory = await unchanged(base, "log", { limit: 1 }, { cwd: join(base, "nested") });
 assert.equal(subdirectory.isError, false, text(subdirectory));
 // The run directory and the top level differ here, so the header appears; only the note is absent because there is no second record.
 assert.equal(headerLine(subdirectory), `Git inspection (run directory ${join(base, "nested")}, repository ${base}):`);
 assert.doesNotMatch(text(subdirectory), /Worktree guidance/);
}));

test("the current entry is marked as the resolved checkout rather than assumed to be the first record", async () => {
 const parent = await mkdtemp(join(tmpdir(), "guidance-worktrees-"));
 try {
  const main = join(parent, "zz-main");
  await mkdir(main); git(main, "init", "-q");
  await writeFile(join(main, "file"), "first\n"); git(main, "add", "--", "."); git(main, "commit", "-qm", "subject main");
  const first = join(parent, "aa-first"), second = join(parent, "bb-second");
  git(main, "worktree", "add", "-q", "-b", "first-branch", first, "HEAD"); git(first, "commit", "-qm", "subject first", "--allow-empty");
  git(main, "worktree", "add", "-q", "-b", "second-branch", second, "HEAD"); git(second, "commit", "-qm", "subject second", "--allow-empty");
  const result = await unchanged(main, "log", { limit: 1 }, { cwd: first });
  assert.equal(result.isError, false, text(result));
  assert.match(text(result), /subject first/); assert.doesNotMatch(text(result), /subject second|subject main/);
  // In a linked worktree the resolved top level is that worktree itself, so nothing differs from the run directory here and no header appears while the note still marks the actual checkout.
  assert.equal(headerLine(result), "Git inspection:");
  const records = porcelainRecords(main);
  assert.equal(records.length, 3); assert.equal(records[0], main);
  // The expected string is built from live order, so no assumption about which linked record comes next is made.
  assert.equal(listedWorktrees(result), records.map((record) => record === first ? `${record} (current repository)` : record).join(", "));
 } finally { await rm(parent, { recursive: true, force: true }); }
});

// Every limit that applies to this message is stated in it: the record count, the byte cap the lookup used, and that
// the tool output limit does not apply. The current entry carries its own marker, so the joined string is compared rather than split on ", ".
test("the note states both bounds that apply to it and enforces them under a smaller caller output limit", async () => fixture(async (dir) => {
 const script = join(dir, "fake-git");
 // Only the guidance call is intercepted here, so discovery falls through to real Git inside the fixture repository and the resolved top level stays the first record.
 const first = [dir, ...Array.from({ length: 19 }, (_, i) => `/fabricated-${i}`)];
 const beyond = Array.from({ length: 12 }, () => "/fabricated-" + "y".repeat(8000));
 const names = [...first, ...beyond];
 const porcelain = names.map((name) => `worktree ${name}\nHEAD abc\n`).join("\n");
 await writeFile(join(dir, "porcelain"), porcelain);
 await writeFile(script, `#!/bin/sh\ncase " $* " in\n *" worktree list --porcelain "*) cat "${join(dir, "porcelain")}" ;;\n *) exec git "$@" ;;\nesac\n`, { mode: 0o755 });
 assert.ok(names.length > 20 && Buffer.byteLength(porcelain) > 20 * 4096, "the fixture must exceed both stated bounds for enforcement to be observable");
 // The caller limit passed here governs captured tool output only; the note keeps its own bound, and the cut lands after the 20th record so the listed part is complete.
 const result = await inspectGit("log", { limit: 1 }, { cwd: dir, executable: script, outputLimit: 300 });
 assert.equal(result.isError, false, text(result));
 assert.match(text(result), /Worktree guidance \(20 records maximum, 81920 bytes of Git output maximum, this appended message is not bounded by the tool output limit, the list may be incomplete because Git output was cut off at that cap\): Records in git worktree list --porcelain order, which lists the main working tree first: /);
 assert.equal(listedWorktrees(result), [`${dir} (current repository, main working tree)`, ...first.slice(1, 20)].join(", "));
}));

// An optional extra invocation cannot make a successful inspection an error, so an anomalous answer appends nothing while the inspection itself still succeeds.
test("an anomalous answer on the guidance call appends nothing and leaves the inspection successful", async () => fixture(async (dir) => {
 const outside = await mkdtemp(join(tmpdir(), "guidance-anomaly-"));
 try {
  git(dir, "worktree", "add", "-q", "-b", "other", join(outside, "linked"), "HEAD");
  assert.ok(porcelainRecords(dir).length > 1, "the trigger must hold for these cases to show the guard rather than the absence of other worktrees");
  const script = join(dir, "fake-git");
  const writeScript = (body: string) => writeFile(script, `#!/bin/sh\ncase " $* " in\n *" worktree list --porcelain "*) ${body} ;;\n *) exec git "$@" ;;\nesac\n`, { mode: 0o755 });
  for (const body of ["echo failed >&2; exit 3", "sleep 2"]) {
   await writeScript(body);
   const result = await inspectGit("log", { limit: 1 }, { cwd: dir, executable: script, timeoutMs: 300 });
   assert.equal(result.isError, false, text(result)); assert.doesNotMatch(text(result), /Worktree guidance|failed|timed out/);
  }
  await writeScript("touch guidance-started; sleep 2");
  const controller = new AbortController();
  const pending = inspectGit("log", { limit: 1 }, { cwd: dir, executable: script, signal: controller.signal });
  for (let i = 0; i < 100; i++) {
   try { await readFile(join(dir, "guidance-started")); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  await readFile(join(dir, "guidance-started")); controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.isError, true); assert.match(text(cancelled), /^Git inspection:[\s\S]*Git cancelled; process stopped\.\]/); assert.doesNotMatch(text(cancelled), /Worktree guidance/);
 } finally { await rm(outside, { recursive: true, force: true }); }
}));

// The two notes cannot combine: marking an entry as current requires a resolved top level, so when discovery fails only the candidate note appears even though other worktrees are registered.
test("a multi-worktree repository with no resolvable top level reports candidates without any current marker", async () => {
 const parent = await mkdtemp(join(tmpdir(), "guidance-no-repository-"));
 try {
  const main = join(parent, "zz-main");
  await mkdir(main); git(main, "init", "-q");
  await writeFile(join(main, "file"), "first\n"); git(main, "add", "--", "."); git(main, "commit", "-qm", "subject main");
  git(main, "worktree", "add", "-q", "-b", "other", join(parent, "aa-linked"), "HEAD");
  // The plain parent is in no repository, so this is the no-repository-found label and nothing can be marked current.
  const result = await inspectGit("status", {}, { cwd: parent });
  assert.equal(result.isError, true);
  assert.match(listedNames(result), /aa-linked, zz-main/);
  assert.doesNotMatch(text(result), /Worktree guidance|current repository/);
 } finally { await rm(parent, { recursive: true, force: true }); }
});

test("bare repositories keep log and show working with no top level in the header", async () => {
 const parent = await mkdtemp(join(tmpdir(), "git-bare-"));
 try {
  const source = join(parent, "source");
  await mkdir(source); git(source, "init", "-q");
  await writeFile(join(source, "space name"), "first\n"); git(source, "add", "--", "."); git(source, "commit", "-qm", "bare subject");
  // A bare clone keeps refs and objects without a working tree, so there is something to read.
  const bare = join(parent, "bare"); git(source, "clone", "--bare", "-q", source, bare);
  // The helper is not used here: its index check runs status, which cannot run in a bare repository, so these cases call inspectGit directly.
  const log = await inspectGit("log", { limit: 1 }, { cwd: bare });
  assert.equal(log.isError, false, text(log)); assert.match(text(log), /bare subject/);
  const shown = await inspectGit("show", { ref: "HEAD" }, { cwd: bare });
  assert.equal(shown.isError, false, text(shown)); assert.match(text(shown), /first/);
  // Working-tree kinds still reach Git's own fatal there, reported as the inspection itself with its exit code.
  for (const [kind, args] of [["status", {}], ["diff", {}]] as const) {
   const result = await inspectGit(kind, args, { cwd: bare });
   assert.equal(result.isError, true); assert.match(text(result), /must be run in a work tree/); assert.equal(result.details.exitCode, 128);
  }
  // Nothing differs when the run directory is the caller working directory, so the label stays plain. Reached through dir, only the run-directory part can appear because no top level resolves in a bare repository.
  assert.equal(headerLine(log), "Git inspection:"); assert.equal(headerLine(shown), "Git inspection:");
  const throughDir = await inspectGit("log", { dir: "bare", limit: 1 }, { cwd: parent });
  assert.equal(throughDir.isError, false, text(throughDir));
  assert.equal(headerLine(throughDir), `Git inspection (run directory ${bare}):`);
  assert.doesNotMatch(headerLine(throughDir), /repository/);
 } finally { await rm(parent, { recursive: true, force: true }); }
});

test("the bareness confirmation is gated on the failed lookup and the submodule scan is skipped in a bare repository", async () => {
 const parent = await mkdtemp(join(tmpdir(), "git-bare-gate-"));
 try {
  const repo = join(parent, "repo");
  await mkdir(repo); git(repo, "init", "-q");
  await writeFile(join(repo, "file"), "x\n"); git(repo, "add", "--", "."); git(repo, "commit", "-qm", "subject");
  const bare = join(parent, "bare"); git(repo, "clone", "--bare", "-q", repo, bare);
  const script = join(parent, "fake-git");
  // Both branches record what was asked for and answer with real Git, so these assertions depend on which calls happen at all rather than on their output.
  await writeFile(script, `#!/bin/sh\ncase " $* " in\n *" ls-files "*) touch '${parent}/scan-started'; exec git "$@" ;;\n *" --is-bare-repository "*) touch '${parent}/bare-check'; exec git "$@" ;;\n *) exec git "$@" ;;\nesac\n`, { mode: 0o755 });
  // In a bare repository an empty ls-files output with exit 0 would read as success, so reaching the fatal here proves the scan was not attempted; the confirmation ran because this lookup failed with that fatal.
  const inBare = await inspectGit("status", {}, { cwd: bare, executable: script });
  assert.equal(inBare.isError, true); assert.match(text(inBare), /must be run in a work tree/);
  await assert.rejects(readFile(join(parent, "scan-started")), { code: "ENOENT" });
  await readFile(join(parent, "bare-check"));
  // A successful lookup never asks about bareness, so the ordinary case pays no extra invocation and still scans. The plain-directory case fails the lookup with a different message, so it does not check either.
  await rm(join(parent, "bare-check"), { force: true });
  const normal = await inspectGit("status", {}, { cwd: repo, executable: script });
  assert.equal(normal.isError, false, text(normal));
  await readFile(join(parent, "scan-started"));
  await assert.rejects(readFile(join(parent, "bare-check")), { code: "ENOENT" });
  const plain = join(parent, "plain"); await mkdir(plain);
  const outside = await inspectGit("status", {}, { cwd: plain, executable: script });
  assert.equal(outside.isError, true); assert.match(text(outside), /not a git repository/);
  await assert.rejects(readFile(join(parent, "bare-check")), { code: "ENOENT" });
 } finally { await rm(parent, { recursive: true, force: true }); }
});

test("status reports paths relative to the repository top level while a pathspec is scoped to the run directory", async () => fixture(async (dir) => {
 await mkdir(join(dir, "in-scope")); await mkdir(join(dir, "out-of-scope"));
 await writeFile(join(dir, "in-scope", "a.txt"), "first\n"); await writeFile(join(dir, "out-of-scope", "b.txt"), "first\n");
 git(dir, "add", "--", "."); git(dir, "commit", "-qm", "scoped files");
 await writeFile(join(dir, "in-scope", "a.txt"), "IN SCOPE\n"); await writeFile(join(dir, "out-of-scope", "b.txt"), "OUT OF SCOPE\n");
 // First behaviour, asserted on its own: status prints paths relative to the top level even when run from a subdirectory,
 // including for files outside it. Measured on Git 2.53.0; status.relative has no effect either way.
 const fromSub = await unchanged(dir, "status", {}, { cwd: join(dir, "in-scope") });
 assert.match(text(fromSub), /^ M in-scope\/a\.txt$/m);
 assert.match(text(fromSub), /^ M out-of-scope\/b\.txt$/m);
 assert.doesNotMatch(text(fromSub), /^ M a\.txt$/m);
 // Second behaviour, asserted separately: a "." pathspec is read against the run directory, so only the change inside it appears.
 const diff = await unchanged(dir, "diff", { paths: ["."] }, { cwd: join(dir, "in-scope") });
 assert.match(text(diff), /IN SCOPE/); assert.doesNotMatch(text(diff), /OUT OF SCOPE/);
}));

test("helper forwards extra run options while keeping its default run directory", async () => fixture(async (base) => {
 // Without extra options the run directory is still the helper argument.
 assert.match(text(await unchanged(base, "status")), /##/);
 // With an option that changes the run directory, the inspection runs there while the index check is
 // routed through `base`, which is inside a repository. This is the case the helper cannot check on its own.
 const parent = await mkdtemp(join(tmpdir(), "git-helper-parent-"));
 try {
  const result = await unchanged(base, "status", {}, { cwd: parent });
  assert.equal(result.isError, true); assert.match(text(result), /not a git repository/);
 } finally { await rm(parent, { recursive: true, force: true }); }
}));

test("output cap, timeout, cancellation and spawn failure", async () => fixture(async (dir) => {
 await writeFile(join(dir, "-dash"), "x".repeat(20000));
 const large = await unchanged(dir, "diff"); assert.equal(large.isError, false);
 const capped = await inspectGit("diff", {}, { cwd: dir, outputLimit: 500 }); assert.equal(capped.details.truncated, true); assert.match(text(capped), /truncated/);
 const script = join(dir, "slow"); await writeFile(script, "#!/bin/sh\n(sleep 1; touch child-survived) &\nexit 0\n", { mode: 0o755 });
 let started = Date.now(); const timeout = await runGit([], { cwd: dir, executable: script, timeoutMs: 100 }); assert.equal(timeout.timedOut, true); assert.ok(Date.now() - started < 2000);
 const controller = new AbortController(); started = Date.now(); const pending = runGit([], { cwd: dir, executable: script, signal: controller.signal }); setTimeout(() => controller.abort(), 100); assert.equal((await pending).cancelled, true); assert.ok(Date.now() - started < 2000);
 await new Promise((resolve) => setTimeout(resolve, 1200));
 if (process.platform !== "win32") await assert.rejects(readFile(join(dir, "child-survived")), { code: "ENOENT" });
 const failed = await inspectGit("status", {}, { cwd: dir, executable: join(dir, "missing") }); assert.equal(failed.isError, true); assert.match(text(failed), /Could not start Git/);
}));
