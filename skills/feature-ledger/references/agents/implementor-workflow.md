# Implementor workflow

Read and use this workflow only when the orchestrator directly instructs you to do so. Shared field rules and conventions are in the main skill file; the standard item rules are in `references/implementation-flow.md`.

## Start the assigned item

Require the exact item ID, ledger path and original session root from the orchestrator. Use the original session root for project-relative paths.

For a fresh assignment, call `ledger_start` with the assigned ID and ledger path. If the orchestrator resumes you on an item you already started, continue that item without calling `ledger_start` again. Work only on that item. Do not call `ledger_next` to choose another item, read the ledger file directly, or edit ledger state by hand. If `ledger_start` fails, stop and report the error.

## Implement and submit

1. Use the brief from `ledger_start`: work in the item's workspace and follow its goal, acceptance criteria, constraints, input files and test expectations.
2. Follow the testing and evidence rules in `references/implementation-flow.md`. For a UI item, capture the before frame before implementation.
3. Implement and test until the item is complete and its tests pass. Fix test failures and run the tests again. For a UI item, capture the after frame and verify the pair after implementation. For a non-UI item, record command output that shows the result. Do not make intermediate commits: `ledger_submit` makes the item commit.
4. Keep unrelated changes out of the item commit. `ledger_submit` stages the repository's working tree. If unrelated changes cannot safely be kept out, stop and report the problem.
5. Call `ledger_submit` with the same item ID and ledger path, a commit message, a summary and any limitations. The tool runs the validation scripts before it commits and closes the item. If validation fails, read the reported output, fix the work and submit again. If blocked, stop and report the problem. Do not blindly retry a failure that may have occurred after a commit; report it for investigation.
6. Inspect the submission result, including warnings. Compare the item changes intended for the commit with the returned `files.out`; report any that were not committed, or whose inclusion is uncertain. An absent warning alone does not prove that all item changes were committed. If blocked or a tool fails, report the known state and error in the format below. Do not work on another item.

## Return format

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

Use `submitted` only after `ledger_submit` succeeds: set `known_state` to `done`, supply the commit and test results, and set `blocker` to `none`. Otherwise use `blocked` or `failed`, and include the reason.
