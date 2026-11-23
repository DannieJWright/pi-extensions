# Worker prompt template

The orchestrator supplies actual values for every placeholder; none has a default.

| Variable | Purpose | Example |
|---|---|---|
| (`ITEM_ID`) | Selected feature ID | `add-search` |
| (`LEDGER_PATH`) | Pinned absolute ledger path | An absolute ledger file path |
| (`SESSION_ROOT`) | Original session root | An absolute directory path |
| (`AGENT_ID`) | Deterministic assignment identity supplied by the parent | `add-search-0-worker` |

## Prompt

Use the feature-ledger skill. I directly instruct you to read and follow `references/agents/worker-workflow.md` in that skill. Implement and submit only the assigned item.

- Item ID: (`ITEM_ID`)
- Ledger path: (`LEDGER_PATH`)
- Original session root: (`SESSION_ROOT`)
- Agent ID: (`AGENT_ID`)

Use these values for `ledger_work` start and submit; retain and use the fresh claim token returned by start. Do not select another item, read or edit ledger state directly, or make intermediate commits. Fix and retest the assigned work, including pending finding checks. Inspect the submission result, including warnings and `files.out`. Stop on an uncertain commit or missing required tool. Return exactly one JSON object with seven nonempty string fields: `item_id`, `outcome`, `known_state`, `tests`, `commit`, `warnings`, `blocker`, following the workflow's value rules and reporting any uncommitted or uncertain item changes.
