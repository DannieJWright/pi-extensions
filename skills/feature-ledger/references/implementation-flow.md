# Implementation flow

Read before working a feature, whether directly or under a parent. The tool names here are the agent interface; stop and report if any required tool is unavailable.

## Tool contract

All tools accept optional `path` with the resolution order in `SKILL.md`. Use a pinned path when one is assigned.

- `ledger_get_feature`: `id`, optional `path`. Read the full item, assignment (including claim token), findings, commits, workspace and effective review configuration.
- `ledger_orchestrate`: `action: list` returns items in file order with assignments, config and cap; `action: next` selects the first unassigned `review`, then eligible `in-progress`, then `todo` only when no work is in flight. Its result includes assigned and capped items. `action: release` requires `id`, `agent_id`, `claim_token` and only clears a matching claim, not status.
- `ledger_check`: validate the model and filesystem-related constraints without writing; warnings are not problems.
- `ledger_work`: `action: start`, `id`, `agent_id` claims an unassigned `todo` or eligible `in-progress` item and returns a fresh token. `action: submit` also requires the matching `claim_token`, `commit_message`, and `summary`; optional `limitations` and `empty_commit` are accepted.
- `ledger_review`: `action: start`, `id`, `agent_id` claims unassigned `review`. `action: submit` also requires the matching `claim_token`; optional `close_findings` is a list of existing IDs, and `new_findings` is a list of objects with nonempty `details` and `rationale`, valid `severity`, and `required_checks` (a list of nonempty instructions). Omitted lists are empty. Unknown or duplicate closure IDs and invalid findings are rejected.

Both starts return the full item, effective config, pending findings, workspace, commits and cumulative/latest diff views. Each view separates implementation from ledger metadata, with file list, stat and patch. If a patch is truncated, read its `full_patch_path` artifact. The assignment ID is `<feature-id>-<failed-reviews>-<worker|reviewer>`; each new start gets a fresh token. Tokens fence stale claims, not concurrent writers.

## Work order

1. If assigned an ID, use it; otherwise select with `ledger_orchestrate` action `next` and do not claim a `review` item as a worker. If nothing is selectable, list and report complete, in-flight, capped or blocked state. For direct work choose a nonempty `agent_id` and call `ledger_work` start; keep its token for submission and recovery. Do not select another item once assigned.
2. Follow the returned goal, acceptance criteria, constraints, input paths and tests in the workspace; inspect pending findings and perform their required checks. For UI work capture a before frame using the before-after-capture skill.
3. Implement and test, narrow first. Do not make intermediate commits. Keep unrelated changes out of the work submission; it commits implementation changes in the workspace repository. For UI work capture and verify the after pair; otherwise record command output. Include evidence and limitations in the summary.
4. Submit via `ledger_work` with the same ID, path, agent ID and token. It checks status, claim, branch, expected HEAD and cap, then runs the effective validation scripts from the workspace and creates one work commit. An initial submission requires implementation changes, not ledger metadata alone. A review-fix iteration may request `empty_commit: true` for verification-only work and must explain it in the summary; validations still run. An empty commit preserves unrelated staged work.
5. A validation rejection retains the claim and reports a log; read it, fix the failure, and submit again. Successful work goes to `done` if review is off, otherwise `review`. Inspect warnings and compare intended changes with `files.out`; report omissions or uncertainty. If a commit or ledger write may have succeeded, stop and inspect HEAD, index and ledger state instead of retrying blindly.

Read live state via the tools, not by opening the entire ledger directly; the authoring flow is the exception. One agent works one item at a time. UI work is done only after the pair is verified; non-UI work needs recorded output as well as passing validation.

## Common issues

- **Claim already assigned:** another run owns it. Do not take it over. A parent can recover only after establishing the run stopped, then releasing the matching identity and token.
- **Review cap reached:** report open findings, failed count and effective limit; only an authorized user may change the configuration or otherwise resolve it.
- **Missing tool or uncertain Git/write result:** stop and report the exact error and known state. Claims and history may require reconciliation, not a blind retry.
