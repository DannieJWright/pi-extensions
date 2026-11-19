# Feature ledger

A ledger for the feature workflow. The workflow rules live in `skills/feature-ledger/SKILL.md` and its two
flow references (`references/implementation-flow.md`, `references/writing-flow.md`); this extension covers the
steps an agent cannot do reliably by hand: reading where a feature stands, the status transition, and the
validation-gated commit. Core logic is in `ledger.ts` so it is testable without a Pi session. The YAML subset
parser is shared in `../../lib/yaml.ts`.

## Use

```sh
just feature-ledger check                       # validate a ledger (defaults to the reference example)
just feature-ledger check path/to/ledger.yaml   # validate a real ledger
just feature-ledger test                        # run the parser and write-path tests
```

The CLI is the human and CI path. In a session, an agent uses the `ledger_check` tool, which runs the same
check (`checkLedger` in `ledger.ts`) over the resolved file or a path it is given.

## Ledger path

Every tool resolves the file per call, in this order:

1. the `path` argument given to the tool,
2. `PI_LEDGER_PATH`,
3. the first line of `plan/ledger.path` in the session root,
4. `plan/ledger.yaml`.

A relative path resolves against the session root. Any extension is accepted; the name is not checked. The
pointer file is read at call time, so a change to it takes effect on the next call. `resolveLedgerPath` in
`ledger.ts` holds the order and takes the pointer content as an argument, so it does no filesystem work.

The reference example is `skills/feature-ledger/references/ledger.yaml`. It carries `short_goal`, the
required one-sentence overview of an item, which the read tools return.

## Tools

Read-only:

- `ledger_list` — every item in file order: `id`, `status`, `short_goal`, `workspace`, `commits` (`start` is
  null for a `todo` item, `end` is null for an `in-progress` item). Returns JSON. `branch` is present only
  when the file has it; no tool reads a branch from git. Errors when an item has no `short_goal` value, so a
  reader never sees an empty overview.
- `ledger_next` — the first in-progress item, else the first todo. Returns JSON
  `{ "next": { "id", "status", "short_goal", "workspace" }, "status" }` where the root `status` is the ledger
  state: `todo` when nothing is started, `in-progress` when at least one item is in-progress or done, `done`
  when all items are done and `next` is null. A script or a delegate calls it and hands the item to the next
  agent, who calls `ledger_start`. Errors when an item has no `short_goal` value, same as `ledger_list`.
- `ledger_check` — validate a ledger. Returns JSON `{ "path", "ok", "problems" }` and `isError` when problems
  exist. Reports a missing `id`, a duplicate `id`, a bad status, a missing `short_goal`, a goal that names a
  plan file that does not exist, a `workspace` that does not exist or is not inside a git repository, and a
  `files.in` entry that does not resolve from the session root. The tracked-plan check is optional and runs
  only when the ledger sits inside a git repository. Plan references resolve against the session root. There
  is no location line. `check.ts` is the same check for humans and CI, without the filesystem and git work.

Writing:

- `ledger_start` — read a feature item and mark it in-progress. Returns the item brief: workspace, goal,
  acceptance criteria, constraints, `files.in`, tests. Errors when the item names a branch and the item's
  repository is on a different branch. Refuses when the item is not `todo`. Records the start commit.
- `ledger_submit` — validate and commit an item. Checks the item state first: the item must be in-progress, HEAD
  must still be the recorded start commit, and the working tree must have changes. Then it runs the item's
  validation scripts (item override, else the base list) from the item's workspace root; any failure rejects the
  submit and writes the full output to a log file. On success: `git add -A` inside the item's repository, one
  commit, `files.out` from the diff prefixed with the workspace so entries read from the session root, summary
  and limitations recorded, item marked `done`. Changes outside the item's repository are printed as a warning and
  not committed; nothing is claimed about them when the session root is not a git repository. A clean tree with
  failing scripts reports no changes, because the state checks run before the scripts.

## Workspace

An item works in one workspace and produces one commit. `workspace` is optional: an item's value wins over the
value at the ledger level, and with neither the session root is used. `resolveWorkspace` in `ledger.ts` gives
the directory; `resolveRepoRoot` gives the repository through `git rev-parse --show-toplevel` and returns
nothing outside one. The read tools do not run git, so they report the workspace as written.

## Known limitation

No write lock. Two sessions writing the same ledger are last-write-wins.
