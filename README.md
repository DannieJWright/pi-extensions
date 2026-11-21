# pi-extensions

Three Pi extensions as one package:

- `extensions/just-tools/` — exposes the justfile recipes as tools. See its README.
- `extensions/provider-rules/` — injects per-provider/model prompt rules, and recovers when a local model's response is truncated by thinking. See its README.
- `extensions/permission-mode-generator/` — generates permission modes and optional subagent settings from `~/.pi/agent/permissions.src.jsonc` (example source in `configs/`). See its README and migration guide.

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

3. Requirements: `just` on PATH, and Node 22.6+ (type stripping) to run the `.ts` entry points and `node --test`. Run `npm install` once for the test devDependency (`@earendil-works/pi-ai`).

4. Justfile: for sessions started outside the repo, put a thin wrapper at `~/.pi/justfile`:

   ```just
   import "<path>/pi-extensions/justfile"
   ```

   Sessions started in the repo can run `just` directly. The generator reads `~/.pi/agent/permissions.src.jsonc` and writes `~/.pi/agent/permission-mode/permission-mode.json`, where the separately installed `pi-permission-modes` reads it. It optionally owns the `subagents` key in `~/.pi/agent/settings.json`. Existing installations should follow [the migration guide](extensions/permission-mode-generator/MIGRATION.md) instead of copying the example. Live files and baselines are not committed.

Do not keep duplicate copies of these extension files under `~/.pi/agent/extensions` — Pi would load them twice.

## Tests

```sh
just test                    # permission sample and generator tests, just-tools, provider-rules
just provider-rules test     # provider rules tests
just perm test               # permission generator, merge, migration and lock tests
```
