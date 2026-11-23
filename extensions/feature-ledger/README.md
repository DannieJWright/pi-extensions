# Feature ledger

A feature-work ledger with optional review loops. Agent workflows live in `skills/feature-ledger/SKILL.md` and its references. The extension implements read/claim/submit transitions and validation-gated commits; `ledger.ts` is testable without a Pi session and `../../lib/yaml.ts` provides the shared YAML subset parser.

## Human and CI commands

```sh
just feature-ledger check                       # validate the reference example
just feature-ledger check path/to/ledger.yaml   # validate a ledger
just feature-ledger test                        # run feature-ledger tests
```

The CLI check uses the same model check as `ledger_check`, without its filesystem/Git checks. In a Pi session use the tools below. The reference schema example is `skills/feature-ledger/references/ledger.yaml`.

## Path and workspace

Every tool resolves the ledger path in order: explicit `path`, `PI_LEDGER_PATH`, first line of `plan/ledger.path` in the session root, then `plan/ledger.yaml`. Relative paths are relative to the original session root; any extension is accepted. Workspace is resolved from item, then ledger, then session root. Optional item branch is checked on role starts and submissions, not used to locate the ledger. The orchestrator pins the user-selected path for all calls.

## Tools

- `ledger_get_feature`: `id`, optional `path`. Read the full item, assignment (including token), findings, commits, workspace and effective configuration.
- `ledger_orchestrate`: `action: list | next | release`, optional `path`. List preserves file order and includes assignment and effective config. Next picks the first unassigned review, then eligible in-progress, then todo only when no work is in flight; it reports assigned and capped items. Release requires `id`, `agent_id`, `claim_token`; it clears only the matching claim, not status.
- `ledger_check`: optional `path`. Read-only result `{ path, ok, problems, warnings }`; only problems set `isError`. It checks model, duplicate IDs, workspace and Git repository, plan references and missing inputs. Missing `files.in` is a warning; plan and input paths resolve from session root.
- `ledger_work`: `action: start` requires `id`, `agent_id`; `action: submit` also requires the matching `claim_token`, `commit_message`, `summary` and optionally `limitations`, `empty_commit`. Starts claim a todo or eligible in-progress feature, record expected HEAD and return the full item, config, pending findings and diff views. Submit validates status, identity, token, branch, expected HEAD and cap, runs project validation scripts and creates a work commit. An initial submission requires real implementation changes. After failed review, `empty_commit: true` allows a verification-only fix with explanation; it preserves unrelated staged files. Success records cumulative files and commit history and moves to `review` if enabled, otherwise `done`. It reports outside-workspace-repository changes but does not commit them.
- `ledger_review`: `action: start` requires `id`, `agent_id`; `action: submit` also requires the matching `claim_token`, with optional `close_findings` and `new_findings` (objects with `details`, `rationale`, `severity`, `required_checks`). Review start returns the same item, config, pending findings and diff views. Review submit persists findings and sets `done` when none remain open, otherwise increments failed reviews and returns to `in-progress`. Every severity blocks a pass. A tracked ledger is committed as a whole in its repository, including pre-existing ledger edits but excluding other staged files; an ignored, untracked or outside-repository ledger is written without a commit. If already identical to HEAD after writing, no commit is needed. The result states what happened.

All tools accept `path`. Role starts assign `<feature-id>-<failed-reviews>-<worker|reviewer>` and issue a fresh token. Both starts include cumulative and latest diffs, separating implementation and ledger metadata; truncated patches have a full-patch artifact path. Validation failure retains a work claim and reports a log. Feature `review` defaults off; `max_failed_reviews` resolves item, ledger, then 5, with 0 unlimited. On reaching a positive cap, open findings remain and worker start is blocked.

## Safety and dependency

Claims fence stale sequential submissions; they are not locks or access-control secrets. Ledger writes are last-writer-wins: concurrent writers and concurrent work in a shared workspace are unsupported. Release a claim only after confirming its run stopped, using the current matching identity and token. Git commits and ledger writes are not atomic together; inspect state and report uncertainty rather than retrying blindly.

Bundled pi-subagents worker/reviewer tool access and reviewer write permission are an external dependency being addressed separately. This extension and skill do not configure overrides; agents must stop and report missing required tools.
