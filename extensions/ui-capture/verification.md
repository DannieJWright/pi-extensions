# Target-project verification gate

Verification on Linux at pi-extensions commit `7d4af76` (before this record was added). This is a gate record, not a claim that the personal-assistant-mcp dry runs passed.

## URL-mode target capture: not run

No target server URL was supplied. From this sandbox, `curl --noproxy '*' -sS -m 2 http://127.0.0.1:<port>/agent` returned connection refused on ports 3000, 3001, 3002 and 3003. This only describes the sandbox network namespace; it does not establish whether a host server exists. Historical notes in `.references/before-after-capture-skill-gaps/before-after-capture-skill-gaps.md` describe a different session reaching port 3002 through a proxy, not a server verified for this run.

The target checkout and its launch configuration could not be inspected: listing `/home/nhbody/git` was denied by the execution policy, and the file tool also reported that `/home/nhbody/git/personal-assistant-mcp` was blocked by Build (local). No permission was requested again. No target server was started, adopted, or stopped; no target files were changed. Consequently there is no target capture spec, PNG, sidecar, or pair check to review. A future target run needs an accessible checkout, a supplied healthy URL reachable from the capture process, the project's Playwright/Chromium, and permission to write capture evidence outside the target project. Use URL mode without stopping the external server.

## Detached launcher: not run

The target launcher implementation was not accessible, so its provision of a verifiable launcher identity and identity-scoped stop mechanism is **unverified**, not proven compliant. The plan's example `just run --detached` / `just run stop` alone is not proof: a port, health check, or generic stop command does not establish ownership. Do not run that launcher as a managed capture until its ownership contract is verified.

Independently, automatic host startup currently fails closed on Linux and macOS for both detached and foreground commands because safe containment cannot be guaranteed. `extensions/ui-capture/server.ts` calls `assertLaunchSupported()` for a new managed server before launch. The following direct, side-effect-free check of the actual host runtime produced the refusal (it is not a managed-launch dry run):

```sh
node --input-type=module -e 'import { HostServerRuntime } from "./extensions/ui-capture/server-runtime.ts"; try { new HostServerRuntime().assertLaunchSupported(); } catch (e) { console.log(e.message); }'
# Automatic server launch is unavailable: safe containment cannot be guaranteed; start the server yourself and use server.url
```

A safe containment implementation and verified target launcher identity/stop contract are required before the managed target dry run. Existing ownership checks must not be bypassed.

## Opt-in real-browser CSP smoke: passed on Linux

`extensions/ui-capture/smoke.test.ts` ran with its own local static HTTP server, not personal-assistant-mcp. It serves a restrictive CSP, takes before and after target screenshots with a red-to-blue change, and verifies the canvas-decoded diff mask, 1,200/1,200 differing target pixels, sidecar success, one application page and no console errors. The test removes its temporary spec, screenshots and sidecar on completion; the reproducible assertions are the evidence, not retained PNGs.

The repository had no resolvable Playwright, so the first `UI_CAPTURE_SMOKE=1 UI_CAPTURE_SMOKE_NO_SANDBOX=1 node --test extensions/ui-capture/smoke.test.ts` was skipped with `Playwright does not resolve`. For the successful run, Playwright 1.57.0 and `@sparticuz/chromium` 143.0.4 were installed under the session scratch directory with npm scripts disabled. The package's Brotli-compressed Linux headless Chromium binary was decompressed into Playwright's expected `chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell` location under that same scratch directory. This is a packaged Chromium binary, not a Playwright-downloaded browser. Then:

```sh
UI_CAPTURE_SMOKE=1 UI_CAPTURE_SMOKE_NO_SANDBOX=1 \
  UI_CAPTURE_PLAYWRIGHT_DIR="$TMPDIR/browser" PLAYWRIGHT_BROWSERS_PATH="$TMPDIR/pw-browsers" \
  node --test extensions/ui-capture/smoke.test.ts
# tests 1, pass 1, fail 0, skipped 0
```

The first attempt after unpacking used an incorrect executable location and failed with `Executable doesn't exist`; moving the binary to the path printed in that error produced the passing result above. Chromium's sandbox was disabled because nested sandboxing is unavailable here. This smoke does not verify macOS, the target app, or managed server startup.

## Other checks

- `node extensions/feature-ledger/check.ts`: passed, reference ledger parses (2 features).
- `node --test extensions/ui-capture/smoke.test.ts`: passed as a test invocation but skipped the opt-in test by default.
- `just feature-ledger check` and `just test` could not run inside the sandbox: `just` could not create its temporary directory under `/run/user/1000/just` (`Read-only file system (os error 30)`). Item submission runs its required `just test` validation on the host; see the submission result for that outcome.
