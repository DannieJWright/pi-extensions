# Orchestrator workflow

Read and use this workflow only when the user directly requests it. Shared field rules and conventions are in `../../SKILL.md`.

## Setup

Ask the user for the ledger path if they did not provide it. Do not select a default ledger on their behalf. Resolve the supplied path to an absolute path against the original session root and use that path for every ledger call. Keep the original session root: workspace and input paths can be relative to it.

Use the ledger tools to read state. Do not read or edit the ledger file directly. Call `ledger_check` with the pinned path before delegation; stop and report any problems. If a required ledger or delegation tool is unavailable, stop and tell the user what is missing.

## Work through the ledger

1. Call `ledger_next` with the pinned path. If `next` is null, stop and tell the user there are no remaining items. An empty ledger can report root status `todo`; do not claim that its status is `done`.
2. If the selected item is `todo`, spawn one implementor and wait for it to finish. Give it:
   - The exact item ID returned by `ledger_next`.
   - The pinned absolute ledger path and the original session root. Set or confirm that the subagent's ledger tool session root is the original root before it calls `ledger_start`. An absolute ledger path alone does not set the root. If the delegation mechanism cannot establish this, stop and report the problem.
   - A direct instruction to use the feature-ledger skill and read `references/agents/implementor-workflow.md` in that skill. It must implement and submit only the assigned item.
3. After the implementor returns successfully, call `ledger_list` with the pinned path. Find the assigned ID and verify that its status is `done`. If the item is missing, is not `done`, or a tool call fails, stop and report the problem. If verification succeeds and no submission warning blocks progress under step 5, call `ledger_next` again and repeat.
4. If `ledger_next` selects an `in-progress` item, do not spawn a fresh implementor for it: `ledger_start` refuses an already started item. Resume the original implementor only if its identity is known and the harness supports resuming it. The resumed agent continues its existing work without calling `ledger_start` again. Wait for it and verify its submission as in step 3. Otherwise, stop and report the item to the user.
5. If an implementor is blocked, fails, or terminates without a verified submission, stop and report the item, its known state and the problem. Also stop if the submission result warns that item changes were not committed, or if their inclusion is uncertain, even if the item is `done`. Do not skip the item or silently restart it.

Run only one implementor at a time. This does not prevent concurrent external writers: ledger tools do not lock the shared file, so external writes can still overwrite each other.
