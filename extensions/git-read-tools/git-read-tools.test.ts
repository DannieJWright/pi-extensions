import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectGit, runGit } from "./git.ts";
import extension from "./index.ts";

function git(cwd: string, ...args: string[]) { return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" }, encoding: "utf8" }).trim(); }
async function fixture(fn: (dir: string) => Promise<void>) {
 const dir = await mkdtemp(join(tmpdir(), "git-read-tools-"));
 try { git(dir, "init", "-q"); await writeFile(join(dir, "space name"), "first\n"); await writeFile(join(dir, "-dash"), "dash\n"); git(dir, "add", "--", "."); git(dir, "commit", "-qm", "first"); await fn(dir); }
 finally { await rm(dir, { recursive: true, force: true }); }
}
function text(result: Awaited<ReturnType<typeof inspectGit>>) { return result.content[0].text; }
async function unchanged(dir: string, kind: Parameters<typeof inspectGit>[0], args: Record<string, unknown> = {}) {
 const before = git(dir, "status", "--porcelain=v1", "--untracked-files=all"); const index = await readFile(join(git(dir, "rev-parse", "--absolute-git-dir"), "index"));
 const result = await inspectGit(kind, args, { cwd: dir });
 assert.equal(git(dir, "status", "--porcelain=v1", "--untracked-files=all"), before); assert.deepEqual(await readFile(join(git(dir, "rev-parse", "--absolute-git-dir"), "index")), index);
 return result;
}

test("tool registration has strict typed schemas and child cwd", async () => fixture(async (dir) => {
 const tools: any[] = []; extension({ registerTool(tool: any) { tools.push(tool); } } as any);
 assert.deepEqual(tools.map((t) => t.name), ["git_r_diff", "git_r_status", "git_r_log", "git_r_show"]);
 assert.ok(tools.every((t) => t.parameters.additionalProperties === false && t.description));
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
 const limited = await inspectGit("diff", {}, { cwd: dir, outputLimit: 1 });
 assert.equal(limited.isError, true); assert.match(text(limited), /filter configuration check exceeded/);
 assert.equal((await inspectGit("diff", { mode: "staged" }, { cwd: dir })).isError, false);
 await assert.rejects(readFile(marker), { code: "ENOENT" });
 git(dir, "config", "--unset", "filter.evil.clean");
 git(dir, "config", "filter.evil.process", `touch ${marker}; cat`);
 assert.equal((await inspectGit("diff", {}, { cwd: dir })).isError, true);
 await assert.rejects(readFile(marker), { code: "ENOENT" });
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

test("output cap, timeout, cancellation and spawn failure", async () => fixture(async (dir) => {
 await writeFile(join(dir, "-dash"), "x".repeat(20000));
 const large = await unchanged(dir, "diff"); assert.equal(large.isError, false);
 const capped = await inspectGit("diff", {}, { cwd: dir, outputLimit: 100 }); assert.equal(capped.details.truncated, true); assert.match(text(capped), /truncated/);
 const script = join(dir, "slow"); await writeFile(script, "#!/bin/sh\n(sleep 1; touch child-survived) &\nexit 0\n", { mode: 0o755 });
 let started = Date.now(); const timeout = await runGit([], { cwd: dir, executable: script, timeoutMs: 100 }); assert.equal(timeout.timedOut, true); assert.ok(Date.now() - started < 2000);
 const controller = new AbortController(); started = Date.now(); const pending = runGit([], { cwd: dir, executable: script, signal: controller.signal }); setTimeout(() => controller.abort(), 100); assert.equal((await pending).cancelled, true); assert.ok(Date.now() - started < 2000);
 await new Promise((resolve) => setTimeout(resolve, 1200));
 if (process.platform !== "win32") await assert.rejects(readFile(join(dir, "child-survived")), { code: "ENOENT" });
 const failed = await inspectGit("status", {}, { cwd: dir, executable: join(dir, "missing") }); assert.equal(failed.isError, true); assert.match(text(failed), /Could not start Git/);
}));
