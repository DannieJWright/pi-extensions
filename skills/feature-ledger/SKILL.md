---
name: feature-ledger
description: >-
  Track feature work as ordered items with a start and a submit step. Use at the
  start of a session to read where a feature stands, and to hand one item to
  another agent or subagent. The ledger is the only shared state between
  sessions, so the work is resumable and checkable.
---

# Feature Ledger

Track feature work as ordered items. The ledger is the only shared state between sessions and between agents, so the work is resumable and checkable.

Two parts: the ledger file, and two tools (`ledger_start`, `ledger_submit`) that read and write it.

## Ledger file

`plan/<branch>/ledger.yaml`. One file per feature branch; every item lives in it, in order.

YAML. Multiline text uses `>` blocks. Arrays for every list. Keys are exact. The reference example is `schema/ledger.yaml` in this repo; it parses with the tools below.

Field rules:

- `id` — unique string. It is the key for the capture spec, the artifact folder, and the commit.
- `status` — `todo`, `in-progress`, `done`. Set by the tools, not by hand.
- `goal` — the work to be completed. Includes the option reference when the item came from a plan.
- `acceptance_criteria` — bullet points. The key is one word with an underscore so a tool can read it without a quoting rule.
- `constraints` — what must be kept in mind while working.
- `validation_scripts` — commands that run the full suite. Defined once at the ledger level as the base list. An item may override it, and an item may omit it to use the base. The submit tool runs them (through the shell, from the repo root) before it accepts a submission. Each command must exit 0.
- `files.in` — known relevant files, written before the work starts. This is what a fresh agent reads first.
- `files.out` — files edited during the work. Written by the submit tool from the commit diff.
- `tests` — tests created or modified.
- `limitations` — problems, limits, and compromises found during the work. Required for any item that shipped a compromise.
- `summary` — the agent's notes after completing the work, including the capture result. The capture spec, the images, and the sidecar are files written during the work, so they appear in `files.out` on their own; the `summary` names the artifact paths and the pair-check conclusion.
- `commits.start` / `commits.end` — set by the tools.

## Tools

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

Both tools write the same file, so a parent agent, a subagent, and a new session see the same state.

## Work order for an item

1. `ledger_start(id)` — read the item, capture the before frame (before-after-capture skill).
2. Implement.
3. Tests: narrow run first, then the full suite once.
4. Capture the after frame and run the pair check.
5. `ledger_submit(...)` — the tool runs the validation scripts, commits, and closes the item.

One item at a time per agent. An agent that is given an item calls `ledger_start` for that item and `ledger_submit` at the end. It does not work on another item.

Definition of done for an item: the validation scripts pass **and** the after artifact was verified to show the change. "Code written" is not done.

Session start: read the ledger before any work. Write the item before starting it.

## Known limitation: concurrent writers

The tools write one shared file. For now we assume concurrent work: a parent agent, a subagent, or a new session may hold different items in progress at the same time. There is no lock, so the last write wins and a read can be stale.

This is accepted for now and is a point to come back to. When it becomes a problem, the fix is a write lock per item, or one file per item with a shared header. Record this so a later agent does not treat a lost write as a tool bug.

## Cleanup before merge

The ledger lives in `plan/<branch>/` and is removed with the plan before merge. Before the PR is opened, this must print nothing:

```sh
git ls-files plan/
```

The reviewer sees the closed items through the merged branch history or the squash, not through the file.
