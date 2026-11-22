# Migrate to the unified permissions source

The source moved from `~/.pi/agent/permission-mode/permission-mode.src.jsonc` to `~/.pi/agent/permissions.src.jsonc`. It now contains `permissionModes` and an optional `subagents`. The generator owns the entire `settings.json` → `subagents` value when that section is present; it retains all other settings keys. The new settings baseline is `~/.pi/agent/.subagents.last-generated.json`; the modes baseline remains in the permission-mode directory. The old CLI `--out` and `--state` flags are now `--modes-out` and `--modes-state`; `--settings` and `--subagents-state` select the new files. `subagents.config` is not yet supported.

## Automatic migration

1. Back up the old source, settings and outputs. Run `just perm migrate`. It exclusively creates the new source, retains comments and leaves the old source in place. It imports representable `settings.json` subagents as `settings` plus `agents` (formerly `agentOverrides`); it does not add `config` or modify outputs or baselines.
2. Run `just perm check`. Migration does not guarantee a clean check: an existing hand edit, missing baseline, or the changed generated header may require review or regeneration. An existing differing output without a baseline is treated as unadopted drift; a matching one can be adopted by `gen` without force. Move wanted changes into the source, then run `just perm gen`. Only after reviewing differences, use `just perm gen --force` to overwrite drift.
3. Keep the old source until the new configuration is verified. Once satisfied, it can be removed or archived manually.

If the new source exists, migration refuses to replace it. If the old source is found but the new one is missing, generation names `just perm migrate`. Unknown top-level keys usually mean the old format was copied without wrapping. An unsafe import (for example an agent value that the merge would delete or interpret as `extends`, `key+`, `$replace`, or an exact `$file` object) stops with manual migration guidance; the migration does not read a `$file` target. Consult the generator README for merge rules and make an intentional equivalent, or leave `subagents` absent and continue managing settings manually.

## Manual migration and undo

Copy the old file to the new path and wrap its original object as the value of `permissionModes`, retaining its comments. If you want generated subagents, copy `settings.json`'s `subagents` keys other than `agentOverrides` to `subagents.settings`, and copy `agentOverrides` to `subagents.agents`. Leave `agents` absent when `agentOverrides` was absent; keep an explicit empty object when it was empty. Review merge keywords, null values and `$file` objects for changed meaning. Run `just perm check` and handle drift as above. The config file remains untouched.

To undo, stop using the new generator, restore the old source and use the previous package version. Restore backed-up outputs and settings if needed; the new version's generated header and baselines are not a substitute for backups.

Individual output and baseline writes are atomic but not atomic together. After a crash, inspect the output, source and `.generator-pending` marker, then use `just perm gen --force` after deciding which content to keep. See the README for lock, alias, concurrent check and metadata limitations.

## Prompt references

Existing installs that use a single-key `{ "$file": "..." }` value need no change. Migration does not read or rewrite such a value, and it still returns the file content verbatim. The only new behaviour that reaches it is path syntax: `~/...` now expands from your home directory, and a relative path resolves against the source file as before. A hand-written value with sibling keys beside `$file` was treated as ordinary data before and still is, so keep the legacy form single-key.

The multi-part form (`files` plus optional `text`) is additive: use it when you want to combine an external file with your own text. Flag every entry that names a file carrying frontmatter with `stripFrontmatter: true`, because frontmatter is kept unless the flag is set. Nothing in the generated output records where a prompt came from; the configuration names the files it uses, and `NOTICE` is the single record of third-party sources. See [Prompt values](README.md#prompt-values) in the generator README.
