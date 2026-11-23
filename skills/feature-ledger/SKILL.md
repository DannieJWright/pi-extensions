---
name: feature-ledger
description: "Track, implement, and optionally review features in a ledger. Use when asked to inspect a feature ledger, turn a plan into a ledger, work a ledger item, or orchestrate ledger work. Do not use for ordinary task lists or code review unrelated to a feature ledger. Orchestration requires a direct user request."
---

# Feature Ledger

Use the ledger tools for shared, resumable feature state. Reading state does not claim work. **Never orchestrate just because the skill is loaded or the user asks to inspect or work an item**: orchestration is direct-request-only.

## Resources (paths relative to this skill root)

| Path | Read when |
|---|---|
| `references/writing-flow.md` | Turning a plan into a ledger; field and schema rules. |
| `references/ledger.yaml` | Authoring a ledger example. |
| `references/implementation-flow.md` | Working an item directly or as a worker; tool and evidence rules. |
| `references/agents/orchestrator-workflow.md` | The user directly requests orchestration. |
| `references/agents/implementor-workflow.md` | The orchestrator directly assigns worker work and instructs the agent to read it. |
| `references/agents/reviewer-workflow.md` | The orchestrator directly assigns review and instructs the agent to read it. |
| `subagents/worker.md` | The orchestrator dispatches a worker. |
| `subagents/reviewer.md` | The orchestrator dispatches a reviewer. |

## Choose a route

- Inspect: use `ledger_get_feature` for an ID, or `ledger_orchestrate` with `action: list` or `next`; report results without claiming work.
- Author: read `references/writing-flow.md`, then use `ledger_check`.
- Direct work: read `references/implementation-flow.md`; no delegation is required.
- Orchestrate: only on a direct user request, read `references/agents/orchestrator-workflow.md` and delegate sequentially. The parent neither implements nor reviews nor runs validation.

Every tool accepts optional `path`: explicit argument, then `PI_LEDGER_PATH`, then the first line of `plan/ledger.path` in the session root, then `plan/ledger.yaml`. Relative paths resolve against the original session root; any extension is accepted. An orchestrator pins the user-selected path for all calls.

Every tool validates the resolved file through one shared gate before doing any work, so a read refuses a ledger `ledger_check` would reject, duplicate IDs included; the problem lines match for the same file. `ledger_check` is the only tool that reports filesystem and Git findings, and read paths never write. Release runs the same gate, so an interrupted run's file must be valid before its claim can be released.

Statuses are tool-owned: `todo` → `in-progress` → `done` without review, or → `review` with review enabled. A review with any open finding returns to `in-progress`; only a review with no open findings reaches `done`. Do not edit live ledger state by hand. Use the read tools, not a direct read of the entire ledger, except when authoring it.

## Safety and unavailable tools

Claims fence stale sequential submissions; they are not access-control secrets or locks. Ledger writes are last-writer-wins: parallel writers and parallel work in a shared workspace are unsupported. For a stopped run, a parent may release only after establishing that run has stopped, using its current identity and token; otherwise stop and report. Never retry blindly after an uncertain commit or ledger write.

If a required ledger or delegation tool is unavailable, stop and report which tool and role are missing; do not substitute a repository-specific script. Bundled pi-subagents worker/reviewer tool access and reviewer write permission are an external dependency being addressed on a separate branch; this skill does not configure overrides.
