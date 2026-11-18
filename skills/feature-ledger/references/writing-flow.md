# Writing flow

Read this when turning a plan into a ledger. Field rules and the shared conventions are in `../SKILL.md`. `references/ledger.yaml` in this skill is the shape to copy.

## What to write

- One item per implementable unit. An item is what one agent can take from `todo` to `done` in one pass. If a plan section needs two passes, it is two items.
- Item order is the order to work them. The tools read items in file order, so order is part of the plan.
- `id` is a slug (`copy-block-actions`), and it is the key for the capture spec, the artifact folder, and the commit message. `goal` names the plan option the item came from.
- `short_goal` is required and is the overview sentence — one sentence, no detail. `goal` carries the detail. Write both at authoring time; do not derive one from the other.
- `acceptance_criteria` must be checkable by reading the result or running a test. A criterion that cannot be checked is not a criterion.
- `constraints` records what must be kept, including "no new dependencies" when it applies.
- Write a list entry as a plain string. A bullet that starts with `key: value` reads as a mapping, so quote the whole line: `- "Read-only: the tool never writes the ledger."`.
- `validation_scripts` is written once at the ledger level as the base list. An item writes its own list only when it needs a different set.
- `files.in` is seeded before any work starts. This is what a fresh agent reads first.
- `tests` names the tests the item is expected to create or change.

## What the writing flow does not write

- Statuses. Every item starts as `todo`. The writing flow may not set `in-progress` or `done` — the tools own statuses.
- `files.out`, `summary`, `limitations`, `commits`. These are filled during the work by `ledger_submit`. Write empty lists and an empty summary.

## Before handing the ledger to an agent

Run the `ledger_check` tool. It checks the ledger for the current branch, or a draft ledger you name with
`path` before it is under `plan/`. This is the only path you have: the check lives in the extension, and an
agent working a ledger has no access to the extension's own scripts or recipes.

The check reports a missing `id`, a duplicate `id`, a bad status, a missing `short_goal`, and a path that is
not `plan/<branch>/ledger.yaml` for the current branch. Fix those before the first `ledger_start`.

`validation_scripts` names what the project being worked on defines: its own recipes or scripts, or the agent tools available to an agent there (for example `just_test`). Do not copy a recipe from another project — the agent working the item only has the tools of its own project.
