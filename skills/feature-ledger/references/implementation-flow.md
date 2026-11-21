# Implementation flow

Read before working a feature, whether directly or under a parent. The tool names here are the agent interface; stop and report if any required tool is unavailable.

## Tool contract

All tools accept optional `path` with the resolution order in `SKILL.md`. Use a pinned path when one is assigned.

- `ledger_get_feature`: `id`, optional `path`. Read the full item, assignment (including claim token), findings, commits, workspace and effective review configuration.
- `ledger_orchestrate`: `action: list` returns items in file order with assignments, config and cap; `action: next` selects the first unassigned `review`, then eligible `in-progress`, then `todo` only when no work is in flight. Its result includes assigned and capped items, and the selected `next` item carries a copy of its `acceptance_criteria` (list items do not). The orchestrator routes a `todo` or eligible `in-progress` item to `ui-worker` when any criterion contains the exact text `UI evidence required`; no other text decides the route. `action: release` requires exact match on `id`, `agent_id` and `claim_token` and clears only that claim, never status.
- `ledger_check`: validate the model and filesystem-related constraints without writing; warnings are not problems.
- `ledger_work`: `action: start`, `id`, `agent_id` claims an unassigned `todo` or eligible `in-progress` item, where eligibility means under the failed-review limit, and returns a fresh token. `action: submit` also requires the matching `claim_token`, `commit_message`, and `summary`; optional `limitations` and `empty_commit` are accepted.
- `ledger_review`: `action: start`, `id`, `agent_id` claims unassigned `review`. `action: submit` also requires the matching `claim_token` and a non-empty `commit_message`, recorded unchanged; optional `close_findings` is a list of existing IDs, and `new_findings` is a list of objects with nonempty `details` and `rationale`, valid `severity`, and `required_checks` (a list of nonempty instructions). Omitted lists are empty. Unknown or duplicate closure IDs and invalid findings are rejected.

Both starts return the full item, effective config, pending findings, workspace, commits and cumulative/latest diff views. Each view separates implementation from ledger metadata, with file list, stat and patch. The four previews share one 4 KiB allowance for the response, not per view; a view larger than what remains writes its full patch to an artifact, and once the allowance is used up later results give files and stat plus a note naming the artifacts written for that response. Read a `full_patch_path` artifact for any truncated view. The assignment ID is `<feature-id>-<failed-reviews>-<worker|reviewer>`; each new start gets a fresh token. Tokens fence stale claims, not concurrent writers.

One shared gate serves every action: resolve the path, read once, run the model check (`checkParsed`). Every tool calls it before doing any work, reads included, so problem lines match for the same file across tools and the CLI. Invariant checking lives in the model module only, reached through that gate; no tool or write step checks again at write time, and effective configuration is resolved without re-validating what the gate already accepted. A refusal happens before anything is matched or written, so a live claim survives a refused file.

## Work order

1. If assigned an ID, use it; otherwise select with `ledger_orchestrate` action `next` and do not claim a `review` item as a worker. If nothing is selectable, list and report complete, in-flight, capped or blocked state. For direct work choose a nonempty `agent_id` and call `ledger_work` start; keep its token for submission and recovery. Do not select another item once assigned.
2. Follow the returned goal, acceptance criteria, constraints, input paths and tests in the workspace; inspect pending findings and perform their required checks. For UI work capture a before frame using the before-after-capture skill.
3. Implement and test, narrow first. Do not make intermediate commits. Keep unrelated changes out of the work submission; it commits implementation changes in the workspace repository. For UI work capture and verify the after pair; otherwise record command output. Include evidence and limitations in the summary.
4. Submit via `ledger_work` with the same ID, path, agent ID and token. It checks status, claim, branch and expected HEAD, then runs the effective validation scripts from the workspace and creates one work commit. The failed-review limit governs start only, so a claim you already hold completes at the cap. An initial submission requires implementation changes, not ledger metadata alone. A review-fix iteration may request `empty_commit: true` for verification-only work and must explain it in the summary; validations still run. An empty commit preserves unrelated staged work.
5. A validation rejection retains the claim and reports a log; read it, fix the failure, and submit again. Successful work goes to `done` if review is off, otherwise `review`. Inspect warnings and compare intended changes with `files.out`; report omissions or uncertainty. If a commit or ledger write may have succeeded, stop and inspect HEAD, index and ledger state instead of retrying blindly.

Read live state via the tools, not by opening the entire ledger directly; the authoring flow is the exception. One agent works one item at a time. UI work is done only after the pair is verified; non-UI work needs recorded output as well as passing validation.

## Common issues

- **Claim already assigned:** another run owns it. Do not take it over. A parent can recover only after establishing the run stopped, then releasing the matching identity and token.
- **Review cap reached:** report open findings, failed count and effective limit; only an authorized user may change the configuration or otherwise resolve it. The cap blocks starting another attempt, not a submission for a claim already held.
- **Missing tool or uncertain Git/write result:** stop and report the exact error and known state. Claims and history may require reconciliation, not a blind retry.
