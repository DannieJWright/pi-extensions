# pi-extensions

Three Pi extensions as one package:

- `extensions/just-tools/` — exposes the justfile recipes as tools. See its README.
- `extensions/provider-rules/` — injects per-provider/model prompt rules, and recovers when a local model's response is truncated by thinking. See its README.
- `extensions/permission-mode-generator/` — generates the permission-mode config from `~/.pi/agent/permission-mode/permission-mode.src.jsonc` (example source in `configs/`). See its README.

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
   cp configs/permission-mode.example.src.jsonc ~/.pi/agent/permission-mode/permission-mode.src.jsonc
   ```

3. Requirements: `just` on PATH, and Node 22.6+ (type stripping) to run the `.ts` entry points and `node --test`. Run `npm install` once for the test devDependency (`@earendil-works/pi-ai`).

4. Justfile: for sessions started outside the repo, put a thin wrapper at `~/.pi/justfile`:

   ```just
   import "<path>/pi-extensions/justfile"
   ```

   Sessions started in the repo can run `just` directly. The generator reads its source from `~/.pi/agent/permission-mode/permission-mode.src.jsonc` and writes its output to `~/.pi/agent/permission-mode/permission-mode.json`, where the `pi-permission-modes` extension reads it; that extension must be installed separately. The source, the output, and the generator's `.last-generated.json` baseline all live in that same directory, so nothing private is committed to this repo.

Do not keep duplicate copies of these extension files under `~/.pi/agent/extensions` — Pi would load them twice.

## Tests

```sh
just test                    # perm check, just-tools tests, provider-rules check
just provider-rules test     # provider rules tests
just perm test               # permission-mode merge tests
```
