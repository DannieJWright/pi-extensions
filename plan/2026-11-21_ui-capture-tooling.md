# UI capture tooling: server control, scripted steps, and snapshots without temp scripts

Status: design decisions approved; implementation follows the ledger order below.

## Why

A `worker` subagent that implemented `dock-floor-from-the-tab-row` in personal-assistant-mcp used about 55 of its 141
tool calls on the dev server and the capture. A main-agent session on the same branch wrote 25 scratch scripts. The
evidence and the gap list are in `.references/before-after-capture-skill-gaps/`.

The root cause: the skill ships a script, but the hard work is the environment (the server lifetime, the network path,
the browser launch). That work runs inside the bash sandbox, which the script cannot control. A subagent also has no
extension tools unless its agent definition lists them.

Pain points this plan removes:

| Id | Pain point | Fixed by |
|---|---|---|
| S1 | `just run --detached` fails in bash (read-only `/run/user/1000/just`); the `worker` has no `just_*` tools | `capture_server` runs outside the sandbox; `ui-worker` agent |
| S2 | Port and Next.js lock conflicts with a host server; the sandbox cannot see host PIDs; the agent deleted a lock it did not own | `url:` mode, `port: auto`, foreign-server report, never delete a lock |
| S4 | Turbopack cache crash when e2e tests built the same package during capture | Health check and one restart before each run; skill rule |
| S5 | No readiness or liveness signal; `sleep; curl; tail` polling | `ready` probe, health check, `logs` action |
| S6 | Proxy and relay paths that do not work together (`env -u HTTP_PROXY …` on every command) | Browser and server both run on the host |
| C1 | Shipped runner cannot run in the project (path, `lib/yaml.ts` import, `playwright` only) | Tools; Playwright resolved from the project |
| C2 | No `focus`, repeat, read, measure, or value assert; `measure.mjs` scripts | New verbs and an `eval` escape hatch |
| C3 | Sidecar overwritten by the second phase | One merged `sidecar.json` with `phases` |
| C4 | Hydration preflight scripts | `ready` gate in the spec |
| C5 | `Execution context was destroyed` when the page navigated mid-run | Settle after `goto` and after HMR; fail with a clear message |
| C6 | Extra `read` calls to see the images; no diff | Images and per-region diff returned inline |
| C7 | Sandbox `deny` noise in results | Tools run outside the sandbox |
| C8 | `SKILL.md` names a script in this repo (breaks `AGENTS.md`) | Skill names tools only |

Out of scope: the 60 s kill of a background shell (`366d19/meta.json`, `"reason": "timeout 60s"`). We move away from
background shells for this work.

## Decisions

| Topic | Decision |
|---|---|
| Where the work runs | A pi extension whose tools run outside the bash sandbox, like `just_*` and `ledger_*` |
| Server config | A `server:` block in each spec: a running server (`url`) or a launch command (`start`, optional `stop`) |
| Port | `port: auto` picks a free port and replaces `{port}` in `start` and `env`; a number fixes it |
| Foreign server or lock | Report it and stop. Never kill it or delete its lock. Use `url:` to reuse it |
| Command trust | Shell-free `just <recipe> …` is allowed by default. Other commands, and all shell syntax, must match a pattern in `~/.pi/agent/ui-capture.jsonc`. Check both start and stop; refuse others and name the line to add |
| Stop at session end | Stop only what the tool started, after verifying ownership. Never stop a `url:` server. `keep: true` leaves it running; detached launch and cross-invocation CLI ownership follow the contracts below |
| Tools | `capture_server`, `capture_run`, `capture_check` |
| Before frame | The current working tree, before the code change (current rule). A `ref:` worktree mode is a later phase |
| Page state | Declarative verbs plus an `eval` escape hatch; all results go into the sidecar |
| Images | Returned inline: before, after, and diff |
| Pixel diff | Per region, in the tool; Chromium's canvas decodes the PNGs (no new dependency) |
| Sidecar | One `sidecar.json` per pair: `phases.before`, `phases.after`, `diff`, `pair_check`; each run merges |
| Old layout | Not supported (`before.yaml`, `after.yaml`, `sidecar-<phase>.json`); old pairs are removed before merge |
| Playwright | Resolve `playwright`, then `@playwright/test`, from the selected project package directory, defaulting to `server.cwd` then the Git root. If neither resolves, name the dev dependency; report a resolved module's load error separately |
| Chromium sandbox | Launch with its own sandbox; retry with `--no-sandbox` only on EPERM |
| Paths | Resolve from the git toplevel of the session directory |
| Subagents | Ship `agents/ui-worker.md`, registered through `package.json` `pi.subagents.agents` |
| Ledger routing | The orchestrator workflow sends an item whose acceptance criteria ask for a before/after pair to `ui-worker` |
| CLI | Keep a CLI over the same core modules for humans and CI; document it only in the extension README. Cross-invocation server control uses verified persistent ownership as specified below |

## Approved implementation contracts

1. **Detached ownership.** Require a verifiable launcher-provided process identity and a stop mechanism scoped to that
   identity. A port, health check, or generic `stop: just run stop` is not proof. Refuse detached start or stop when
   ownership cannot be proved; never adopt a foreign listener. Check whether personal-assistant-mcp's launcher can
   provide the proof before promising that dry run.
2. **CLI lifetime.** Use a persistent supervisor or verified ownership record for cross-invocation server
   start/status/logs/stop. Define and test stale records, process identity reuse, shutdown, and `keep` behavior. Never
   infer ownership from a port. A missing or unverified record must not authorize stopping a process. Ownership must
   remain bound to the target through the signal operation: checking a PID or process group and then signalling its
   numeric ID leaves a reuse race. Apply this rule to stop, restart, startup cleanup, and shutdown.
3. **Diff images and coordinates.** Require a screenshot name when there is more than one. Record each region's bounds
   in both phases in that screenshot's coordinate space; compare corresponding crops and report moved bounds. Fail
   clearly for missing or out-of-bounds regions or unequal crop dimensions. Define and test the coordinate transforms
   for viewport, full-page and padded target screenshots, and define the mask coordinate space and name.
4. **Navigation replay.** Retry an observational or safely idempotent step at most once after navigation. A mutation
   that may already have taken effect fails with an uncertain-outcome error unless the spec explicitly opts into replay.
5. **Measurements and assertions.** Use the contract below and test it with deterministic fake-driver and DOM tests.
6. **Playwright anchor.** Resolve from an explicit package directory, defaulting to `server.cwd` then the Git root.
   Resolve relative paths from the Git root; test precedence and distinguish a missing package from a load error.
7. **Tracked-ledger handoff.** Commit the plan changes before starting. Keep the ledger tracked. Before each submit,
   protect unrelated untracked `.references/` locally; do not change or stage it. `ledger_submit` stages addable changes
   and commits while the ledger is `in-progress`, then writes `done`. After each successful item submission, commit the
   resulting done ledger status separately before starting the next item. Do not silently untrack the ledger.

### Measurement and assertion contract

- A missing selector, attribute, or computed property fails the step. A `measure` without `each: true` must match exactly
  one element. With `each: true`, record one result per match in document order under `phases.<phase>.measured.<name>`.
  Boxes use viewport-relative CSS pixels. Failed checks record expected and actual values.
- `equals` compares strings exactly. For a numeric expected value, convert a numeric attribute or computed value to a
  number and compare exactly; non-numeric values fail. `same_top` passes if the highest and lowest top coordinates
  differ by at most 0.5 CSS px. `inside` requires every target box to be inside the single named container, with the
  same 0.5 CSS px tolerance.
- `distinct_tops` records row positions and fails if they span more than 0.5 CSS px. `natural_row_width` requires an
  explicit container; sum the selected controls' current rendered widths, the container's column gaps between them,
  and its left and right padding. It fails if the sum exceeds the container width by more than 0.5 CSS px. The spec
  selects the controls; there is no implicit all-children or tabs-only rule. These are rendered, not intrinsic, widths.
- `until_stable` reads the attribute before pressing. After each press, wait until two consecutive samples 50 ms apart
  match, then compare with the value before the press. Stop when a press makes no change. Fail if the value does not
  settle within 2 seconds or still changes after `max` presses. Use a fake clock in tests.

The `.references/before-after-capture-skill-gaps/` material is currently untracked and may not exist in another
checkout. The plan contains the essential contracts; make any reference material needed for implementation available
in the chosen workspace without adding unrelated files to an item commit.

## Spec format

One spec per pair. The phase comes from the tool call, not the file. Specify exactly one of `server.url` and
`server.start`; reject a server block with neither or both. This example shows a detached launch's syntax. It can run
only if the launcher and stop mechanism meet the ownership contract above:

```yaml
feature: dock-floor-from-the-tab-row
subphase: 1
description: >
  What the reader must see. The pair check runs against this.
server:
  start: just run --detached          # {port} is replaced when used
  stop: just run stop                 # required when detached: true
  detached: true                      # true: start exits, the tool polls ready; false: the tool owns the process
  port: auto                          # or a number
  cwd: .
  env: { PORT: "{port}" }
  keep: false
  ready:
    path: /agent
    selector: 'section[aria-label="Sessions panel"]'
    not_text: Loading sessions        # hydration gate: fail while this text shows
    timeout: 60
conditions:
  entry: /agent                       # applied: first navigation
  viewport: 1400x1000
  clock: 2026-11-14T10:00:00.000Z
  locale: en
  theme: dark                         # applied: colorScheme plus an init script
  theme_storage: { key: theme }       # optional: localStorage key the app reads
  storage: {}                         # localStorage set before load; recorded in the sidecar
  permissions: [clipboard-write]
  fixture: agent fixture transport    # record only; fixture data is the project's job
steps:
  - wait_for: 'section[aria-label="Sessions panel"]'
  - focus: '[role=separator][aria-label="Resize panel dock"]'
  - press: ArrowRight
    until_stable: { target: '[role=separator][aria-label="Resize panel dock"]', attribute: aria-valuenow, max: 40 }
  - assert: '[role=tablist][aria-label="Panels"] [role=tab]'
    same_top: true
  - measure: '[role=tablist][aria-label="Panels"] > *'
    name: row_controls
    each: true
    fields: [box]
  - read: '[role=tablist][aria-label="Panels"]'
    computed: paddingLeft
    name: row_padding
  - eval: "getComputedStyle(document.documentElement).getPropertyValue('--dock-row-fit')"
    name: dock_row_fit
  - screenshot: { name: dock, target: 'section[aria-label="Sessions panel"]', padding: 16 }
  - screenshot: { name: full }
diff:
  screenshot: full                    # required when the spec has more than one screenshot
  regions: { "tab row": { target: '[role=tablist][aria-label="Panels"]' } }   # or [x, y, w, h]
```

To use a running server instead, replace the example's entire `server` block with this one. It is health-checked but
never stopped by the tool:

```yaml
server:
  url: http://127.0.0.1:3002
  ready:
    path: /agent
    selector: 'section[aria-label="Sessions panel"]'
    not_text: Loading sessions
    timeout: 60
```

Step verbs:
- Existing: `goto`, `fill`, `press`, `hover`, `click`, `scroll_to`, `wait_for`, `assert`, `screenshot`.
- New: `focus`, `read` (attribute, computed, custom property, text), `measure` (box, `each`, `derive: [distinct_tops, natural_row_width]`), and `eval` (a page expression whose JSON result is recorded).
- Options: `press` takes `repeat: N` or `until_stable`. `assert` takes `equals`, `inside`, and `same_top` with `attribute`/`computed`. `screenshot` takes `target`, `padding`, and `full_page`. Without a `screenshot` step, a run writes one viewport shot.

Output paths: `<artifacts>/<feature>/<subphase>/<phase>[-<name>].png`, and `sidecar.json` beside them. Default to
tracked `artifacts/` at the Git root; document a project override, resolve relative paths from that root, save the spec
beside the pair, and warn when the output is ignored. Validate path components so they cannot escape the artifact root.

The complete launch example and the same spec with the replacement URL block are acceptance fixtures. `lib/yaml.ts`
currently rejects a flow-map screenshot step, parses booleans as strings, and does not correctly handle quoted keys or
nested/quoted commas. Extend the parser or add a capture-specific normalization layer without new dependencies; preserve
feature-ledger parsing and round trips. Test both server modes, rejection of neither or both modes, booleans, quoted keys,
nested collections and comma-containing selectors.

## Tools

### `capture_server`

Parameters: `action` (`start` | `stop` | `status` | `logs`), `spec` (path), optional `tail`.

- `start`: checks transport/process readiness, not browser hydration. With `url:`, it only checks health. Otherwise it
  checks trust, picks the port, launches on the host, and returns the URL and log path after verified readiness. The
  browser applies `selector` and `not_text` later in `capture_run`. If the verified owned server for the same spec and
  worktree is already healthy, return its URL without launching another. Define timeout in seconds and test retry/timeout
  and repeated start with an injected clock and probe. On failed startup clean up only verified owned processes.
- Detect a foreign listener or framework lock message (for example `Another next dev server is already running`).
  Report PID and URL only when known, otherwise say they are unknown. Never remove the lock or adopt the listener.
  Fail closed on bind races, ignored ports, or an endpoint whose ownership cannot be established.
- `status`: alive or dead, URL, uptime, last log lines. `logs`: log tail. For an external `url:` server, report the
  health and URL; report server uptime and logs as unavailable, including for the `logs` action.
- Track servers per worktree. On `session_shutdown`, stop only verified owned servers unless `keep` is true. Preserve
  verified ownership across CLI invocations as specified above; an unverified process must not be stopped.

### `capture_run`

Parameters: `spec`, `phase` (`before` | `after`), optional `build` label.

1. Ensures the server: health check; if the server is dead and the tool started it, restart it once and include the log tail.
2. Resolves Playwright, launches Chromium, and builds the context from `conditions`.
3. Goes to `entry`, waits for `load`, applies the `ready` gate, and records console errors.
4. Runs the steps using the navigation replay contract above; do not assume that a mutation did not take effect.
5. Writes the PNGs and merges `phases.<phase>` into `sidecar.json`: success/failure, evidence identity, conditions,
   build (`git rev-parse --short HEAD` plus a dirty flag), input steps, outcomes, `measured`, `read`, console errors,
   and the resolved URL. On a failed step it still writes the failed step and error. Associate images with that run.
6. Replacing either phase, even on failure, invalidates the old `diff` and `pair_check`. Compute a new diff and
   condition match only for two successful, complete phases with current images. Compare canonical unexpanded spec
   hashes, conditions and normalized input step definitions, not runtime ports or recorded outcomes. Apply the diff
   screenshot and coordinate contract above.
7. Returns a compact text result (step outcomes, measurements, diff) and the applicable images inline. Select the
   screenshot and mask using the diff contract above; do not present stale images as current.

### `capture_check`

Parameters: `spec`, `answers` object, optional `force`.

Schema (one schema, validated):

```json
{
  "visible": true,
  "conditions_match": true,
  "only_difference_is_the_feature": true,
  "same_target": true,
  "preserved": ["tab labels", "panel order"],
  "measurements": ["phases.after.measured.row_controls"],
  "note": "…"
}
```

`measurements` names keys in the recorded evidence; it does not retype numbers. The tool refuses to overwrite an existing
`pair_check` without `force`. It refuses when either phase is missing, failed or incomplete, an image is stale, or the
current spec hash does not match both phase hashes. A new phase invalidates a prior answer; `force` only replaces a
check for the same current evidence.

## Command trust

- Parse a shell-free argv form before applying the default `just` exemption. Shell syntax, including metacharacters
  after `just`, does not qualify; it requires an explicit allowlist match. Reject malformed or ambiguous input.
- User allowlist: `~/.pi/agent/ui-capture.jsonc`, `{ "allowedCommands": ["bun run --filter @personal-assistant/web dev*"] }`, with glob patterns matched against the full command after `{port}` is replaced. Apply the same check to start and stop.
- Refusal text names the exact line to add. There is no prompt, so headless subagents behave the same.
- Use `shell: false` for argv commands. Document that trusted project recipes, `cwd`, environment and `PATH` can run
  code on the host: this is an operator trust policy, not a sandbox boundary. Test quoting, shell composition,
  untrusted stop commands and environment/PATH effects.

## Agent and ledger

- `agents/ui-worker.md`: the `worker` persona plus capture tools, project-generated just tools, and ledger tools
  required for start and submit. Load their providers and explicitly enable or select both the capture and ledger
  skills: the current worker has `inheritSkills: false`. Agent tool lists are strict exact-name allowlists, not glob
  patterns; choose a supported strategy for dynamic `just_*` names and test its permissions. Resolve extension paths
  relative to the agent file and test an installed package in another project.
- `package.json`: add `pi.subagents.agents: ["./agents"]` and the new extension to `pi.extensions`.
- `skills/feature-ledger/references/agents/orchestrator-workflow.md`: route an item whose acceptance criteria ask for a
  before/after pair to `ui-worker`. Today `ledger_next` and `ledger_list` do not return those criteria. Add a read-only
  item brief or other explicit pre-dispatch routing metadata; do not call `ledger_start` just to inspect it. Preserve
  implementor result validation. For an in-progress item, resume the original implementor only when its identity is
  known and the harness supports resumption; otherwise stop and report the item.
- Permission-mode source (user file, not in this repo): add `"capture_*": "allow"` beside `just_*`. The README states this.

## Skill rewrite (`skills/before-after-capture/SKILL.md`)

- Names the tools only; it names no script, CLI, or recipe from this repo.
- Flow: write the spec → `capture_run before` → implement → `capture_run after` → look at the returned images →
  `capture_check`.
- Rules kept: conditions match, the region rendered before the shot, a DOM attribute is not evidence, cleanup before merge;
  use tracked, non-ignored artifacts, save the spec beside the pair, pin fixture data, and verify the same elements are in view.
  The runner must produce the state that the feature changes (for example hover, focus or key press), not assume it.
- New rules: one spec per pair; do not run a build or e2e tests of the same package while the capture server runs; use
  `url:` to reuse a server the user already runs; never delete another server's lock.
- Project note: artifacts path, server block example, fixture clock.

## Files

| File | Change |
|---|---|
| `extensions/ui-capture/index.ts` | Tool registration, session state, shutdown hook |
| `extensions/ui-capture/spec.ts` | Spec parse and validation (uses `lib/yaml.ts`), spec hash |
| `extensions/ui-capture/steps.ts` | Verb runner over an injected driver (moved from `scripts/capture.mjs`) |
| `extensions/ui-capture/driver.ts` | Playwright driver: resolve, launch, conditions, ready gate |
| `extensions/ui-capture/server.ts` | Start, stop, health, ready poll, port pick, lock detection |
| `extensions/ui-capture/trust.ts` | Command allowlist |
| `extensions/ui-capture/sidecar.ts` | Merge, condition match, `pair_check` schema |
| `extensions/ui-capture/diff.ts` | Region diff through the page canvas |
| `extensions/ui-capture/cli.ts` | CLI over the same modules |
| `extensions/ui-capture/*.test.ts` | Tests (below) |
| `extensions/ui-capture/README.md` | Tools, config, CLI, permission entry |
| `skills/before-after-capture/SKILL.md` | Rewrite |
| `skills/before-after-capture/scripts/` | Remove `capture.mjs` and its tests (moved into the extension) |
| `agents/ui-worker.md` | New |
| `package.json` | Extension and agents entries |
| `justfile` | `ui-capture` recipe (`test`), added to `test` |
| `skills/feature-ledger/references/agents/orchestrator-workflow.md` and ledger API/tests | Read-only routing input, dispatch and resume behavior |
| `README.md` | List the extension |

## Tests

Deterministic: fake driver, fake process runner, fixture PNGs; no real time, no network, no browser.

- Spec: both complete server-mode examples, required fields, unknown verb, `server` needs exactly one of `url` or `start`,
  `detached: true` needs `stop`, and `{port}` replacement.
- Steps: every new verb records its result; `repeat`, `until_stable`, assertions and derives follow the resolved
  contract; test navigation before and after a mutation so a retry cannot duplicate an uncertain effect.
- Sidecar: phase merges, failed steps, current-spec checks, stale image rejection, and invalidation on every re-run;
  unchanged input steps with different outcomes or auto-ports still match. Validate and protect current `pair_check`.
- Server: both commands are trust-checked; test shell composition, foreign listeners, bind races, wrong ports, unknown
  lock details, failed launch, ownership/reused identity, repeated start, restart, URL-only unavailable status/log fields,
  and refusal to stop a foreign process.
- Diff: fixture counts and resolved screenshot/coordinate policy; missing, moved and out-of-bounds regions and unequal
  dimensions. Fake decoding in unit tests; exercise real canvas decoding and two-phase diff in the opt-in smoke test.
- Agent/ledger: routing before start, strict result protocol, fresh and resumed items, loaded providers, dynamic project
  tools and skill discovery in an installed package.
- Migrate applicable YAML tests out of the removed scripts. Ensure `just skills test` has a real remaining test or an
  explicitly tested empty-suite policy; `just test` includes that group.
- One opt-in smoke test (skipped when Playwright is not resolvable) against a static `node:http` server.

## Order of work

1. Core move: spec, steps, sidecar from `scripts/capture.mjs` into the extension, with tests.
2. Server control and trust, with tests.
3. Playwright driver, conditions, ready gate, diff.
4. Tools and session hooks; CLI; README.
5. Skill rewrite, `ui-worker` agent, ledger routing, `package.json`, justfile.
6. Check this draft with `ledger_check` and `just feature-ledger check plan/ui-capture/ledger.yaml`, then run `just test`.
   As a post-ledger gate, dry run on personal-assistant-mcp with `url:` against a running server and, if the launcher
   can prove ownership under the approved contract, with `start: just run --detached`. Record evidence or a clear
   limitation for each dry run.

## Later phase

- `ref: <commit>` for the before frame through a temporary git worktree (needs a dependency install).
- Viewport matrix in one spec (desktop and mobile in one run).
