# Feature ledger

A per-feature-branch ledger (`plan/<branch>/ledger.yaml`) for the feature workflow. The workflow rules
live in `skills/feature-ledger/SKILL.md`; this extension covers the two steps an agent cannot do
reliably by hand: the status transition and the validation-gated commit. Core logic is in `ledger.ts`
so it is testable without a Pi session. The YAML subset parser is shared in `../../lib/yaml.ts`.

## Use

```sh
just feature-ledger check                       # validate a ledger (defaults to the reference example)
just feature-ledger check path/to/ledger.yaml   # validate a real ledger
just feature-ledger test                        # run the parser and write-path tests
```

The reference example is `skills/feature-ledger/references/ledger.yaml`.

## Tools

- `ledger_start` — read a feature item and mark it in-progress. Returns the item brief: goal,
  acceptance criteria, constraints, `files.in`, tests. Refuses when the item is not `todo`. Records the
  start commit.
- `ledger_submit` — validate and commit an item. Runs the item's validation scripts (item override,
  else the base list); any failure rejects the submit and writes the full output to a log file. On
  success: `git add -A`, one commit, `files.out` from the diff, summary and limitations recorded, item
  marked `done`. Refuses an item that is not in-progress, a dirty tree, or a moved HEAD.

## Known limitation

No write lock. Two sessions writing the same ledger are last-write-wins.
