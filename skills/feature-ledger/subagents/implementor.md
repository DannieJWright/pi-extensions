# Implementor subagent prompt

The orchestrator reads this template only when dispatching or resuming an implementor under a directly requested orchestrator workflow. For a fresh dispatch, replace each placeholder below with its actual value. The values are supplied by the orchestrator; the implementor must not choose defaults. On resume, give the existing implementor the return format but do not send the fresh-start instruction.

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

Confirm that your ledger tool session root is the original session root before calling `ledger_start`. If it cannot be established, stop and report the problem. Use the given ID and path in both `ledger_start` and `ledger_submit`. Do not read the ledger file directly, edit its state by hand, select another item, or make intermediate commits. Continue implementing and testing until the item is complete and its tests pass; fix validation failures and retry submission unless blocked. Inspect the submission result, including warnings. Report item changes that were not committed or whose inclusion is uncertain.

Return one JSON object with exactly these fields, each a nonempty string, and no other text. Escape line breaks and other characters as JSON requires. Use `none` where a field does not apply and `unknown` where its value cannot be determined. Include enough detail in `tests`, `warnings` and `blocker` for the orchestrator to act.

```json
{
  "item_id": "assigned ID",
  "outcome": "submitted | blocked | failed",
  "known_state": "todo | in-progress | done | unknown",
  "tests": "commands and results, or none",
  "commit": "submission commit, or none",
  "warnings": "submission warnings and uncommitted or uncertain item changes, or none",
  "blocker": "error or reason, or none"
}
```

Use `submitted` only after `ledger_submit` succeeds: set `known_state` to `done`, supply the commit and test results, and set `blocker` to `none`. Otherwise use `blocked` or `failed`, and include the reason. Do not work on another item.
