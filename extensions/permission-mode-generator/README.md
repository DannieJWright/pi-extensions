# permission-mode generator

Reads `~/.pi/agent/permission-mode/permission-mode.src.jsonc` and writes
`~/.pi/agent/permission-mode/permission-mode.json`. You edit the source; the output is generated.
Do not hand-edit the output. The source, the output, and the drift baseline live in the same
directory; the repo keeps only `configs/permission-mode.example.src.jsonc` as the starting point.

## Use

```sh
just perm                 # gen: write the output when it is clean
just perm check           # compare the output with the last generated result, write nothing
just perm gen --force     # overwrite a drifted output
just perm test            # run the merge-rule tests
```

Flags after `--` pass through, for example `just perm test -- --only merge`.

The extension runs the same code path at startup and on `/reload`. It writes when the output is
clean, reports a diff when the output has drifted, and says nothing when there is no change.
Because the extension factory runs before any `session_start`, pi-permission-modes reads the file
in the same session.

## Source format

Three blocks: `output` (the file header: `$schema`, `defaultMode`, `cycleOrder`), `fragments`,
`modes`. `//` and `/* */` comments and trailing commas are allowed; comments are not carried into
the output.

```jsonc
{
  "output": { "defaultMode": "default", "cycleOrder": ["default", "plan"] },
  "fragments": { "common": { "permission": { "read": "allow" } } },
  "modes": { "default": { "extends": ["common"], "label": "Default" } }
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

`.last-generated.json` (in `~/.pi/agent/permission-mode/`) holds the last result the generator wrote. If `permission-mode.json`
differs from it, something else changed the file — a hand edit, or an "Allow forever" approval.
The generator prints each differing key path as `last generated` versus `file` and does not
overwrite. Move the change into the source, or run `just perm gen --force`.

## Files

- `configs/permission-mode.example.src.jsonc` — the committed example source. Copy it to
  `~/.pi/agent/permission-mode/permission-mode.src.jsonc`; that live file is the only thing you edit.
- `../../lib/jsonc.ts` — comment and trailing-comma handling (shared with the other extensions).
- `merge.ts` — merge rules, no fs and no pi imports.
- `generate.ts` — `run()` plus the CLI entry.
- `index.ts` — the pi extension: run at startup and `/reload`, report at `session_start`.
- `merge.test.ts` — `node:test` tests. Needs Node >= 22.12.
