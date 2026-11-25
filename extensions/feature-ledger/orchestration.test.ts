import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@earendil-works/pi-schema";
import featureLedger from "./index.ts";
import { allowedValues, ASSIGNMENT_ROLES, checkLedger, FINDING_SEVERITIES, FINDING_STATUSES, parseLedger, serializeLedger, STATUSES } from "./ledger.ts";
import { createFakeApi, createFakeContext, invoke, setupRepo } from "./test-harness.ts";

const fixture = `ledger:
  branch: {BRANCH}
  max_failed_reviews: 2
  validation_scripts: []
  features:
    - id: todo
      status: todo
      short_goal: Todo
      goal: Todo goal
    - id: retry
      status: in-progress
      review: true
      failed_reviews: 1
      short_goal: Retry
      goal: Retry goal
    - id: review
      status: review
      review: true
      short_goal: Review
      goal: Review goal
      commits:
        start: 123abc
        submissions: [123abc]
`;

// Skips Pi's argument validation, to prove the tool refuses an argument its own schema also rejects.
const callUnvalidated = (api: ReturnType<typeof createFakeApi>, dir: string, name: string, params: Record<string, unknown>) =>
  api.tools[name].execute(null, params, null, null, createFakeContext(dir));
const call = (api: ReturnType<typeof createFakeApi>, dir: string, name: string, params: Record<string, unknown>) =>
  invoke(api.tools[name], params, createFakeContext(dir));
const json = (result: { content: [{ text: string }]; isError?: boolean }) => {
  assert.ok(!result.isError, result.content[0].text);
  return JSON.parse(result.content[0].text);
};

test("ledger_orchestrate prioritizes review and eligible retries, reports in-flight and cap, then permits todo", async () => {
  const { dir, path, cleanup } = await setupRepo(fixture);
  try {
    const api = createFakeApi(); featureLedger(api);
    async function set(updater: (ledger: NonNullable<ReturnType<typeof parseLedger>["ledger"]>) => void) {
      const ledger = parseLedger(await readFile(path, "utf8")).ledger!;
      updater(ledger);
      await writeFile(path, serializeLedger(ledger));
    }
    const next = async () => json(await call(api, dir, "ledger_orchestrate", { action: "next", path }));
    const list = json(await call(api, dir, "ledger_orchestrate", { action: "list", path }));
    assert.deepEqual(list.items.map((item: { id: string }) => item.id), ["todo", "retry", "review"]);
    assert.equal((await next()).next.id, "review");
    await set(ledger => { ledger.features[2].assignment = { id: "review-0-reviewer", role: "reviewer", agent_id: "assigned", claim_token: "token" }; });
    let result = await next();
    assert.equal(result.next.id, "retry");
    assert.equal(result.assigned[0].assignment.agent_id, "assigned");
    await set(ledger => { ledger.features[1].failed_reviews = 2; });
    result = await next();
    assert.equal(result.next, null);
    assert.equal(result.capped[0].id, "retry");
    assert.equal(result.capped[0].config.max_failed_reviews, 2);
    await set(ledger => { ledger.features[1].max_failed_reviews = 0; });
    assert.equal((await next()).next.id, "retry");
    await set(ledger => { ledger.features[1].status = "done"; ledger.features[2].status = "done"; delete ledger.features[2].assignment; });
    assert.equal((await next()).next.id, "todo");
  } finally { await cleanup(); }
});

test("orchestration fixture wins over an inherited ledger path", async () => {
  const home = await mkdtemp(join(tmpdir(), "orchestration-isolation-"));
  try {
    const sentinel = join(home, "personal-ledger.yaml");
    const contents = fixture.replace("{BRANCH}", "sentinel").replace("id: todo", "id: sentinel");
    await writeFile(sentinel, contents);
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", PI_LEDGER_PATH: sentinel };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern=^ledger_orchestrate prioritizes review", fileURLToPath(import.meta.url)], {
      env, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /^ok \d+ - ledger_orchestrate prioritizes review/m);
    assert.equal(await readFile(sentinel, "utf8"), contents);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("ledger_get_feature exposes full item and release fences stale identity and token across claims", async () => {
  const single = fixture.slice(0, fixture.indexOf("    - id: retry"));
  const { dir, path, cleanup } = await setupRepo(single);
  try {
    const api = createFakeApi(); featureLedger(api);
    const start = () => call(api, dir, "ledger_work", { action: "start", id: "todo", agent_id: "external-agent", path });
    const first = json(await start());
    const assignment = first.item.assignment;
    assert.equal(assignment.id, "todo-0-worker");
    assert.equal(assignment.agent_id, "external-agent");
    const full = json(await call(api, dir, "ledger_get_feature", { id: "todo", path }));
    assert.equal(full.item.goal, "Todo goal");
    assert.equal(full.item.assignment.claim_token, assignment.claim_token);
    assert.equal(full.config.max_failed_reviews, 2);
    assert.equal(full.config.enabled, false);
    assert.deepEqual(full.config.validation_scripts, []);
    const release = (agent_id: string, claim_token: string) => call(api, dir, "ledger_orchestrate", { action: "release", id: "todo", agent_id, claim_token, path });
    // Assignment is read through the list action. next filters assigned items out of next and reports
    // them in assigned, so it cannot show which holder a refused claim still belongs to.
    const listed = async () => json(await call(api, dir, "ledger_orchestrate", { action: "list", path })).items.find((item: { id: string }) => item.id === "todo");
    const before = await readFile(path, "utf8");
    assert.ok((await release("wrong", assignment.claim_token)).isError);
    // A refusal on identity or token leaves the held claim intact for its original holder.
    assert.equal((await listed())?.assignment?.agent_id, "external-agent");
    assert.equal((await listed())?.assignment?.claim_token, assignment.claim_token);
    assert.ok((await release("external-agent", "wrong")).isError);
    assert.equal(await readFile(path, "utf8"), before);
    assert.equal((await listed())?.assignment?.agent_id, "external-agent");
    assert.equal(await readFile(path, "utf8"), before);
    const released = json(await release("external-agent", assignment.claim_token));
    assert.equal(released.item.status, "in-progress");
    assert.equal(released.item.assignment, undefined);
    const second = json(await start());
    assert.equal(second.item.assignment.id, assignment.id);
    assert.notEqual(second.item.assignment.claim_token, assignment.claim_token);
    assert.ok((await release("external-agent", assignment.claim_token)).isError);
    const stale = await call(api, dir, "ledger_work", { action: "submit", id: "todo", agent_id: "external-agent", claim_token: assignment.claim_token, commit_message: "stale", summary: "stale", path });
    assert.ok(stale.isError);
    assert.match(stale.content[0].text, /no matching worker claim/);
    // Fencing refuses the stale token only; the live claim from the second start still holds.
    assert.equal((await listed())?.assignment?.agent_id, "external-agent");
    assert.equal((await listed())?.assignment?.claim_token, second.item.assignment.claim_token);
    await writeFile(join(dir, "work.txt"), "work\n");
    const submitted = await call(api, dir, "ledger_work", { action: "submit", id: "todo", agent_id: "external-agent", claim_token: second.item.assignment.claim_token, commit_message: "work", summary: "worked", path });
    assert.ok(!submitted.isError, submitted.content[0].text);
    assert.equal(json(await call(api, dir, "ledger_get_feature", { id: "todo", path })).item.status, "done");
  } finally { await cleanup(); }
});

test("release refuses an invalid file through the shared gate and leaves the file unchanged", async () => {
  const single = fixture.slice(0, fixture.indexOf("    - id: retry"));
  const { dir, path, cleanup } = await setupRepo(single);
  try {
    const api = createFakeApi(); featureLedger(api);
    async function set(updater: (ledger: NonNullable<ReturnType<typeof parseLedger>["ledger"]>) => void) {
      const ledger = parseLedger(await readFile(path, "utf8")).ledger!;
      updater(ledger);
      await writeFile(path, serializeLedger(ledger));
    }
    const started = json(await call(api, dir, "ledger_work", { action: "start", id: "todo", agent_id: "external-agent", path }));
    const claimToken = started.item.assignment.claim_token;
    // The identity matches exactly; only the model is wrong. The gate runs first, so nothing is matched or written.
    await set((ledger) => { ledger.features[0].max_failed_reviews = -1; });
    const invalid = await readFile(path, "utf8");
    const expected = checkLedger(invalid);
    assert.deepEqual(expected, ["features[0] (todo): max_failed_reviews must be a nonnegative integer"], invalid);
    const refused = await call(api, dir, "ledger_orchestrate", { action: "release", id: "todo", agent_id: "external-agent", claim_token: claimToken, path });
    assert.ok(refused.isError);
    assert.equal(refused.content[0].text, `ledger_orchestrate: invalid ledger: ${expected.join("; ")}`);
    assert.equal(await readFile(path, "utf8"), invalid, "a refusal wrote the ledger");
    assert.equal(parseLedger(invalid).ledger!.features[0].assignment?.claim_token, claimToken, "a refusal cleared the claim");
    // The same identity against a valid file releases the claim and leaves status as the file recorded it.
    await set((ledger) => { delete ledger.features[0].max_failed_reviews; });
    const released = json(await call(api, dir, "ledger_orchestrate", { action: "release", id: "todo", agent_id: "external-agent", claim_token: claimToken, path }));
    assert.equal(released.item.status, "in-progress");
    assert.equal(released.item.assignment, undefined);
  } finally { await cleanup(); }
});

test("complete review loop crosses orchestration and role tools through selective closure and a real fix", async () => {
  const single = fixture.slice(0, fixture.indexOf("    - id: retry")).replace("      status: todo\n", "      status: todo\n      review: true\n");
  const { dir, path, cleanup } = await setupRepo(single);
  try {
    const api = createFakeApi(); featureLedger(api);
    const invoke = async (name: string, params: Record<string, unknown>) => json(await call(api, dir, name, { ...params, path }));
    const selected = () => invoke("ledger_orchestrate", { action: "next" });
    const workStart = (agent_id: string) => invoke("ledger_work", { action: "start", id: "todo", agent_id });
    const workSubmit = (agent_id: string, claim_token: string) => call(api, dir, "ledger_work", { action: "submit", id: "todo", agent_id, claim_token, commit_message: "Implementation", summary: "Implemented or fixed the feature", path });
    const reviewStart = (agent_id: string) => invoke("ledger_review", { action: "start", id: "todo", agent_id });
    const reviewSubmit = (agent_id: string, claim_token: string, updates: Record<string, unknown>, commit_message: string) => invoke("ledger_review", { action: "submit", id: "todo", agent_id, claim_token, commit_message, ...updates });
    assert.equal((await selected()).next.status, "todo");
    const worker = await workStart("todo-0-worker");
    await writeFile(join(dir, "work.txt"), "first\n");
    const initial = await workSubmit("todo-0-worker", worker.item.assignment.claim_token);
    assert.ok(!initial.isError, initial.content[0].text);
    assert.equal((await selected()).next.status, "review");
    const reviewer = await reviewStart("todo-0-reviewer");
    assert.deepEqual(reviewer.latest_diff.implementation.files, ["work.txt"]);
    const finding = (details: string) => ({ details, rationale: "Must fix", severity: "minor", required_checks: ["inspect fix"] });
    const failed = await reviewSubmit("todo-0-reviewer", reviewer.item.assignment.claim_token, { new_findings: [finding("first issue"), finding("second issue")] }, "Review todo round 0: two findings");
    assert.equal(failed.status, "in-progress");
    assert.equal(failed.failed_reviews, 1);
    assert.equal((await selected()).next.status, "in-progress");
    const fixer = await workStart("todo-1-worker");
    assert.equal(fixer.pending_findings.length, 2);
    await writeFile(join(dir, "work.txt"), "first fix\n");
    const fixed = await workSubmit("todo-1-worker", fixer.item.assignment.claim_token);
    assert.ok(!fixed.isError, fixed.content[0].text);
    const second = await reviewStart("todo-1-reviewer");
    assert.match(second.cumulative_diff.implementation.patch, /first fix/);
    assert.match(second.latest_diff.implementation.patch, /first fix/);
    const partial = await reviewSubmit("todo-1-reviewer", second.item.assignment.claim_token, { close_findings: [failed.open_findings[0].id] }, "Review todo round 1: one finding still open");
    assert.equal(partial.failed_reviews, 2);
    assert.equal(partial.open_findings[0].id, failed.open_findings[1].id);
    assert.equal((await selected()).next, null);
    const ledger = parseLedger(await readFile(path, "utf8")).ledger!;
    ledger.features[0].max_failed_reviews = 3;
    await writeFile(path, serializeLedger(ledger));
    const thirdWorker = await workStart("todo-2-worker");
    await writeFile(join(dir, "work.txt"), "all fixes\n");
    const secondFix = await workSubmit("todo-2-worker", thirdWorker.item.assignment.claim_token);
    assert.ok(!secondFix.isError, secondFix.content[0].text);
    const thirdReviewer = await reviewStart("todo-2-reviewer");
    const passed = await reviewSubmit("todo-2-reviewer", thirdReviewer.item.assignment.claim_token, { close_findings: [failed.open_findings[1].id] }, "Review todo round 2: no findings remain");
    assert.equal(passed.status, "done");
    const final = await invoke("ledger_get_feature", { id: "todo" });
    assert.equal(final.item.commits.submissions.length, 3);
    assert.deepEqual(final.item.findings.map((item: { status: string }) => item.status), ["closed", "closed"]);
    assert.equal((await selected()).status, "done");
  } finally { await cleanup(); }
});

// One minimal valid argument set per action, for the positive half of the same check.
const VALID_ACTION_ARGS = {
  ledger_orchestrate: [{ action: "list" }, { action: "next" }, { action: "release", id: "x", agent_id: "a", claim_token: "t" }],
  ledger_work: [{ action: "start", id: "x", agent_id: "a" }, { action: "submit", id: "x", agent_id: "a", claim_token: "t", commit_message: "Work x", summary: "s" }],
  ledger_review: [{ action: "start", id: "x", agent_id: "a" }, { action: "submit", id: "x", agent_id: "a", claim_token: "t", commit_message: "Review x round 0" }],
} as const;

test("action schemas and tool calls reject missing, wrong-action, and malformed arguments", async () => {
  const { dir, path, cleanup } = await setupRepo(fixture);
  try {
    const api = createFakeApi(); featureLedger(api);
    for (const name of ["ledger_start", "ledger_submit", "ledger_list", "ledger_next"]) assert.equal(api.tools[name], undefined);
    for (const name of ["ledger_orchestrate", "ledger_work", "ledger_review"]) {
      const schema = compile(api.tools[name].parameters);
      assert.equal(schema.check({}), false, name);
      assert.equal(schema.check({ action: "wrong" }), false, name);
      assert.equal(schema.check({ action: name === "ledger_orchestrate" ? "release" : "submit", id: "x", agent_id: "agent" }), false, name);
    }
    // Each action a tool declares is accepted with its own arguments; nothing outside that list is.
    for (const [name, actions] of Object.entries(VALID_ACTION_ARGS)) {
      const schema = compile(api.tools[name].parameters);
      for (const params of actions) assert.ok(schema.check(params), `${name} ${params.action}`);
    }
    // The review schema takes its severities from FINDING_SEVERITIES, so every value the model defines is
    // accepted and nothing outside it is.
    const reviewSchema = compile(api.tools.ledger_review.parameters);
    const findingArgs = (severity: string) => ({ action: "submit", id: "x", agent_id: "a", claim_token: "t", commit_message: "Review x round 0", new_findings: [{ details: "issue", rationale: "why", severity, required_checks: ["check"] }] });
    for (const severity of FINDING_SEVERITIES) assert.ok(reviewSchema.check(findingArgs(severity)), severity);
    assert.ok(!reviewSchema.check(findingArgs("critical")), "a severity outside the model list is rejected");
    assert.equal(compile(api.tools.ledger_get_feature.parameters).check({}), false);
    for (const [name, params] of [
      ["ledger_get_feature", {}], ["ledger_orchestrate", { action: "release", id: "x" }],
      ["ledger_work", { action: "start", id: "x", agent_id: "  " }],
      ["ledger_work", { action: "start", id: "x", agent_id: "a", claim_token: "not-allowed" }],
      ["ledger_review", { action: "submit", id: "x", agent_id: "a" }],
    ] as const) assert.ok((await callUnvalidated(api, dir, name, { ...params, path })).isError, name);
  } finally { await cleanup(); }
});

// The problem lines name the values from the arrays that define them, so a tool cannot reject a value the
// shared gate accepts or report a different vocabulary for the same file.
test("problem lines list the allowed values from the model constants", () => {
  const doc = [
    "ledger:",
    "  features:",
    "    - id: alpha",
    "      status: wrong",
    "      short_goal: A",
    "      goal: A",
    "      assignment: { agent_id: a, role: wrong }",
    "      findings:",
    "        - id: f1",
    "          status: wrong",
    "          details: d",
    "          rationale: r",
    "          severity: critical",
    "          first_found_iteration: 0",
    "          required_checks: [c]",
  ].join("\n");
  const problems = checkLedger(doc);
  for (const expected of [
    `features[0] (alpha): status must be ${allowedValues(STATUSES)}, got wrong`,
    `features[0] (alpha): assignment.role must be ${allowedValues(ASSIGNMENT_ROLES)}`,
    `features[0] (alpha): findings[0].status must be ${allowedValues(FINDING_STATUSES)}`,
    `features[0] (alpha): findings[0].severity must be ${allowedValues(FINDING_SEVERITIES)}`,
  ]) assert.ok(problems.includes(expected), expected);
});
