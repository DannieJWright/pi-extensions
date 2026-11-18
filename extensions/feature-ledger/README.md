# Feature ledger

A per-feature-branch ledger (`plan/<branch>/ledger.yaml`) for the feature workflow. The workflow rules
live in `skills/feature-ledger/SKILL.md` and its two flow references (`references/implementation-flow.md`,
`references/writing-flow.md`); this extension covers the steps an agent cannot do reliably by hand:
reading where a feature stands, the status transition, and the validation-gated commit. Core logic is in
`ledger.ts` so it is testable without a Pi session. The YAML subset parser is shared in `../../lib/yaml.ts`.

## Use

```sh
just feature-ledger check                       # validate a ledger (defaults to the reference example)
just feature-ledger check path/to/ledger.yaml   # validate a real ledger
just feature-ledger test                        # run the parser and write-path tests
```

The CLI is the human and CI path. In a session, an agent uses the `ledger_check` tool, which runs the same
check (`checkLedger` in `ledger.ts`) over the current branch ledger or a path it is given.

The reference example is `skills/feature-ledger/references/ledger.yaml`. It carries `short_goal`, the
required one-sentence overview of an item, which the read tools return.

## Tools

Read-only:

- `ledger_list` — every item in file order: `id`, `status`, `short_goal`, `commits` (`start` is null for
  a `todo` item, `end` is null for an `in-progress` item). Returns JSON with the branch. Errors when an
  item has no `short_goal` value, so a reader never sees an empty overview.
- `ledger_next` — the first in-progress item, else the first todo. Returns JSON
  `{ "next": { "id", "status", "short_goal" }, "status" }` where the root `status` is the ledger state:
  `todo` when nothing is started, `in-progress` when at least one item is in-progress or done, `done`
  when all items are done and `next` is null. A script or a delegate calls it and hands the item to the
  next agent, who calls `ledger_start`. Errors when an item has no `short_goal` value, same as
  `ledger_list`.
- `ledger_check` — validate a ledger. Default target `plan/<branch>/ledger.yaml` for the current branch;
  an optional `path` checks a draft ledger not yet under `plan/`, resolved against the session cwd. Returns
  JSON `{ "path", "ok", "problems" }` and `isError` when problems exist. Reports a missing `id`, a duplicate
  `id`, a bad status, a missing `short_goal`, and a path that is not `plan/<branch>/ledger.yaml` for the
  current branch. When git is unavailable and a path was given, the file is still checked and the location
  line is skipped. `check.ts` is the same check for humans and CI.

Writing:

- `ledger_start` — read a feature item and mark it in-progress. Returns the item brief: goal,
  acceptance criteria, constraints, `files.in`, tests. Refuses when the item is not `todo`. Records the
  start commit.
- `ledger_submit` — validate and commit an item. Runs the item's validation scripts (item override,
  else the base list); any failure rejects the submit and writes the full output to a log file. On
  success: `git add -A`, one commit, `files.out` from the diff, summary and limitations recorded, item
  marked `done`. Refuses an item that is not in-progress, a clean tree, or a moved HEAD.

## Known limitation

No write lock. Two sessions writing the same ledger are last-write-wins.
