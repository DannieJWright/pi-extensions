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
- One workspace per item, one repository per item. Split the plan by workspace before you write items: an item that works in a second repository is its own item, because the commit is made inside one repository only.
- `workspace` is optional. Write it when the item works in a directory other than the session root, as a path relative to the session root. An item's value wins over the value at the ledger level.
- `branch` is an optional label you write. Do not use it to say where the file lives; no tool reads a branch from git. When you do write it, `ledger_start` compares it with the branch of the item's repository.
- `validation_scripts` is written once at the ledger level as the base list, with commands the project being worked on defines. An item writes its own list only when it needs a different set. Scripts run from the item's workspace root, so a script may change directory inside it, for example `cd sub-repo-1 && just test all`.
- `files.in` is seeded before any work starts. This is what a fresh agent reads first. Paths are relative to the session root, or absolute. An entry may name a file an earlier step will create, so it does not have to exist yet.
- `tests` names the tests the item is expected to create or change. Paths are relative to the session root, or absolute.

## What the writing flow does not write

- Statuses. Every item starts as `todo`. The writing flow may not set `in-progress` or `done` — the tools own statuses.
- `files.out`, `summary`, `limitations`, `commits`. These are filled during the work by `ledger_submit`. Write empty lists and an empty summary.

## Before handing the ledger to an agent

Run the `ledger_check` tool. It reads the file at the resolved path — a `path` argument, then `PI_LEDGER_PATH`, then the first line of `plan/ledger.path` in the session root, then `plan/ledger.yaml`. A draft ledger is named with `path`. This is the only path you have: the check lives in the extension, and an agent working a ledger has no access to the extension's own scripts or recipes.

The check returns `{ path, ok, problems, warnings }`. It reports a missing `id`, a duplicate `id`, a bad status, a missing `short_goal`, a goal that names a plan file that does not exist, a `workspace` that does not exist or is not inside a git repository, and tracked files under `plan/`, which is optional and runs only when the ledger sits inside a git repository. Fix those before the first `ledger_start`.

A `files.in` entry that does not exist yet is a warning, not a problem. Naming a file an earlier step will create is normal, so a warning needs no fix and the check still passes.

`validation_scripts` names what the project being worked on defines: its own recipes or scripts, or the agent tools available to an agent there (for example `just_test`). Do not copy a recipe from another project — the agent working the item only has the tools of its own project.
