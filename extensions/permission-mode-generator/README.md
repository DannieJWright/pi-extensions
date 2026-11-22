# permission-mode generator

Reads `~/.pi/agent/permissions.src.jsonc` and generates `~/.pi/agent/permission-mode/permission-mode.json`, the `subagents` key of `~/.pi/agent/settings.json` when `subagents` is present, and selected `~/.pi/agent/extensions/subagent/config.json` keys when `subagents.config` is present. Edit the source, not the generated values. The starting sample is `configs/permissions.example.src.jsonc`. For an old source, follow [MIGRATION.md](MIGRATION.md).

## Use

```sh
just perm                 # gen: write the output when it is clean
just perm check           # compare the output with the last generated result, write nothing
just perm gen --force     # overwrite a drifted output
just perm migrate         # import the old source and current subagents settings
just perm test            # run generator, migration, merge and lock tests
```

Flags after `--` pass through, for example `just perm test -- --only merge`.

The extension runs the same code path at startup and on `/reload`. It writes when the output is
clean, reports a diff when the output has drifted, and says nothing when there is no change.
The factory completes before `session_start`, so pi-permission-modes reads the generated file in the same session. The installed pi-subagents reads settings during agent discovery and refreshes its discovery cache on `session_start`; its subsequent discovery observes the generated settings. Pi's own settings manager loads before extension factories and `/reload` reloads the manager before factories, so other Pi settings consumers may need another `/reload` or a new session. Project `.pi/settings.json` overrides user subagent settings.

The installed pi-subagents launch-contract preflight calls `loadConfig()` during resolution, rereading config.json for default context and permission rules. Normal extension execution instead uses the config captured by the pi-subagents extension factory, including its permissions. If that factory runs before the generator, preflight can therefore report the new config while execution still uses the old one. Run `/reload` again (or start a new session) after generation to refresh the execution config; the same factory-order caveat applies on `/reload`. This describes the installed implementation, not a guarantee about other pi-subagents versions or execution entry points.

## Source format

For a new installation copy the configuration only. Prompt text is not copied to a fixed location: a prompt value names files, and the assembled result becomes the effective prompt at generation time.

```sh
cp configs/permissions.example.src.jsonc ~/.pi/agent/permissions.src.jsonc
```

The example references two files this repository owns — its own addendum (`configs/prompts/reviewer-addendum.md`) and an illustrative agent fixture for the test layer (`test-fixtures/agents/agent-with-frontmatter.md`) — through the multi-part form described in [Prompt values](#prompt-values). A comment in the example shows the real-world form pointing at an installed package (`~/npm/node_modules/pi-subagents/agents/reviewer.md`). An install path is machine-specific, so adjust it as the other paths already in the example must be adjusted; a reference to a package that is not present fails with the named path. Nothing here is a copy of another project's prompt body, so no document restates a third-party source: sources are recorded once in the repository-root `NOTICE`, which `LICENSE` points to rather than repeating. Generation of your own configuration depends on what is installed, so output can change across `pi-subagents` versions; pinning is by the version documented in `NOTICE`, not by a committed copy, and a drift report will show such a change as a difference. Checking against a real install is a manual step gated on that recorded version — it is not part of `just test`.

A relative reference resolves against the source file, so it only works while the source stays where the example puts it. Run the example in place, or name absolute paths for your own files; copying a referenced file somewhere else changes what the reference resolves to.

The sample replaces the whole user `subagents` key. Its worker incorporates the operator-supplied live override (including its ledger extension and mutation tools), adds `ledger_list` and the Git read tools, and uses `~` in the provider path for portability. Preserve and compare your existing settings before using it, and update extension paths to match your installation. The tested loader deduplicates ambient and explicit providers only when both paths resolve to the same file; see [Git tools](../git-read-tools/README.md).

When pi-permission-modes is loaded, the sample allows ledger reads in common modes and ledger mutations in Build, denies mutations in Plan, and asks for mutations in Default. YOLO allows all tools and has no Bash sandbox. Direct ledger operations bypass ordinary file-tool path gating, and `ledger_submit` intentionally runs validation outside the Bash sandbox. These are accepted features, not defects solely on that basis; use trusted ledger paths, workspaces, and validation scripts and consider other security issues. An omitted path can resolve through the environment or `plan/ledger.path`. The Default tool-name prompt does not display arguments or the resolved path; session and forever grants cover later calls as well.

The sample leaves `subagents.config` inactive, so existing native child rules remain effective. Foreground children in the tested pi-subagents version do not load ambient permission-mode extensions; consequently the sample mode policy is not enforced there unless another effective mechanism is configured. Background children load ambient extensions in the tested builder. Project settings, per-agent rules, and external runners can change enforcement; inspect the effective configuration before delegating.

### Runtime probes

The sample integration tests always check generated files, but runtime probes skip unless package roots are supplied. To run them with compatible installed packages and their resolvable dependencies:

```sh
PI_PACKAGE_DIR=/path/to/pi-coding-agent \
PI_GIT_TOOLS_SUBAGENTS_ROOT=/path/to/pi-subagents \
PI_GIT_TOOLS_PERMISSION_MODES_ROOT=/path/to/pi-permission-modes \
node --test extensions/permission-mode-generator/sample-integration.test.ts
```

The first two roots enable the foreground-builder probe; all three enable the background and permission-mode probes. The probes were exercised with Pi 1.6.0 and pi-subagents 0.89.2; other versions may differ. Optional peer dependencies must resolve from the pi-subagents package location. Tests use disposable home, agent settings and repositories, not live settings. The test layer reads only this repository's own fixture files: unit tests author their fixtures in temporary directories, and the golden-fixture comparison reads `sample.expected.json` plus the agent fixtures under `test-fixtures/agents/`. No test reads an installed package, so results do not change with what happens to be installed. Comparing against a real install is a manual step, gated on the version recorded in the repository-root `NOTICE`; the runtime probes below are that manual step and are opt-in.

The background-builder probe starts a separate OS subprocess (detached on non-Windows), builds the installed background runner's child launch, loads the generated Build mode and emits synthetic tool-call events. The foreground probe builds a session without ambient extensions and shows the absence of the sample mode gate. The permission-mode probe checks the Default, Plan and Build gates and invokes ledger providers against a disposable ledger. These are not full pi-subagents detached runner launches, model requests, or end-to-end child tool execution; they do not establish all real launch paths or enforcement by existing native rules.

The top level has `permissionModes` and an optional `subagents`. Permission modes contain `output`, `fragments` and `modes`. Subagents contains `settings`, `config`, `fragments` and `agents`: `agents` becomes `settings.json`'s `subagents.agentOverrides`; an absent `agents` stays absent. Omitting `subagents` leaves settings and its baseline untouched. Omitting `subagents.config` does not read or change config.json and retains its previous baseline; the existing pi-subagents config remains effective. An existing `config` entry owns its resolved top-level keys; previously owned keys removed from the entry are removed from the file, while unrelated keys are preserved. `config.extends` resolves against subagents fragments only. Validation covers `permissions` in the final merged file, including an unowned existing value, and reserves both `bg_wait` and the effective `waitTool.name`. It does not validate every other pi-subagents config key. `//` and `/* */` comments and trailing commas are allowed; comments are not carried into the output. A prompt value may be a string or a reference object; see [Prompt values](#prompt-values) for both forms.

```jsonc
{
  "permissionModes": {
    "output": { "defaultMode": "default", "cycleOrder": ["default", "plan"] },
    "fragments": { "common": { "permission": { "read": "allow" } } },
    "modes": { "default": { "extends": ["common"], "label": "Default" } }
  },
  "subagents": { "settings": {}, "agents": { "worker": { "tools": ["read"] } } }
}
```

### Prompt values

One resolver handles prompt values in both scopes: `permissionModes.*.systemPrompt` (modes and fragments) and `subagents.agents.*.systemPrompt`. A value is either a plain string or one of two object forms.

The legacy form is an object with exactly the single key `$file`, whose value is a path string. Its content is returned verbatim, and unknown sibling keys are not rejected there — so keep that form single-key: adding a sibling key makes the object read as ordinary data rather than as a reference.

The multi-part form is an object containing `files` and/or `text`, with at least one present. Inside this form these are errors naming the key path: an empty `files` entry, `text` that is not a string, or nothing to join (`files` empty with no `text`). A value containing neither `files` nor `text` is not read as this form: at a prompt position it passes through unchanged as ordinary data, per the precedence rule below. Each `files` entry is a path string or `{ path, stripFrontmatter? }`; `text` must be a string. Keys outside `files` and `text` in this form are rejected with the generator's usual `${keyPath}: ...` message. Precedence: an object that contains `files` or `text` is read as this form even when it also carries `$file`.

```jsonc
"systemPrompt": {
  "files": [
    { "path": "~/npm/node_modules/pi-subagents/agents/reviewer.md", "stripFrontmatter": true },
    { "path": "prompts/reviewer-addendum.md", "stripFrontmatter": true }
  ],
  "text": "optional extra paragraph appended last"
}
```

Paths in both forms may be absolute, `~/...` from the user's home directory, or relative to the source file (`../` works through normal resolution). `~` expansion applies to every prompt path, including the legacy single-`$file` form. A skill file or a configuration may name files outside the repository; nothing requires them to live inside it.

Frontmatter is kept by default. Only an entry written with `stripFrontmatter: true` has a leading block delimited by `---` lines at offset 0 removed, and its fields are not interpreted. An opening delimiter with no closing one is an error naming the key path and the file. A file without frontmatter is returned unchanged whether or not the flag is set, so every entry naming a file that does have frontmatter needs the flag — otherwise the frontmatter leaks into the assembled prompt.

Parts are read in order, trailing whitespace at each boundary is normalized, and they are joined with exactly one blank line. The legacy single-`$file` form keeps returning file content verbatim instead of joining anything. A missing referenced file is a hard error naming the key path and the resolved path. Resolution does not mutate the source object.

No provenance record is stored in generated output: the configuration itself names the files each prompt uses, and the repository-root `NOTICE` carries the licensing record. The generator still writes the current single-line `$comment` header, and the sample comparison keeps its exact-equality check on it.

Inheritance semantics are unchanged because references are resolved before merge rules run: modes inherit the assembled string through `extends`, override it with another string or form, and remove it with `null`.

## Merge rules

- `extends`: a fragment name, or a sibling entry in the same section (`modes` or `agents`).
  Applied left to right, then the entry's own body. Unknown names and cycles are errors.
  A fragment wins over an entry with the same name.
- Objects: deep merge. An inherited key keeps its position; a new key is appended at the end.
  Position matters for pattern maps, where the last matching key wins, so `*` must come first.
- `"$replace": true` in an object: replace the inherited object fully, in your own order.
- Arrays: replace. `"key+": [...]` appends to the inherited array (deduplicated).
- `null`: delete the inherited key. A type change (string to map) replaces.
- `extends`, `$replace`, and `key+` are stripped from the output.

### Shared agent base

Define the common tool set once as a fragment, then let each variant extend it. Each key under
`subagents.agents` stays launchable under its own name, so a base you write as an agent is also
callable; use distinct names for variants. Agent discovery priority is defined in the pi-subagents
`docs/agents.md`; read it there instead of restating it here.

```jsonc
{
  "subagents": {
    "fragments": {
      "workerBase": { "tools+": ["read", "grep", "find", "ls", "bash", "contact_supervisor"] }
    },
    "agents": {
      "worker-ledger": {
        "extends": ["workerBase"],
        "tools+": ["ledger_check", "ledger_list", "ledger_next", "ledger_start", "ledger_submit"],
        "mutationTools+": ["ledger_start", "ledger_submit"]
      },
      "worker-gitread": {
        "extends": ["workerBase"],
        "tools+": ["git_r_diff", "git_r_status", "git_r_log", "git_r_show"]
      }
    }
  }
}
```

To narrow a variant: `"tools"` replaces the inherited array, `"tools+"` appends to it, and `null`
deletes an inherited key. Hand-written settings values shaped like `extends`, `$replace`, or `key+`
are reinterpreted by the generator; see [MIGRATION.md](MIGRATION.md).

## Mode prompts

`systemPrompt` on any mode, fragment, or agent is either a string or a reference object; see [Prompt values](#prompt-values). Modes inherit it through `extends`, and can override it with another string or another form, or remove it with `null`. The source defines custom prompts for `plan` and `build`; `plan-local` inherits Plan, and `build-local` and `build-yolo` inherit Build. Default and YOLO do not have a custom prompt. Edit the source and regenerate; do not edit the output directly.

The custom Plan prompt keeps plan files and the `show_plan` display tool, but does not use the special `@plan` value. As a result, pi-permission-modes does not offer automatic plan approval or record a pending plan for `/plan approve`. Switching to Build and requesting implementation is the manual workflow. Neither the generator nor a mode switch deletes plan files. After changing the source, start a new session or run `/reload` to load the regenerated config; regeneration alone does not update a running extension.

Permissions and the sandbox change when the mode switches. The active mode's prompt is refreshed at the start of the next agent run, not partway through a run that is already active. For a clean Plan-to-Build handoff, let the Plan run finish, switch modes, then send a new request. If an idle switch still leaves Plan instructions in the next model request, capture that request's effective mode and prompt for investigation; do not treat historical Plan messages as active instructions.

## Drift

The modes baseline is `~/.pi/agent/permission-mode/.last-generated.json`; `~/.pi/agent/.subagents.last-generated.json` separately records generated settings and owned config values. Each output is checked independently. A differing existing output without a baseline is not adopted; matching output is adopted by `gen`, not `check`. Move changes into the source or deliberately overwrite with `just perm gen --force`. pi-subagents `disable`, `enable`, `eject` and `reset` modify the owned subagents key. `check` never writes, but concurrent writers may produce transient drift or read errors.

Numbers must survive JSON parsing and serialization without changing their decimal value. Every numeric token is checked, including values overwritten by duplicate keys; numbers inside strings and JSONC comments are not tokens. The generator rejects source numbers such as `-0`, `1e400`, `1e-400`, and `9007199254740993`, rather than producing a changed value or perpetual drift. Before `gen` (including `--force`), it also checks all active outputs and baselines, including unrelated settings and config keys; fix any reported number manually before generating. `check` retains the existing comparison semantics for output files, but rejects unsafe source numbers. Migration applies the same conservative check to the entire old source and settings file, even unrelated settings, before creating the new source. Equivalent decimal spellings such as `1.00` and `1` are accepted.

Each output and baseline is atomically replaced, but the pair is not an atomic transaction. The generator syncs the marker before publishing an output and syncs the output and baseline before removing the marker. It fails on sync errors; crash durability depends on the filesystem and storage honoring file and directory syncs. An interrupted update leaves a `.generator-pending` marker; inspect the output and source, then use `gen --force` to recover. Never remove the marker merely to suppress a warning. A missing marker after external tampering defeats this recovery.

For each new directory, the generator creates a `.generator-mkdir-<sha256-of-child-name>` symlink as creation intent in its parent, syncs the parent, and retains the intent until the new entry has been synced. A retry or competing generator recovers the intent before publishing; do not remove these intents manually while generators may be running. Names matching `.generator-mkdir-` followed by 64 ASCII hexadecimal characters are reserved case-insensitively across the entire name in every component of a configured path, including symlink targets, whether or not an intent currently exists; such paths and other reserved-name conflicts fail closed. This requires symlink creation and directory sync support in parents where directories are created. Existing directories without an intent are assumed durable: in particular, directories left by an interrupted older generator, or made concurrently by other programs, cannot be distinguished from durable pre-existing directories. Ensure those ancestor entries are synced externally before generating if their durability is uncertain. This assumption avoids opening unrelated searchable-but-unreadable ancestors.

Generator locks are taken in sorted physical-path order for each active output (including config.json) and baseline, then Pi's requested-path `settings.json.lock`, then pi-subagents' physical-target `settings.json.write-lock`. Config is reread, checked, atomically written and its shared baseline updated while these locks are held. The installed pi-subagents config update code has no config.json lock, so concurrent pi-subagents writes can race the generator. The source and its `$file` references are reread after acquiring the output locks; editing them concurrently with that read is not coordinated. Pi uses proper-lockfile's 10-second stale threshold; a paused holder can be reclaimed. Both installed protocols have non-atomic ownership-check/remove races; ownership checks here are best effort and a detected compromise fails closed. Pi checks whether settings exists before taking its lock, so a concurrent creation can race its missing-file write. Pi's requested-path lock does not coordinate distinct aliases of the same target; the physical lease coordinates pi-subagents, not Pi's other aliases. Uncooperative writers and hard links are not coordinated. Atomic rename preserves file mode, not inode identity, hard links, ownership, ACLs or other metadata. Settings and config writes resolve file symlinks (including dangling links) to the physical target; existing modes are preserved and new files use mode 0600. Directory or symlink changes by another process during a run remain a race.

## Files

- `configs/permissions.example.src.jsonc` — the example source. It references prompt files instead of carrying a prompt body; its own added text is `configs/prompts/reviewer-addendum.md`, which states precedence over any conflicting statement above it.
- `test-fixtures/agents/agent-with-frontmatter.md` and `test-fixtures/agents/agent-without-frontmatter.md` — small illustrative agent files owned by this repository, used by the test layer in place of an installed package. Their text is original here; no prompt body from another project is committed, and third-party sources are recorded once in the repository-root `NOTICE`.
- `../../lib/jsonc.ts` — comment and trailing-comma handling (shared with the other extensions).
- `merge.ts` — merge rules, no fs and no pi imports.
- `generate.ts` — `run()` plus the CLI entry; options are `--src`, `--modes-out`, `--modes-state`, `--settings`, `--subagents-state`, `--subagent-config`, and `--force`.
- `migrate.ts` — conservative old-source and settings import.
- `../../lib/settings-lock.ts` — settings and generator output locks.
- `index.ts` — the pi extension: run at startup and `/reload`, report at `session_start`.
- `merge.test.ts` — `node:test` tests. Needs Node >= 22.12.
