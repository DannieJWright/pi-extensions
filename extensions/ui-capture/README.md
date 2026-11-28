# UI capture

`capture_server`, `capture_run`, and `capture_check` run on the host. Paths in a spec and the spec path resolve from the session's Git root. The project needs `playwright` or `@playwright/test` and Chromium. Playwright resolves from the optional `packageDirectory` passed to `capture_run` (CLI: `--package-directory`), otherwise `server.cwd`, then the Git root. Relative package directories resolve from the Git root; absolute paths are also accepted. This selection does not change `server.cwd`. A missing package reports the required dev dependency; a resolved package that fails to load reports its load error.

## Tools

- `capture_server`: `action` is `start`, `status`, `logs`, or `stop`; pass `spec` and optionally `tail` for status/logs. An external `url` is health-checked but never stopped; its uptime and logs are unavailable and `stop` returns `stopped: false`. If a spec switches from a server started by this session to an external URL, its owned server remains eligible for verified session cleanup, subject to `keep`. Existing owned records are isolated by worktree and spec; see the legacy cleanup limitations below.
- `capture_run`: pass `spec`, `phase` (`before` or `after`), and optionally `build` and `packageDirectory`. The server is checked before the browser opens and the browser applies the hydration gate. The result includes step outcomes, measurements, selected PNGs inline, and the diff when both phases are current. The build always includes the short Git HEAD and dirty/clean state; `build` adds a label.
- `capture_check`: pass `spec` and `answers` with boolean `visible`, `conditions_match`, `only_difference_is_the_feature`, and `same_target`, string arrays `preserved` and `measurements`, and string `note`. Measurement references look like `phases.after.measured.row`. `force: true` replaces an existing check only for the same current evidence. A new phase invalidates the previous check and diff.

A pair check approves only evidence it can still verify, so it rejects: no saved diff for the pair, a saved diff without a mask path or content hash, a mask file that is missing, a mask whose recorded hash no longer matches its published bytes, and a diff associated with different before/after phase evidence. This applies to `force: true` too. An existing sidecar written before mask hashes were recorded fails closed until the phase is captured again.

Capture output defaults to tracked `artifacts/<feature>/<subphase>/`. Set `UI_CAPTURE_ARTIFACTS` to a project-specific directory (relative to the Git root or absolute) to override it. The tool warns if output is ignored or outside the repository. It saves `capture.yaml`, `sidecar.json`, and `<phase>[-<name>].png` there. Secure artifact publication supports Linux and macOS; capture and pair checks fail closed on other platforms. Feature and subphase directories cannot be symlinks, and an existing sidecar symlink is rejected. Directory containment assumes the artifact root and its descendant directories are not moved or renamed during capture or pair checks; a directory moved outside the root can carry subsequent writes with it. Review returned images before answering the pair check. Pin fixture data and avoid building or running e2e tests against the same package while its capture server runs.

A capture or pair check holds an exclusive `.ui-capture.lock` in its artifact directory for the whole operation; concurrent operations on that directory fail rather than mixing evidence. Other artifact directories are independent. If a process crashes, the lock may remain: verify that no capture or pair check is still using the directory before manually removing it. Never remove a live lock. The tool does not automatically remove stale locks.

## Spec

```yaml
feature: example
subphase: 1
description: The change visible in the selected region
server:
  url: http://127.0.0.1:3000
  ready: {path: /app, selector: '#ready', not_text: Loading, timeout: 60}
conditions:
  entry: /app
  viewport: 1400x1000
  locale: en
  theme: dark
steps:
  - wait_for: '#ready'
  - focus: '#control'
  - measure: '#control'
    name: control
    fields: [box]
  - screenshot: {name: full}
diff:
  screenshot: full
  regions: {control: {target: '#control'}}
```

Exactly one of `url` and `start` is required. **Automatic host startup via `start` is currently unavailable on Linux and macOS**, including foreground and implicitly detached launchers: the previous process-group supervisor cannot contain a command that creates a new session. Until a safe containment backend exists, start the server yourself and use `url`; URL capture works on both platforms and never stops the external server. `ready.path` is an HTTP health check; `ready.selector` and `ready.not_text` are browser hydration checks. `ready.timeout` is seconds. Foreign servers and locks are never adopted or deleted.

Conditions also support `clock`, `storage`, `theme_storage`, `permissions`, and a recorded `fixture`; see [Condition values](#condition-values). Steps support `goto`, `fill`, `press`, `hover`, `click`, `scroll_to`, `wait_for`, `assert`, `screenshot`, `focus`, `read`, `measure`, and `eval`. `press` supports `repeat` or `until_stable`; reads and measurements require names. Screenshot options include `name`, `target`, `padding`, and `full_page`. When there are multiple screenshots, `diff.screenshot` selects the named screenshot. Diff regions are selectors or `[x, y, width, height]` in selected screenshot coordinates. The transparent diff mask marks changed pixels in red in before-image coordinates; moved region bounds are reported.

## Condition values

This section is the single list of condition values. `capture_run` and `capture_check` validate `conditions` before they take the artifact lock or launch a browser, so an invalid value fails immediately with a `conditions.<name>` message. Unknown keys are ignored.

- `theme`: `light` or `dark`. The driver passes it to Playwright as `colorScheme`; it also stores it when `theme_storage` names a key.
- `theme_storage`: a mapping. Its `key` names the `localStorage` entry that receives the `theme` value before the page loads, for apps that read their theme from storage. The key must be a non-empty string and requires `theme`.
- Project-named themes (any name other than `light` or `dark`) are not applied by the driver. The app applies them through the `theme_storage` key entry, through `storage`, or through its own state set by the fixture.
- `clock`: a non-empty date string or a finite number that `new Date(...)` parses to a valid date. Playwright installs it as the page clock.
- `viewport`: `WIDTHxHEIGHT` in positive integer pixels, for example `1400x1000`.
- `locale`: a string. `permissions`: an array of strings. `storage`: a mapping whose values are all strings, written to `localStorage` before the page loads. `entry`: a string path.

## Chromium sandbox fallback

The driver launches Chromium with its sandbox enabled. If that launch fails with an error object whose code or message indicates a sandbox restriction (an `EPERM` code or message, `No usable sandbox!`, `sandboxing failed`, or `operation not permitted`), it retries once with the sandbox disabled (`--no-sandbox`). A thrown value that is not an object is reported as it is, without a retry. This is the case when AppArmor sets `kernel.apparmor_restrict_unprivileged_userns=1`. If the retry also fails, the error reports both failures.

The match is broad on purpose, and nothing records which mode was used. Matching text from another cause, such as a permission error unrelated to the sandbox, silently takes the no-sandbox launch. The sandbox is then off for that browser.

Possible follow-up: run capture in a Docker container so Chromium keeps its sandbox without this fallback. Nothing implements it.

## Host command trust

Shell-free `just` commands are permitted by default; all other commands, including shell syntax, must match a full-command glob in `~/.pi/agent/ui-capture.jsonc`:

```jsonc
{ "allowedCommands": ["bun run --filter @example/web dev*"] }
```

The command trust policy is retained for existing records and other runtimes, but does not enable host startup. It is an operator trust policy, not a sandbox boundary: trusted recipes, `cwd`, environment, and `PATH` can run code on the host.

Legacy Linux-owned records can still be inspected and a healthy server reused with its original `start` spec. An unhealthy server cannot be automatically restarted. For a verified legacy supervisor, `stop` authenticates its control endpoint and stops only its own pinned process group; stale or unverified records cannot authorize a stop. Because the old supervisor could not contain escaped descendants, successful group cleanup still reports an incomplete-cleanup error and retains the ownership record. Inspect for and manually clean up any escaped owned processes before manually removing the stale record under `~/.pi/agent/ui-capture-servers/`; never signal a foreign or unverified process. The retained record does not prove that no descendants remain.

## CLI

Run from the target Git worktree, using the path to this extension:

```sh
node /path/to/extensions/ui-capture/cli.ts server start capture.yaml
node /path/to/extensions/ui-capture/cli.ts server status capture.yaml
node /path/to/extensions/ui-capture/cli.ts server logs capture.yaml 50
node /path/to/extensions/ui-capture/cli.ts run before capture.yaml
node /path/to/extensions/ui-capture/cli.ts run after capture.yaml my-build --package-directory packages/web
node /path/to/extensions/ui-capture/cli.ts check capture.yaml answers.json
node /path/to/extensions/ui-capture/cli.ts server stop capture.yaml
```

CLI server commands share legacy ownership records across invocations, subject to the cleanup limitation above. URL-mode `stop` does not stop the external server. `run` accepts `--package-directory <dir>` with or without a build label; its relative path is based on the Git root. `check` accepts `--force` after the answers file.

To permit these tools in permission mode, add `"capture_*": "allow"` to the appropriate tool permission entries in your user configuration. This extension does not edit that configuration.
