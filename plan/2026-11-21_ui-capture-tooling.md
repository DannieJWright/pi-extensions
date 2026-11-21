# UI capture tooling: server control, scripted steps, and snapshots without temp scripts

Status: requirements resolved with the user. Ready for review. No code changed yet.

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
| Command trust | `just <recipe> …` is allowed by default. Other commands must match a pattern in the user-level allowlist `~/.pi/agent/ui-capture.jsonc`. Refuse others, and name the line to add |
| Stop at session end | Stop what the tool started (`stop` command for a detached launcher, process group kill for an owned process). Never stop a `url:` server. `keep: true` leaves it running |
| Tools | `capture_server`, `capture_run`, `capture_check` |
| Before frame | The current working tree, before the code change (current rule). A `ref:` worktree mode is a later phase |
| Page state | Declarative verbs plus an `eval` escape hatch; all results go into the sidecar |
| Images | Returned inline: before, after, and diff |
| Pixel diff | Per region, in the tool; Chromium's canvas decodes the PNGs (no new dependency) |
| Sidecar | One `sidecar.json` per pair: `phases.before`, `phases.after`, `diff`, `pair_check`; each run merges |
| Old layout | Not supported (`before.yaml`, `after.yaml`, `sidecar-<phase>.json`); old pairs are removed before merge |
| Playwright | Resolve from the project: `playwright`, then `@playwright/test`. If missing, fail with a message that names the dev dependency |
| Chromium sandbox | Launch with its own sandbox; retry with `--no-sandbox` only on EPERM |
| Paths | Resolve from the git toplevel of the session directory |
| Subagents | Ship `agents/ui-worker.md`, registered through `package.json` `pi.subagents.agents` |
| Ledger routing | The orchestrator workflow sends an item whose acceptance criteria ask for a before/after pair to `ui-worker` |
| CLI | Keep a CLI over the same core module for humans and CI; document it only in the extension README |

## Spec format

One spec per pair. The phase comes from the tool call, not the file.

```yaml
feature: dock-floor-from-the-tab-row
subphase: 1
description: >
  What the reader must see. The pair check runs against this.
server:
  # Either a running server: health check only, never stopped.
  url: http://127.0.0.1:3002
  # Or a launch:
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
  regions: { "tab row": { target: '[role=tablist][aria-label="Panels"]' } }   # or [x, y, w, h]
```

Step verbs:
- Existing: `goto`, `fill`, `press`, `hover`, `click`, `scroll_to`, `wait_for`, `assert`, `screenshot`.
- New: `focus`, `read` (attribute, computed, custom property, text), `measure` (box, `each`, `derive: [distinct_tops, natural_row_width]`), and `eval` (a page expression whose JSON result is recorded).
- Options: `press` takes `repeat: N` or `until_stable`. `assert` takes `equals`, `inside`, and `same_top` with `attribute`/`computed`. `screenshot` takes `target`, `padding`, and `full_page`. Without a `screenshot` step, a run writes one viewport shot.

Output paths: `<artifacts>/<feature>/<subphase>/<phase>[-<name>].png`, and `sidecar.json` beside them.

## Tools

### `capture_server`

Parameters: `action` (`start` | `stop` | `status` | `logs`), `spec` (path), optional `tail`.

- `start`: applies the trust check. With `url:`, it only checks health. Otherwise it picks the port, runs `start` on the host, polls `ready`, and returns the URL and the log path. When it is already running for this spec and worktree, it returns the URL.
- Detects a foreign listener on a fixed port, and a framework lock message in the log (for example `Another next dev server is already running`). It reports the PID and URL that the message names and stops.
- `status`: alive or dead, URL, uptime, last log lines. `logs`: log tail.
- Tracks servers per worktree in session state. On `session_shutdown`, stops the servers it started unless `keep: true`.

### `capture_run`

Parameters: `spec`, `phase` (`before` | `after`), optional `build` label.

1. Ensures the server: health check; if the server is dead and the tool started it, restart it once and include the log tail.
2. Resolves Playwright, launches Chromium, and builds the context from `conditions`.
3. Goes to `entry`, waits for `load`, applies the `ready` gate, and records console errors.
4. Runs the steps. On a navigation mid-step it settles and retries that step once. Otherwise it fails.
5. Writes the PNGs and merges `phases.<phase>` into `sidecar.json`: conditions, build (`git rev-parse --short HEAD` plus a dirty flag), steps, `measured`, `read`, console errors. On a failed step it still writes the record with the failed step and its error.
6. When the other phase exists, computes `diff` per region (pixel count and percent differing) and a condition match check (the same conditions, the same steps, the same spec hash).
7. Returns a compact text result (step outcomes, measurements, diff) and the images inline: this phase, and with both phases, before, after, and a diff mask.

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
`pair_check` without `force`. It refuses when a phase is missing or the spec hash differs between the phases.

## Command trust

- Allowed without config: a command whose first word is `just`.
- User allowlist: `~/.pi/agent/ui-capture.jsonc`, `{ "allowedCommands": ["bun run --filter @personal-assistant/web dev*"] }`, with glob patterns matched against the full command after `{port}` is replaced.
- Refusal text names the exact line to add. There is no prompt, so headless subagents behave the same.
- Commands run with `shell: false` where possible (split into argv). A command that needs a shell must match the allowlist.

## Agent and ledger

- `agents/ui-worker.md`: the `worker` persona plus `capture_server`, `capture_run`, `capture_check`, and the `just_*`
  tools. Loads `extensions/ui-capture/index.ts` and `extensions/just-tools/index.ts` through `extensions`. Inherits
  skills, so `before-after-capture` is available.
- `package.json`: add `pi.subagents.agents: ["./agents"]` and the new extension to `pi.extensions`.
- `skills/feature-ledger/references/agents/orchestrator-workflow.md`: route an item whose acceptance criteria ask for a
  before/after pair to `ui-worker`.
- Permission-mode source (user file, not in this repo): add `"capture_*": "allow"` beside `just_*`. The README states this.

## Skill rewrite (`skills/before-after-capture/SKILL.md`)

- Names the tools only; it names no script, CLI, or recipe from this repo.
- Flow: write the spec → `capture_run before` → implement → `capture_run after` → look at the returned images →
  `capture_check`.
- Rules kept: conditions match, the region rendered before the shot, a DOM attribute is not evidence, cleanup before merge.
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
| `skills/feature-ledger/references/agents/orchestrator-workflow.md` | Routing line |
| `README.md` | List the extension |

## Tests

Deterministic: fake driver, fake process runner, fixture PNGs; no real time, no network, no browser.

- Spec: required fields, unknown verb, `server` needs `url` or `start`, `detached: true` needs `stop`, `{port}` replacement.
- Steps: every new verb records its result; `repeat` and `until_stable` (stops when the value stops changing, fails at
  `max`); `assert` with `equals`, `inside`, `same_top` fails on a mismatch; `derive` checks; a mid-step navigation retries once.
- Sidecar: phases merge without loss; a failed step is recorded; the condition match fails on a different spec hash;
  `pair_check` refuses an overwrite without `force` and validates the schema.
- Server: trust allows `just …`, refuses others, accepts an allowlisted pattern; a foreign listener and a lock message
  are reported; a dead owned server restarts once; shutdown stops only what the tool started.
- Diff: region counts on fixture images (decoding is the driver's job and is faked).
- One opt-in smoke test (skipped when Playwright is not resolvable) against a static `node:http` server.

## Order of work

1. Core move: spec, steps, sidecar from `scripts/capture.mjs` into the extension, with tests.
2. Server control and trust, with tests.
3. Playwright driver, conditions, ready gate, diff.
4. Tools and session hooks; CLI; README.
5. Skill rewrite, `ui-worker` agent, ledger routing, `package.json`, justfile.
6. Run `just feature-ledger check` and `just test`. Dry run on personal-assistant-mcp with `url:` against a running
   server and with `start: just run --detached`.

## Later phase

- `ref: <commit>` for the before frame through a temporary git worktree (needs a dependency install).
- Viewport matrix in one spec (desktop and mobile in one run).
