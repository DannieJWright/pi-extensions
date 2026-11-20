# Orchestrator workflow

Read and use this workflow only when the user directly requests orchestration of ledger work. Shared field rules and conventions are in the main skill file.

## Configuration

These values are for the orchestrator. They have no defaults: obtain them from the user or the ledger tools as specified below. Pass their actual values to the implementor prompt; do not pass the placeholders.

| Variable | Purpose | Example |
|---|---|---|
| (`LEDGER_PATH`) | Absolute path to the ledger selected by the user | An absolute ledger file path |
| (`SESSION_ROOT`) | Original session root for resolving workspace and input paths | An absolute session root path |
| (`ITEM_ID`) | Exact ID returned by `ledger_next` | `add-search` |

## Setup

Ask the user for the ledger path if they did not provide it. Do not select a default ledger on their behalf. Resolve the supplied path to an absolute path against the original session root as (`LEDGER_PATH`), and use it for every ledger call. Keep the original session root as (`SESSION_ROOT`): workspace and input paths can be relative to it.

Use the ledger tools to read state. Do not read or edit the ledger file directly. Call `ledger_check` with the pinned path before delegation; stop and report any problems. If a required ledger or delegation tool is unavailable, stop and tell the user what is missing.

## Work through the ledger

1. Call `ledger_next` with the pinned path. If `next` is null, stop and tell the user there are no remaining items. An empty ledger can report root status `todo`; do not claim that its status is `done`. Otherwise, set (`ITEM_ID`) to the exact selected ID.
2. If the selected item is `todo`, read `agents/implementor-prompt.md`, fill its placeholders with the actual configuration values, and dispatch that prompt to one implementor. Wait for the implementor to finish.
3. Check the implementor's JSON result. It must contain exactly these nonempty string fields: `item_id`, `outcome`, `known_state`, `tests`, `commit`, `warnings` and `blocker`. Reject malformed JSON, duplicate, missing, extra, empty or invalid fields. Stop and report the problem if the ID differs, the outcome is not `submitted`, the known state is not `done`, the commit or test results are `none` or `unknown`, the blocker is not `none`, or warnings are `unknown`. For a successful result, call `ledger_list` with the pinned path. Find the assigned ID and verify that its status is `done`. If the item is missing, is not `done`, or a tool call fails, stop and report the problem. If verification succeeds and no submission warning blocks progress under step 5, call `ledger_next` again and repeat.
4. If `ledger_next` selects an `in-progress` item, do not spawn a fresh implementor for it: `ledger_start` refuses an already started item. Resume the original implementor only if its identity is known and the harness supports resuming it. Give the resumed agent the assigned ID, path and root, and directly instruct it to use `references/agents/implementor-workflow.md`; do not send the fresh-start instruction. The resumed agent continues its existing work without calling `ledger_start` again. Wait for it and verify its submission as in step 3. Otherwise, stop and report the item to the user.
5. If an implementor is blocked, fails, or terminates without a verified submission, stop and report the item, its known state and the problem. Also stop if the submission result warns that item changes were not committed, or if their inclusion is uncertain, even if the item is `done`. Do not skip the item or silently restart it.

Run only one implementor at a time. This does not prevent concurrent external writers: ledger tools do not lock the shared file, so external writes can still overwrite each other.
