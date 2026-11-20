---
name: feature-ledger
description: >-
  Track feature work as ordered items in a ledger file. Use at the start of a
  session to read where a feature stands, to hand one item to another agent or
  subagent, or to turn a plan into a ledger for agents to implement. The ledger is
  the only shared state between sessions, so the work is resumable and checkable.
---

# Feature Ledger

Track feature work as ordered items. The ledger is the only shared state between sessions and between agents, so the work is resumable and checkable.

For the standard flows, read the one that matches the task:

- Writing a ledger from a plan: `references/writing-flow.md`.
- Working an item from a ledger: `references/implementation-flow.md`.

The agent workflows are opt-in. Do not read or run them just because you loaded this skill, were asked to use the ledger, or are working an item:

- `references/agents/orchestrator-workflow.md` — read only when the user directly requests the orchestrator workflow.
- `references/agents/implementor-workflow.md` — read only when the orchestrator directly instructs a subagent to use the implementor workflow.

This file holds the shared conventions.

## Ledger file

The path is resolved for each call, in this order: a path argument given to the tool, then `PI_LEDGER_PATH`, then the first line of `plan/ledger.path` in the session root, then `plan/ledger.yaml`. A relative path resolves against the session root. Any extension is accepted, and no path is checked for a `.yaml` name. Free-form paths under `plan/` are allowed; there is no enforced iteration naming.

Every item lives in one file, in order. The reference example is `references/ledger.yaml` in this skill; it parses with the tools.

YAML. Multiline text uses `>` blocks. Arrays for every list. Keys are exact, in this order.

Field rules:

- `id` — unique string. It is the key for the capture spec, the artifact folder, and the commit.
- `status` — `todo`, `in-progress`, `done`. Set by the tools, never by hand.
- `goal` — the work to be completed. Includes the option reference when the item came from a plan. Name the plan file by its path under `plan/`; `ledger_check` reports a goal that names a plan file that does not exist.
- `short_goal` — one sentence: the overview of the item. Required. This is what a reader or a script sees first; `goal` carries the detail. Write it at authoring time, do not derive it from `goal`. The `ledger_check` tool reports a missing value, and the read tools error on an item without one.
- `workspace` — the directory the item is worked in, relative to the session root, or absolute. Optional. An item's value wins over the `workspace` at the ledger level; with neither, the session root is used. One workspace per item, one commit per item. Validation scripts run from the workspace root, and the commit is made inside that workspace's repository. `files.out` entries are prefixed with the workspace so they read from the session root. `ledger_check` reports a workspace that does not exist or is not inside a git repository.
- `branch` — an optional label the author writes. No tool reads a branch from git to find the file. `ledger_list` echoes it only when the file has it. When an item states a branch, `ledger_start` compares it with the branch of the item's repository and errors on a mismatch.
- `acceptance_criteria` — bullet points. The key is one word with an underscore so a tool can read it without a quoting rule.
- `constraints` — what must be kept in mind while working.
- List entries must be plain strings. A bullet that starts with `key: value` reads as a mapping, not as a string, so quote the whole line when you write it: `- "Read-only: the tool never writes the ledger."`. `ledger_check` reports such an entry as a problem line; a quoted bullet is fine.
- `validation_scripts` — commands that run the full suite, taken from the project the work happens in: its own defined recipes or scripts, or the agent tools available there (for example `just_test`). Do not write a recipe from another project. Defined once at the ledger level as the base list. An item may override it, and an item may omit it to use the base. The submit tool runs them (through the shell, from the item's workspace root) before it accepts a submission. Each command must exit 0. A script may change directory inside the workspace, for example `cd sub-repo-1 && just test all`.
- `files.in` — known relevant files, written before the work starts. This is what a fresh agent reads first. Paths are relative to the session root, or absolute. An entry may name a file an earlier step will create, so it does not have to exist yet. `ledger_check` reports such an entry as a warning, not a problem, so a warning needs no fix.
- `files.out` — files edited during the work. Written by the submit tool from the commit diff.
- `tests` — tests created or modified.
- `limitations` — problems, limits, and compromises found during the work. Required for any item that shipped a compromise.
- `summary` — the agent's notes after completing the work, including the capture result. The capture spec, the images, and the sidecar are files written during the work, so they appear in `files.out` on their own; the `summary` names the artifact paths and the pair-check conclusion.
- `commits.start` / `commits.end` — set by the tools. `commits.start` is null for a `todo` item, `commits.end` is null for an `in-progress` item.

## Statuses belong to the tools

Agents must not change statuses by hand. `todo` → `in-progress` → `done` is set by `ledger_start` and `ledger_submit`. A hand-edited status is not a record of work; it is a claim with no commit and no validation run behind it.

The writing flow may only create items as `todo`.

## Read state through the tools

An agent working an item reads state through `ledger_list`, `ledger_next`, or `ledger_start`. It does not read the ledger file with the read tool. The file carries every item, so a direct read pulls state the agent does not need.

Two exceptions:

- The writing flow authors the file, so it may read what it wrote.
- `ledger_check` reads the file internally, which is allowed.

## Known limitation: concurrent writers

The tools write one shared file. For now we assume concurrent work: a parent agent, a subagent, or a new session may hold different items in progress at the same time. There is no lock, so the last write wins and a read can be stale. The read tools can report a state that changed after the read.

This is accepted for now and is a point to come back to. When it becomes a problem, the fix is a write lock per item, or one file per item with a shared header. Record this so a later agent does not treat a lost write as a tool bug.

## What the reviewer sees

The reviewer sees the closed items through the merged branch history or the squash, not through the file.
