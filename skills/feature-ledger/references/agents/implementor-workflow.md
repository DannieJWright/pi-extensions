# Implementor workflow

Read and use this workflow only when the orchestrator directly instructs you to do so. Shared field rules and conventions are in `../../SKILL.md`; the standard item rules are in `../implementation-flow.md`.

## Start the assigned item

Require the exact item ID, ledger path and original session root from the orchestrator. Confirm that your ledger tool session root is the original root before calling `ledger_start`; the absolute ledger path alone does not set it. Use the same root for project-relative paths. If the root cannot be established, stop and report the problem.

Call `ledger_start` with the assigned ID and ledger path. Work only on that item. Do not call `ledger_next` to choose another item, read the ledger file directly, or edit ledger state by hand. If `ledger_start` fails, stop and report the error.

## Implement and submit

1. Use the brief from `ledger_start`: work in the item's workspace and follow its goal, acceptance criteria, constraints, input files and test expectations.
2. Follow the testing and evidence rules in `../implementation-flow.md`. For a UI item, capture the before frame before implementation.
3. Implement and test until the item is complete and its tests pass. Fix test failures and run the tests again. For a UI item, capture the after frame and verify the pair after implementation. For a non-UI item, record command output that shows the result. Do not make intermediate commits: `ledger_submit` makes the item commit.
4. Keep unrelated changes out of the item commit. `ledger_submit` stages the repository's working tree. If unrelated changes cannot safely be kept out, stop and report the problem.
5. Call `ledger_submit` with the same item ID and ledger path, a commit message, a summary and any limitations. The tool runs the validation scripts before it commits and closes the item. If validation fails, read the reported output, fix the work and submit again. If blocked, stop and report the problem. Do not blindly retry a failure that may have occurred after a commit; report it for investigation.
6. Inspect the submission result, including warnings. Report any item changes that were not committed, or whose inclusion is uncertain; the tool can mark the item `done` even when it warns about changes outside the repository. Return to the orchestrator with the item ID, test results and submission result. If blocked or a tool fails, report the item ID, known state, test results and relevant error instead. Do not work on another item.
