# Implementation flow

Read this before working an item. Field rules and the shared conventions are in `../SKILL.md`.

## Tools

Four tools. Two read, two write.

`ledger_list()`

- Returns JSON: `branch`, and for each item in file order `id`, `status`, `short_goal`, `commits` (`start` null for a `todo` item, `end` null for an `in-progress` item).
- Read-only. Use it to see where a feature stands. Errors when an item has no `short_goal` value, so a reader never gets an empty overview.

`ledger_next()`

- Returns JSON `{ "next": { "id", "status", "short_goal" }, "status" }`. `next` is the first `in-progress` item, else the first `todo`.
- The root `status` is the ledger state: `todo` when nothing is started, `in-progress` when at least one item is in-progress or done, `done` when all items are done and `next` is null.
- Read-only. A script or a delegate calls it and hands the item to the next agent, who calls `ledger_start`. Errors when the selected item has no `short_goal` value.

`ledger_start(id)`

- Reads the item and returns the starting information: goal, acceptance criteria, constraints, `files.in`, and the minimum test expectations.
- Sets `status: in-progress`.
- Records `commits.start` as the current HEAD.
- Refuses to start an item that is already `in-progress` (one writer per item).

The agent implements and tests the work. **No commits during the work.** The commit is made by the submit tool, after the validation scripts pass.

`ledger_submit(id, commit_message, summary, limitations)`

1. Runs every command in `validation_scripts` from the repo root.
2. If any command fails, the submission is rejected. The tool writes the full output to a file under `/tmp/`, returns the last 20 lines of the failing command, and gives the path to that log. The item stays `in-progress` and nothing is written to the ledger. The agent reads the log, fixes the work, and submits again.
3. If all pass, the tool commits the working tree with the given message (artifacts included).
4. Computes `files.out` from the diff between `commits.start` and the new commit.
5. Writes `summary`, appends `limitations`, records `commits.end`, sets `status: done`.

Refuses when the item is not `in-progress`, when the tree has no changes, or when HEAD moved during the work (the item must be one commit).

All tools write and read the same file, so a parent agent, a subagent, and a new session see the same state.

## Reading state

Read state through `ledger_list`, `ledger_next`, or `ledger_start`, never with the read tool on `plan/<branch>/ledger.yaml`. The file carries every item, so a direct read pulls state the agent does not need.

Two exceptions:

- The writing flow authors the file, so it may read what it wrote.
- `ledger_check` reads the file internally, which is allowed.

## Work order for an item

1. `ledger_next()` — confirm the item to work, then `ledger_start(id)` for that item. The order is part of the plan: a parent may hold another item in progress, so the first item in the file is not necessarily the item to work. `ledger_start` still refuses an item already in-progress; this rule is about picking the right item, not about locking. For a UI item, capture the before frame (before-after-capture skill).
2. Implement.
3. Tests: narrow run first, then the full suite once.
4. For a UI item, capture the after frame and run the pair check. A non-UI item has no pair: record the command output that shows the result.
5. `ledger_submit(...)` — the tool runs the validation scripts, commits, and closes the item.

One item at a time per agent. An agent that is given an item calls `ledger_start` for that item and `ledger_submit` at the end. It does not work on another item.

The capture pair applies only to UI items. Definition of done for a UI item: the validation scripts pass **and** the after artifact was verified to show the change. Definition of done for a non-UI item: the validation scripts pass **and** the recorded command output shows the result. "Code written" is not done.

## Skills this flow uses

- `before-after-capture` — the pair, the conditions, and the pair check, for UI items only. The result goes in the item's `summary` and points to the sidecar.

The feature id is one key: ledger item → capture spec → artifact folder → commit message.
