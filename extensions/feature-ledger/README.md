# Feature ledger

A feature-work ledger with optional review loops. Agent workflows live in `skills/feature-ledger/SKILL.md` and its references. The extension implements read/claim/submit transitions and validation-gated commits; `ledger.ts` is testable without a Pi session and `../../lib/yaml.ts` provides the shared YAML subset parser.

## Human and CI commands

```sh
just feature-ledger check                       # validate the reference example
just feature-ledger check path/to/ledger.yaml   # validate a ledger
just feature-ledger test                        # run feature-ledger tests
```

The CLI runs the same validation gate as the tools, without its filesystem/Git checks. In a Pi session use the tools below. The reference schema example is `skills/feature-ledger/references/ledger.yaml`.

## Validation gate

One entry point serves every action: resolve the path, read the file once, run `checkParsed`. Every tool calls it before doing any work, reads included — `get_feature`, `orchestrate list`, `orchestrate next`, `orchestrate release`, role starts and submissions all refuse a file with problems, duplicate IDs among them. The problem lines are identical for the same file across tools and the CLI; only presentation differs (`ledger_check` returns `{ path, ok, problems, warnings }`, every acting tool reports an error). Filesystem and Git checks stay in `ledger_check` because they need the filesystem, and no read path writes the ledger.

Because `release` shares the gate, recovery after an interrupted run needs the file fixed first: release refuses a file with state problems even though it changes nothing but the matching claim. This supersedes the earlier carve-out where release kept only the parse gate.

## Path and workspace

Every tool resolves the ledger path in order: explicit `path`, `PI_LEDGER_PATH`, first line of `plan/ledger.path` in the session root, then `plan/ledger.yaml`. Relative paths are relative to the original session root; any extension is accepted. Workspace is resolved from item, then ledger, then session root. Optional item branch is checked on role starts and submissions, not used to locate the ledger. The orchestrator pins the user-selected path for all calls.

## Tools

- `ledger_get_feature`: `id`, optional `path`. Read the full item, assignment (including token), findings, commits, workspace and effective configuration.
- `ledger_orchestrate`: `action: list | next | release`, optional `path`. List preserves file order and includes assignment and effective config. Next picks the first unassigned review, then eligible in-progress, then todo only when no work is in flight; it reports assigned and capped items, and the selected item carries a copy of its `acceptance_criteria` (list items do not). The orchestrator routes a `todo` or eligible `in-progress` item by the rule in `skills/feature-ledger/references/agents/orchestrator-workflow.md`. Release requires `id`, `agent_id`, `claim_token`; it clears only the matching claim, not status.
- `ledger_check`: optional `path`. Read-only result `{ path, ok, problems, warnings }`; only problems set `isError`. It checks model, duplicate IDs, workspace and Git repository, plan references and missing inputs. Missing `files.in` is a warning; plan and input paths resolve from session root.
- `ledger_work`: `action: start` requires `id`, `agent_id`; `action: submit` also requires the matching `claim_token`, `commit_message`, `summary` and optionally `limitations`, `empty_commit`. Starts claim a todo or eligible in-progress feature, record expected HEAD and return the full item, config, pending findings and diff views. Start enforces the failed-review limit; submit does not, so a claim already held can finish at the cap. Submit validates status, identity, token, branch and expected HEAD, runs project validation scripts and creates a work commit. An initial submission requires real implementation changes. After failed review, `empty_commit: true` allows a verification-only fix with explanation; it preserves unrelated staged files. Success records cumulative files and commit history and moves to `review` if enabled, otherwise `done`. It reports outside-workspace-repository changes but does not commit them.
- `ledger_review`: `action: start` requires `id`, `agent_id`; `action: submit` also requires the matching `claim_token` and a non-empty `commit_message`, recorded unchanged so project commit conventions apply (recommended form `Review <item-id> round <iteration>` plus a short description), with optional `close_findings` and `new_findings`, whose shapes are defined in `skills/feature-ledger/references/agents/reviewer-workflow.md`. A new finding's `id` is generated as `finding-<uuid>` and skips an `id` already on the item; an `id` written by hand is accepted unchanged. Finding `id`s are checked for duplicates per item within one findings list. Review start returns the same item, config, pending findings and diff views. Review submit persists findings and sets `done` when none remain open, otherwise increments failed reviews and returns to `in-progress`. Every severity blocks a pass. A tracked ledger is committed as a whole in its repository, including pre-existing ledger edits but excluding other staged files; an ignored, untracked or outside-repository ledger is written without a commit. If already identical to HEAD after writing, no commit is needed. The result states what happened.

Array and object arguments sent as JSON text follow the [Argument shapes](../../README.md#argument-shapes) rule.

All tools accept `path`. Role starts assign the agent ID by the rule in `skills/feature-ledger/references/agents/orchestrator-workflow.md` and issue a fresh token. Both starts include cumulative and latest diffs, separating implementation and ledger metadata; truncated patches have a full-patch artifact path. Validation failure retains a work claim and reports a log. Feature `review` defaults off; `max_failed_reviews` resolves item, ledger, then 5, with 0 unlimited. On reaching a positive cap, open findings remain and worker start is blocked until an authorized resolution or limit change; a submission for a claim already held is not affected.

## Safety and dependency

Claims fence stale sequential submissions; they are not locks or access-control secrets. A token is an opaque `claim-` identifier, deliberately not secret-shaped, not guaranteed collision-free and unique within one ledger only; a collision is not retried. Ledger writes are last-writer-wins: concurrent writers and concurrent work in a shared workspace are unsupported. Release a claim only after confirming its run stopped, using the current matching identity and token. Git commits and ledger writes are not atomic together; inspect state and report uncertainty rather than retrying blindly.

Bundled pi-subagents worker/reviewer tool access and reviewer write permission are an external dependency being addressed separately. This extension and skill do not configure overrides; agents must stop and report missing required tools.

## Verification

What the tests check is the authored contract, not behaviour: frontmatter and structure, every bundled path referenced from `SKILL.md`, the subagent templates and their return fields, the phrases the description must contain, and the route rules written in the references. They run through the commands under Human and CI commands.

The comparison of the same request with and without the skill has not been run, and nothing here claims it passed. No test can observe it: tool-call count, tokens consumed, failed calls, and user corrections exist only when the request is executed twice in two live Pi sessions with the skill loaded, once with the skill available and once without. Model routing is likewise only observable live — the trigger tests assert that the should-trigger and negative phrases appear in the description, which is not evidence that a model selects the skill for them.

This is reported as a blocker, not a defect: the comparison is out of scope for this work because it cannot be checked from the repository, only by running the live pair. Nothing here should be read as saying the skill was measured against a baseline.
