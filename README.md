# pi-extensions

Three Pi extensions as one package:

- `extensions/just-tools/` — exposes the justfile recipes as tools. See its README.
- `extensions/provider-prompt-rules/` — injects per-provider/model prompt rules. See its README.
- `extensions/permission-mode-generator/` — generates the permission-mode config from `permission-mode.src.jsonc`. See its README.

## Setup on a new machine

1. Clone, then attach the package to Pi:

   ```sh
   pi install ~/git/pi-extensions                          # local path
   # or, after pushing: pi install git:github.com/<you>/pi-extensions
   ```

2. Copy the example configs to the live locations:

   ```sh
   mkdir -p ~/.pi ~/.pi/agent
   cp configs/just-tools.example.jsonc ~/.pi/just-tools.jsonc
   cp configs/provider-prompt-rules.example.jsonc ~/.pi/agent/provider-prompt-rules.jsonc
   ```

3. Requirements: `just` on PATH, and Node 22.6+ (type stripping) to run the `.ts` entry points and `node --test`. Run `npm install` once for the test devDependency (`@earendil-works/pi-ai`).

4. Justfile: for sessions started outside the repo, put a thin wrapper at `~/.pi/justfile`:

   ```just
   import "<path>/pi-extensions/justfile"
   ```

   Sessions started in the repo can run `just` directly. The generator writes its output to `~/.pi/agent/permission-mode/permission-mode.json`, where the `pi-permission-modes` extension reads it; that extension must be installed separately.

Do not keep duplicate copies of these extension files under `~/.pi/agent/extensions` — Pi would load them twice.

## Tests

```sh
just test                    # perm check, just-tools tests, provider-rules check
just provider-rules test     # provider prompt rules tests
just perm test               # permission-mode merge tests
```
