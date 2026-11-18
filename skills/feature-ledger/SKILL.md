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

Two flows. Read the one that matches the task:

- Writing a ledger from a plan: `references/writing-flow.md`.
- Working an item from a ledger: `references/implementation-flow.md`.

This file holds only what both flows share.

## Ledger file

`plan/<branch>/ledger.yaml`. One file per feature branch; every item lives in it, in order. The reference example is `references/ledger.yaml` in this skill; it parses with the tools.

YAML. Multiline text uses `>` blocks. Arrays for every list. Keys are exact, in this order.

Field rules:

- `id` — unique string. It is the key for the capture spec, the artifact folder, and the commit.
- `status` — `todo`, `in-progress`, `done`. Set by the tools, never by hand.
- `goal` — the work to be completed. Includes the option reference when the item came from a plan.
- `short_goal` — one sentence: the overview of the item. Required. This is what a reader or a script sees first; `goal` carries the detail. Write it at authoring time, do not derive it from `goal`.
- `acceptance_criteria` — bullet points. The key is one word with an underscore so a tool can read it without a quoting rule.
- `constraints` — what must be kept in mind while working.
- `validation_scripts` — commands that run the full suite. Defined once at the ledger level as the base list. An item may override it, and an item may omit it to use the base. The submit tool runs them (through the shell, from the repo root) before it accepts a submission. Each command must exit 0.
- `files.in` — known relevant files, written before the work starts. This is what a fresh agent reads first.
- `files.out` — files edited during the work. Written by the submit tool from the commit diff.
- `tests` — tests created or modified.
- `limitations` — problems, limits, and compromises found during the work. Required for any item that shipped a compromise.
- `summary` — the agent's notes after completing the work, including the capture result. The capture spec, the images, and the sidecar are files written during the work, so they appear in `files.out` on their own; the `summary` names the artifact paths and the pair-check conclusion.
- `commits.start` / `commits.end` — set by the tools. `commits.start` is null for a `todo` item, `commits.end` is null for an `in-progress` item.

## Statuses belong to the tools

Agents must not change statuses by hand. `todo` → `in-progress` → `done` is set by `ledger_start` and `ledger_submit`. A hand-edited status is not a record of work; it is a claim with no commit and no validation run behind it.

The writing flow may only create items as `todo`.

## Known limitation: concurrent writers

The tools write one shared file. For now we assume concurrent work: a parent agent, a subagent, or a new session may hold different items in progress at the same time. There is no lock, so the last write wins and a read can be stale. The read tools can report a state that changed after the read.

This is accepted for now and is a point to come back to. When it becomes a problem, the fix is a write lock per item, or one file per item with a shared header. Record this so a later agent does not treat a lost write as a tool bug.

## Cleanup before merge

The ledger lives in `plan/<branch>/` and is removed with the plan before merge. Before the PR is opened, this must print nothing:

```sh
git ls-files plan/
```

The reviewer sees the closed items through the merged branch history or the squash, not through the file.
