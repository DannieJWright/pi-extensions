# permission-mode generator

Reads `~/.pi/agent/permissions.src.jsonc` and generates `~/.pi/agent/permission-mode/permission-mode.json` and, when `subagents` is present, the `subagents` key of `~/.pi/agent/settings.json`. Edit the source, not the generated values. The starting sample is `configs/permissions.example.src.jsonc`. For an old source, follow [MIGRATION.md](MIGRATION.md).

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

## Source format

The top level has `permissionModes` and an optional `subagents`. Permission modes contain `output`, `fragments` and `modes`. Subagents contains `settings`, `fragments` and `agents`: `agents` becomes `settings.json`'s `subagents.agentOverrides`; an absent `agents` stays absent. Omitting `subagents` leaves settings and its baseline untouched. `subagents.config` is not yet supported and errors rather than being ignored. `//` and `/* */` comments and trailing commas are allowed; comments are not carried into the output. A value exactly shaped `{ "$file": "relative/path" }` reads that file as text relative to the source before merging.

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

## Merge rules

- `extends`: fragment or mode names, applied left to right, then the entry's own body.
  Unknown names and cycles are errors.
- Objects: deep merge. An inherited key keeps its position; a new key is appended at the end.
  Position matters for pattern maps, where the last matching key wins, so `*` must come first.
- `"$replace": true` in an object: replace the inherited object fully, in your own order.
- Arrays: replace. `"key+": [...]` appends to the inherited array (deduplicated).
- `null`: delete the inherited key. A type change (string to map) replaces.
- `extends`, `$replace`, and `key+` are stripped from the output.

## Mode prompts

Set `systemPrompt` to a string on any mode or fragment. Modes inherit it through `extends`, and can override it with another string or remove it with `null`. The source defines custom prompts for `plan` and `build`; `plan-local` inherits Plan, and `build-local` and `build-yolo` inherit Build. Default and YOLO do not have a custom prompt. Edit the source and regenerate; do not edit the output directly.

The custom Plan prompt keeps plan files and the `show_plan` display tool, but does not use the special `@plan` value. As a result, pi-permission-modes does not offer automatic plan approval or record a pending plan for `/plan approve`. Switching to Build and requesting implementation is the manual workflow. Neither the generator nor a mode switch deletes plan files. After changing the source, start a new session or run `/reload` to load the regenerated config; regeneration alone does not update a running extension.

Permissions and the sandbox change when the mode switches. The active mode's prompt is refreshed at the start of the next agent run, not partway through a run that is already active. For a clean Plan-to-Build handoff, let the Plan run finish, switch modes, then send a new request. If an idle switch still leaves Plan instructions in the next model request, capture that request's effective mode and prompt for investigation; do not treat historical Plan messages as active instructions.

## Drift

The modes baseline is `~/.pi/agent/permission-mode/.last-generated.json`; `~/.pi/agent/.subagents.last-generated.json` records the generated subagents value. Each output is checked independently. A differing existing output without a baseline is not adopted; matching output is adopted by `gen`, not `check`. Move changes into the source or deliberately overwrite with `just perm gen --force`. pi-subagents `disable`, `enable`, `eject` and `reset` modify the owned subagents key. `check` never writes, but concurrent writers may produce transient drift or read errors.

Each output and baseline is atomically replaced, but the pair is not an atomic transaction. The generator syncs the marker before publishing an output and syncs the output and baseline before removing the marker. It fails on sync errors; crash durability depends on the filesystem and storage honoring file and directory syncs. An interrupted update leaves a `.generator-pending` marker; inspect the output and source, then use `gen --force` to recover. Never remove the marker merely to suppress a warning. A missing marker after external tampering defeats this recovery.

For each new directory, the generator creates a `.generator-mkdir-<sha256-of-child-name>` symlink as creation intent in its parent, syncs the parent, and retains the intent until the new entry has been synced. A retry or competing generator recovers the intent before publishing; do not remove these intents manually while generators may be running. Names matching `.generator-mkdir-` followed by 64 lowercase hexadecimal characters are reserved in every component of a configured path, including symlink targets, whether or not an intent currently exists; such paths and other reserved-name conflicts fail closed. This requires symlink creation and directory sync support in parents where directories are created. Existing directories without an intent are assumed durable: in particular, directories left by an interrupted older generator, or made concurrently by other programs, cannot be distinguished from durable pre-existing directories. Ensure those ancestor entries are synced externally before generating if their durability is uncertain. This assumption avoids opening unrelated searchable-but-unreadable ancestors.

Generator locks are taken in sorted physical-path order for each output and baseline, then Pi's requested-path `settings.json.lock`, then pi-subagents' physical-target `settings.json.write-lock`. The source and its `$file` references are reread after acquiring the output locks; editing them concurrently with that read is not coordinated. Pi uses proper-lockfile's 10-second stale threshold; a paused holder can be reclaimed. Both installed protocols have non-atomic ownership-check/remove races; ownership checks here are best effort and a detected compromise fails closed. Pi checks whether settings exists before taking its lock, so a concurrent creation can race its missing-file write. Pi's requested-path lock does not coordinate distinct aliases of the same target; the physical lease coordinates pi-subagents, not Pi's other aliases. Uncooperative writers and hard links are not coordinated. Atomic rename preserves file mode, not inode identity, hard links, ownership, ACLs or other metadata. Settings writes resolve symlinks to the physical target. Directory or symlink changes by another process during a run remain a race.

## Files

- `configs/permissions.example.src.jsonc` — the committed example source. Copy it to `~/.pi/agent/permissions.src.jsonc` for a new installation.
- `../../lib/jsonc.ts` — comment and trailing-comma handling (shared with the other extensions).
- `merge.ts` — merge rules, no fs and no pi imports.
- `generate.ts` — `run()` plus the CLI entry; options are `--src`, `--modes-out`, `--modes-state`, `--settings`, `--subagents-state`, and `--force`.
- `migrate.ts` — conservative old-source and settings import.
- `../../lib/settings-lock.ts` — settings and generator output locks.
- `index.ts` — the pi extension: run at startup and `/reload`, report at `session_start`.
- `merge.test.ts` — `node:test` tests. Needs Node >= 22.12.
