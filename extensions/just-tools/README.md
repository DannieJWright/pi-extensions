# Just recipe tools

This global Pi extension registers one tool for each public recipe in a justfile in the directory where the session starts. It does not search parent directories. The `just` executable must be on `PATH`. Aliases do not get separate tools. Public submodule recipes use qualified names such as `deploy::release`. Private recipes and recipes in private modules are not exposed.

## Security

**Recipe tools run outside the Pi bash sandbox.** A recipe can run arbitrary commands with the Pi process user's permissions. Only enable this extension in projects you trust. Existing Pi custom-tool permission rules still apply to each tool call; those rules are not a sandbox.

Tool names are readable, such as `just_test` and `just_just_tools` for `just-tools`; submodule names include their qualified path, such as `just_deploy_mrelease`. Hyphens in recipe names become underscores. If two recipes map to the same tool name, or a name conflicts with another tool, registration fails with a warning instead of replacing a tool. Names for recipes containing hyphens changed with this update; saved approvals for the old names do not apply to the new names. A new name can also match an existing approval for a different recipe, including a recipe in another project. Review saved approvals and tool rules after updating. The names do not include a project identifier, so a saved approval for a tool with the same name may apply in another project. A saved approval also remains valid if the recipe changes. The extension pins the justfile path, not its contents: editing the justfile or its imports during a session can change what an already-registered tool executes or shows. Loading the justfile for discovery or for `show` can itself evaluate just expressions, including backticks, with the Pi process user's permissions. `show` does not run the recipe body, but is not a security sandbox.

## Configuration

The global config is `~/.pi/just-tools.jsonc`. The checked-in user config selects all public recipes by default. A project can add `.pi/just-tools.jsonc` in the session's starting directory. Local keys override matching global keys; any key omitted locally inherits the global value. For example, a local `exclude` replaces the global `exclude` but keeps a global `include` unless local `include` is also set.

```jsonc
{
  // Omit include to select all public recipes if no global include is set. An empty array selects none.
  "include": ["test", "deploy::release"],
  // Exclude is applied after include.
  "exclude": ["test"],
}
```

Names must exactly match public recipe names. Unknown or private names, invalid JSONC, and unsupported configuration keys disable recipe tool registration and produce a warning. Thus an unknown name in either `include` or `exclude` disables all recipe tools. A missing justfile is not an error. Use `/reload` or restart the session to rediscover recipes and configuration. The metadata and argument schemas do not update automatically when files change.

Each tool has named arguments based on the recipe's parameters. Omit optional arguments to let just evaluate their defaults. For positional arguments, just cannot skip a default and then supply a later positional argument; the tool reports an error for that case. Variadic arguments use string arrays. Recipe options with a configured fixed value are boolean switches. Arguments are passed as separate process arguments, not interpolated into a shell command by the extension. Recipe bodies themselves may invoke a shell and are responsible for quoting their arguments.

## Tool options

Every recipe tool has an optional `just_options` object in addition to its recipe arguments. If a recipe already has a parameter named `just_options`, the extension adds leading underscores until the name is unique; the tool schema and description show the selected name. These options are never passed to the recipe:

- `grep`: A case-sensitive JavaScript regular expression applied to each stdout line. Only matching lines are returned. This works for recipe output and `show` output. Invalid patterns fail before the process starts. A very long line or a slow expression can make filtering incomplete; the tool reports this without stopping the recipe or changing its exit status. No matches are reported without changing the process result; if the process was stopped or cancelled, the report warns that output may be incomplete. Stderr is never filtered. Use a focused pattern to reduce output.
- `tail`: A safe integer. Return the last N lines of stdout and stderr separately, after applying `grep` to stdout. The default is `25`. Set `tail` to `0` or a negative integer to disable tailing and return the start of each stream, subject to the output limits below.
- `show`: When `true`, show the current recipe definition instead of running the recipe. Required recipe arguments may be omitted. Any supplied recipe arguments are validated but are not passed to `just`. A qualified submodule recipe is shown by its qualified name. The current justfile and imports are read at call time, so an edited or removed recipe can change the result.

For example, `{ "just_options": { "show": true, "grep": "test" } }` shows only matching lines of the current definition. To filter a normal invocation and limit its output, combine recipe arguments with `{ "just_options": { "grep": "error|warning", "tail": 100 } }`.

The tool reports stdout, stderr, exit status, cancellation, and truncation. When output is truncated, the result tells the agent to read the log file for the unfiltered output. Filtering and tail selection happen before the limit on output sent to the model: 24 KiB and 1,000 lines per stream. When `tail` is off, the start of each stream is returned. The tool saves unfiltered stdout and stderr in separate sections of one file under `/tmp/just-tools/outputs/<unique-id>.out` and returns its path and line count. The count includes the section headers and separator newlines. If a capture write fails, the line count may be unavailable. Cross-stream ordering is not preserved. A cancelled or stopped process can only provide partial output, which is marked as such.

Files are private to the Pi user and remain until removed or cleaned by the operating system. They may contain secrets. Output is streamed to disk without the former 256 KiB process buffer limit, so a verbose process can consume substantial disk space. Read access is subject to the active Pi permission policy.

## Tests

```sh
just just-tools test
# Pass Node test options after --:
just just-tools test -- --test-name-pattern=grep
```

The recipe runs the just-tools tests and the permission-mode merge tests. They use temporary justfiles, require `just` on `PATH`, and use the current installed Pi release to check schema validation and Google schema conversion. Manual verification in Pi is still needed for the installed permission policy and unsandboxed execution.
