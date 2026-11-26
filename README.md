# pi-extensions

Pi extensions as one package:

- `extensions/just-tools/` — exposes the justfile recipes as tools. See its README.
- `extensions/provider-rules/` — injects per-provider/model prompt rules, and recovers when a local model's response is truncated by thinking. See its README.
- `extensions/permission-mode-generator/` — generates permission modes and optional subagent settings from `~/.pi/agent/permissions.src.jsonc` (example source in `configs/`). See its README, including [Merge rules](extensions/permission-mode-generator/README.md#merge-rules) and [Shared agent base](extensions/permission-mode-generator/README.md#shared-agent-base), and its migration guide.
- `extensions/feature-ledger/` — provides feature ledger tools.
- `extensions/git-tools/` — provides the Git tools. Its tools today are read-only inspection. See its README.

## Setup on a new machine

1. Clone, then attach the package to Pi:

   ```sh
   pi install git:github.com/DannieJWright/pi-extensions
   # or, for a local checkout: pi install ~/git/pi-extensions
   ```

2. Copy the example configs to the live locations:

   ```sh
   mkdir -p ~/.pi ~/.pi/agent ~/.pi/agent/permission-mode
   cp configs/just-tools.example.jsonc ~/.pi/just-tools.jsonc
   cp configs/provider-rules.example.jsonc ~/.pi/agent/provider-rules.jsonc
   cp configs/permissions.example.src.jsonc ~/.pi/agent/permissions.src.jsonc
   ```

   No prompt file is copied: the example source references prompt files instead, and the merged result is the effective prompt. A referenced file does not have to live inside this repository, and nothing has to be copied for a reference to work — a relative reference simply resolves against the source file, so run the example where the example puts it or use absolute paths.

3. Requirements: `just` on PATH, and Node 22.6+ (type stripping) to run the `.ts` entry points and `node --test`. Run `npm install` once for the test devDependency (`@earendil-works/pi-ai`).

4. Justfile: for sessions started outside the repo, put a thin wrapper at `~/.pi/justfile`:

   ```just
   import "<path>/pi-extensions/justfile"
   ```

   Sessions started in the repo can run `just` directly. A prompt reference resolves relative to the source config, so a path that names an installed package (such as `~/npm/node_modules/pi-subagents/agents/reviewer.md`) has no fixed form: adjust it for your machine, and expect generation on a fresh machine to fail naming that path until the package is present. Reference paths may be absolute, `~/...` from your home directory, or relative to the source file; `~` expansion applies to the legacy single-key `{ "$file": "..." }` form too. Prompt frontmatter is kept unless an entry sets `stripFrontmatter: true`. A relative reference, including the example's fixture path, only resolves while the source config stays where the example puts it. Run `just perm` to generate from `~/.pi/agent/permissions.src.jsonc`: the `permissionModes` section writes `~/.pi/agent/permission-mode/permission-mode.json`, and `subagents` optionally owns the `subagents` key in `~/.pi/agent/settings.json` and selected keys in `~/.pi/agent/extensions/subagent/config.json`. Existing installations should follow [the migration guide](extensions/permission-mode-generator/MIGRATION.md), read [Merge rules](extensions/permission-mode-generator/README.md#merge-rules) and [Shared agent base](extensions/permission-mode-generator/README.md#shared-agent-base) before writing inheritance by hand, and use `just perm migrate` instead of copying the example. The sample incorporates the operator-supplied worker override and adds `ledger_list` and the Git tools; compare and preserve any other existing settings before generating. Adjust extension paths to your install. Live files and baselines are not committed.

Do not keep duplicate copies of these extension files under `~/.pi/agent/extensions` — Pi would load them twice.

An earlier version named the Git tools folder `extensions/git-read-tools/`. It is now `extensions/git-tools/`: re-run `pi install`, and update any `subagentOnlyExtensions` or `extensions` entry that names the old path.

## Argument shapes

A model can send an array or object argument as JSON text, for example the string "[1]" where a tool expects an array. A tool argument is decoded before validation when the property schema is an array or object and the decoded value is accepted by that schema. This rule is implemented once, in `lib/args.ts`. All tools that use it share this one implementation.

The decode follows the schema of the property. Pi validation can coerce a decoded value to the type the schema declares. For example, if `required_checks` is an array of strings and the model sends the text "[1]", the decoded array is recorded as ["1"].

If the schema does not accept the decoded value, the argument is not changed. The call then fails with a clear validation error, the same as before.

## Tests

```sh
just test                    # each group reported separately: perm generator test, perm sample test, subagent config test,
                             # just-tools, git-tools, cwd-guard, provider-rules check, feature-ledger check and test, skills test
just perm test               # the same generator, merge, migration and lock tests plus the sample comparison, run together with no group split
just provider-rules test     # provider rules tests
just cwd-guard test          # cwd-guard unit layer (also a group of `just test`)
PI_CWD_GUARD_PERMISSION_MODES_ROOT=<package root> just cwd-guard probe   # manual probe against an installed package; not part of `just test`
```

No test reads an installed package. Unit tests author their own fixtures in temporary directories; the sample group (`perm sample test`) compares against this repository's committed golden fixture and its own agent fixture files under `extensions/permission-mode-generator/test-fixtures/agents/`, so results do not change with what happens to be installed. Checking a real install is a manual step, gated on the version recorded in `NOTICE`, and is not part of `just test`. Third-party sources are named once in `NOTICE`; docs link to it instead of restating them.

Every group runs under an isolation guard (`tests/suite-isolation-guard.mjs`). `just test` loads it
through NODE_OPTIONS, so every child process inherits it. The guard blocks access to personal Pi
configuration and records any attempt as a failure naming the operation and path. The sample group
generates `configs/permissions.example.src.jsonc` into a temporary directory and compares the result
against `extensions/permission-mode-generator/sample.expected.json`, using a temporary generator
baseline. It validates `configs/provider-rules.example.jsonc` rather than a personal provider
configuration. The ledger check uses `skills/feature-ledger/references/ledger.yaml`; its tests use
temporary repositories. The just-tools and capture tests use temporary homes, logs, and outputs.
Feature-ledger test helpers and fixtures live alongside the extension tests; their Git subprocesses
use isolated configuration and repositories. Suite-wide isolation coverage lives in `tests/`.

These isolated tests are distinct from explicitly invoked personal operations: `just perm gen` and
`just perm check` use the live permission-mode source, output, and baseline by default;
`just provider-rules check` uses the live current or legacy provider configuration by default.
The generator CLI also accepts `--src`, `--out`, and `--state`; supply all three to operate on other
files. When the example source changes, update `extensions/permission-mode-generator/sample.expected.json`
by hand, review the result, and commit it alongside the source.

## Credits

Content taken from another repository is recorded once in [NOTICE](NOTICE): its source repository,
license, copyright holder, the version observed, where the content is used here, what was changed,
and that source's copyright and permission notice. `LICENSE` covers only the original work authored
in this repository and points to `NOTICE` for third-party terms. This README names no individual
source because `NOTICE` is the single record; docs link to it instead of restating an entry. Before
taking code or snippets from another repository, update `NOTICE` and honor that source's license
terms — see [AGENTS.md](AGENTS.md#content-taken-from-other-repositories).
just test                    # all repository checks and test groups, with a per-group summary
just provider-rules test     # provider-rules unit and CLI tests
just perm test               # permission-mode generator and merge tests
node --test tests/suite-isolation.test.ts  # full-suite isolation regression (runs the suite three times)
```

