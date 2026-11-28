# Reviewer workflow

Read only when a parent directly instructs you to do so. The shared tool contract is in `references/implementation-flow.md`. Review only the assigned item; do not implement fixes, edit ledger state by hand, or create a separate Git commit.

1. Require item ID, pinned ledger path, original session root and agent ID. Call `ledger_review` with `action: start`, those identity values and path. Retain the fresh claim token; stop on error.
2. Inspect the requirements and acceptance criteria, cumulative and latest implementation changes and all previous findings from the returned item. Read a `full_patch_path` artifact if a diff was truncated. Verify each claimed resolution and its `required_checks`; run appropriate independent checks and record their results. Inspect relevant source as needed. Do not treat metadata-only diffs as implementation.
3. Submit with `ledger_review`, `action: submit`, the same ID, path, agent ID, token and a non-empty `commit_message`. Write it following the commit rules in `references/implementation-flow.md`; describe what was checked. Put only independently verified resolved finding IDs in `close_findings`; leave unresolved findings open. Add each new finding in the shape defined under Finding shape. Any open finding, including a nit, fails the review and returns the item to `in-progress`; no open findings means `done`. Failed count and cap apply to starting subsequent work.
4. Review submit writes findings, outcome, count and assignment. If the ledger is tracked, it commits the entire ledger file in its own repository, including any pre-existing ledger edits, without committing other staged files. If ignored, untracked, or outside a repository, it writes without a commit. Inspect the result, metadata commit, warnings and state. If a write or commit may have succeeded before an error, stop and report rather than retrying blindly.

## Finding shape

`new_findings` is a list of finding objects. Each object has exactly these fields:

- `details`: nonempty string. The concrete problem, with location.
- `rationale`: nonempty string. Why it matters.
- `severity`: string, one of `blocker`, `major`, `minor`, `nit`.
- `required_checks`: list of nonempty strings. Each is one instruction for a check that proves the finding resolved.

`close_findings` is a list of existing finding ID strings. Omitted lists are empty.

## Example call

```json
{
  "action": "submit",
  "id": "add-search",
  "agent_id": "add-search-0-reviewer",
  "claim_token": "token-from-start",
  "commit_message": "chore(ledger): review add-search round 0 - empty query handling",
  "close_findings": ["add-search-f1"],
  "new_findings": [
    {
      "details": "src/search.ts:42 returns all rows for an empty query.",
      "rationale": "The acceptance criteria require an empty query to return no rows.",
      "severity": "major",
      "required_checks": ["Run the search tests and confirm the empty-query case returns no rows."]
    }
  ]
}
```

## Return contract

Return the object defined in the Return contract of `references/agents/worker-workflow.md`, with these reviewer-specific values. Use `submitted` for a successful review submission, `blocked` or `failed` otherwise. `known_state` is `done` for a pass or `in-progress` for a failed review; report the actual state or `unknown` on error. Include open finding IDs, failed count and effective cap/config in `warnings`; use `none` only when none apply. Include checks and results in `tests`, the ledger metadata commit or `none` if no commit was made, and `none` for `blocker` on successful submission. Use `unknown` for an uncertain commit or state, and explain it; never guess.
