# cwd guard

A Pi extension that reports the working-directory boundary to the model and refuses a bash command that would change directory across it. It never decides permissions itself: the decision comes from the permission rules that the installed pi-permission-modes package defines, applied to the live mode. This guard is not an access-control boundary; it only inspects `cd`, `chdir`, `pushd` and `popd` in the command text.

## What it does

- **Prompt section.** Before each agent start it adds a section with the key `cwd_boundary` that states the session working directory and tells the model to use absolute paths inside it. Its text is original work authored here.
- **Bash gate.** On each `bash` tool call it parses the command (including `bash -c` style wrappers), finds directory commands, and judges each target with the package's boundary functions and the active mode's `path` and `external_directory` rules, folded with the mode's project overlay. Only a denied crossing blocks, with a fixed one-line reason that names the boundary and the alternative. An `ask` or `allow` decision returns nothing, so the normal flow continues, including the package's own prompt.
- **Not guessed.** `cd -`, `cd +N`, `cd -N` and `popd` use the shell's own directory stack, which this extension cannot see. They are reported as stack references and never judged as paths. Flags such as `-L` and `-P` are skipped.
- **Parser fallback.** When tree-sitter cannot load, a small splitter tracks quote spans and skips heredoc bodies and redirection-leading segments.

The `cwd_boundary` key was checked against the keys in the package's `src/prompt-sections.ts` (`permission_mode`, `permission_mode_docs`, `permission_mode_steering`): it matches none of them, so it does not collide.

## Turning it off

Remove `extensions/cwd-guard/index.ts` from `pi.extensions` in the root `package.json`, or do not install the extension. There is no other switch; unsetting the variable does not disable the guard, because the package root is then derived (see [Package root](#package-root)).

## Package root

The guard loads the package's modules from one root, resolved in this order:

1. The explicit override: `export PI_CWD_GUARD_PERMISSION_MODES_ROOT=<package root>`.
2. Otherwise the derived default: `<agent dir>/npm/node_modules/pi-permission-modes`, with `<agent dir>` taken from Pi's agent directory.

The variable is optional. Pi sets nothing for it and there is no settings entry for it. When nothing loads from the resolved root, the guard warns once, naming the source (`explicit ...` or `derived default`) and the resolved root, then fails open.

Limitation: the default covers only the user-scope install under the agent directory. Project-scope installs (`.pi/npm/node_modules`), legacy global or pnpm installs, a custom `npmCommand` and Nix setups still need the explicit variable.

## Imports used

The extension imports no package path. `index.ts` loads these modules lazily from the root described in [Package root](#package-root), and `rules.ts` receives the functions as arguments: `src/bash-parse.ts`, `src/config-load.ts`, `src/heuristics.ts`, `src/paths.ts` and `src/resolve.ts`. The exact functions, the usage record, and the source's version and license terms are in [NOTICE](../../NOTICE); this README does not restate them. Documentation for the package ships with it; the session prompt names its docs directory, so read it there instead of copying it here.

When the package is absent or the root moved, the extension fails open: it warns once and passes commands through. A failure in parsing or config loading likewise passes the command through with one warning line.

## Live mode resolution

All Pi extensions run in the same Node process as pi-permission-modes, and the package writes `PI_PERMISSION_MODE` on every mode switch, including initial resolution. On each tool call the guard:

1. Reads `process.env.PI_PERMISSION_MODE` and, when set, looks that mode name up in the loaded mode config and judges by it.
2. Falls back to `config.defaultMode` from the config the package loads for the session directory when the variable is unset or names an unknown mode. The implicit headless-fallback path never writes the variable, so it can be stale or unset while a fallback mode is in effect.
3. Does not mirror the package's full pick precedence (flag, session entry, env, fallback, default).

The boundary roots are the package's sandbox allowed roots plus its also-inside roots for the raw `mode.sandbox`; session blocks and the platform profile are not reachable from outside the package.

Option B, for later: read the `perm-mode` custom session entries through `ctx.sessionManager.getEntries()` as a second channel for the active mode. It is not adopted because several paths persist nothing. Revisit it if the package exports an active-mode accessor.

## Limits

- Only `bash` is gated, and only directory-changing commands. A command that reaches outside by a path argument alone (for example `cat /etc/hosts`) is not inspected here; the package's own rules and sandbox apply.
- An unresolved variable such as `cd ${DIR}` is not guessed. Wrapper descent and boundary semantics belong to the package.
- Version drift: the guard depends on the package's internal modules, which have no `exports` map and may move. Re-run the probe after any package upgrade.
- Unit tests prove this repository's glue with stubbed package functions. They do not prove the package's boundary semantics; only the manual probe does.

## Upstream questions

Recorded, not blocking:

- Export `mostRestrictiveDetailed` from `src/resolve.ts`; it is module-private, so the guard folds with `mostRestrictive`.
- Export an active-mode accessor, which would replace the env lookup and settle option B.
- Which boundary roots the package considers canonical for an external-directory check.
- Wording of the package's own awareness text for the same boundary. This extension derives none of it.

## Tests

```sh
just cwd-guard test                                 # unit layer: rules.test.ts and index.test.ts, part of `just test`
just cwd-guard test -- --test-name-pattern=resolveMode   # Node options go after `--`
PI_CWD_GUARD_PERMISSION_MODES_ROOT=<package root> just cwd-guard probe   # manual probe (variable required here), never part of `just test`
```

The probe, `probe.integration.test.ts`, runs the real package composition against named expected outcomes. Only package code is read from the root; the session root, agent dir, `HOME` and mode config are temporary fixtures. The variable is required for the probe, though optional for the guard; without it every probe test is skipped. Run it by hand before merging and after a package upgrade, and record the result and the observed package version.

## Files

- `index.ts` — the adapter: `export default function cwdGuard(pi)`, the lazy package loader with fail-open degradation, `makeToolCallHandler` and `makeBeforeAgentStartHandler`.
- `rules.ts` — detection, judgment, composition, mode lookup (`resolveMode`), and the prompt-section and reason text. It takes the package functions as arguments and imports no package path.
- `rules.test.ts` and `index.test.ts` — the unit layer with fakes and temporary fixtures.
- `probe.integration.test.ts` — the manual probe, env-gated on `PI_CWD_GUARD_PERMISSION_MODES_ROOT`.
