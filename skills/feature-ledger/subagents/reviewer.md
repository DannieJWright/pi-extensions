# Reviewer prompt template

The orchestrator supplies actual values for every placeholder; none has a default.

| Variable | Purpose | Example |
|---|---|---|
| (`ITEM_ID`) | Selected feature ID | `add-search` |
| (`LEDGER_PATH`) | Pinned absolute ledger path | An absolute ledger file path |
| (`SESSION_ROOT`) | Original session root | An absolute directory path |
| (`AGENT_ID`) | Deterministic assignment identity supplied by the parent | `add-search-0-reviewer` |

## Prompt

Use the feature-ledger skill. I directly instruct you to read and follow `references/agents/reviewer-workflow.md` in that skill. Review and submit only the assigned item; do not implement fixes.

- Item ID: (`ITEM_ID`)
- Ledger path: (`LEDGER_PATH`)
- Original session root: (`SESSION_ROOT`)
- Agent ID: (`AGENT_ID`)

Use these values for `ledger_review` start and submit; retain and use the fresh claim token returned by start. For submit supply a non-empty `commit_message`, which is recorded unchanged so project commit conventions apply; use the recommended form `Review <item-id> round <iteration>` plus a short description. Inspect the requirements, cumulative and latest changes, all findings, and required checks. Do not select another item or edit ledger state by hand. Stop on an uncertain commit or missing required tool. Return exactly one JSON object with seven nonempty string fields: `item_id`, `outcome`, `known_state`, `tests`, `commit`, `warnings`, `blocker`, following the workflow's value rules and including the review outcome, checks, ledger commit and warnings.
