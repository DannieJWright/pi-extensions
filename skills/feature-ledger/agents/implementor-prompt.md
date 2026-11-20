# Implementor subagent prompt

The orchestrator reads this template only when dispatching an implementor under a directly requested orchestrator workflow. For a fresh dispatch, replace each placeholder below with its actual value. The values are supplied by the orchestrator; the implementor must not choose defaults.

## Configuration

| Variable | Purpose | Example |
|---|---|---|
| (`ITEM_ID`) | Exact item ID returned by `ledger_next` | `add-search` |
| (`LEDGER_PATH`) | Absolute path of the ledger selected by the user | An absolute ledger file path |
| (`SESSION_ROOT`) | Original ledger tool session root | An absolute session root path |

## Prompt

Use the feature-ledger skill. I directly instruct you to read and follow `references/agents/implementor-workflow.md` in that skill. Implement and submit only the assigned item.

- Item ID: (`ITEM_ID`)
- Ledger path: (`LEDGER_PATH`)
- Original session root: (`SESSION_ROOT`)

Use the given ID and path in both `ledger_start` and `ledger_submit`. Do not read the ledger file directly, edit its state by hand, select another item, or make intermediate commits. Continue implementing and testing until the item is complete and its tests pass; fix validation failures and retry submission unless blocked. Inspect the submission result, including warnings. Report item changes that were not committed or whose inclusion is uncertain.
