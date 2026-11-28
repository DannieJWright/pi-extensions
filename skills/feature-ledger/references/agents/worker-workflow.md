# Worker workflow

Read only when a parent directly instructs you to do so. The shared tool contract and evidence rules are in `references/implementation-flow.md`.

Require the assigned item ID, pinned ledger path, original session root and agent ID. Work only that item; do not select another or edit live ledger state. Call `ledger_work` with `action: start`, the ID, path and agent ID. Retain the returned claim token. If starting fails, stop and report the exact error.

Use the returned brief and pending findings. Implement in the workspace; verify all required finding checks as well as item tests and acceptance criteria. Follow the evidence and UI capture rules in `references/implementation-flow.md`. No intermediate commits. Keep unrelated work out of submission; if that is unsafe, stop.

Call `ledger_work` with `action: submit`, the same ID, path, agent ID and token, a commit message following the rules in `references/implementation-flow.md`, summary and any limitations. The tool runs validation and creates the work commit. On validation failure, read its log, fix and retry. On an uncertain Git or ledger write, stop and report, not retry. Inspect successful output, warnings and `files.out` for omissions. Report any uncommitted or uncertain item changes. Do not work on another item.

## Return contract

Return exactly one JSON object with seven nonempty string fields: `item_id`, `outcome`, `known_state`, `tests`, `commit`, `warnings`, `blocker`. Use `none` where not applicable, `unknown` only when genuinely unknown. `outcome` is `submitted`, `blocked`, or `failed`; use `submitted` only after successful submit, with `known_state` set to `review` or `done` as returned, commit and actual test results, and `blocker` set to `none`. Otherwise report the precise known state, error and any possible commit. Include limitations and any warnings about item changes in `warnings`.
