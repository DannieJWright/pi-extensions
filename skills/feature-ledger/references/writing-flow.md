# Writing flow

Read this when turning a plan into a ledger. `references/ledger.yaml` is a parseable example. Paths to bundled resources are relative to the skill root.

## Schema and authoring

- Write one implementable unit per item, in work order. Each has a unique slug `id`, a required one-sentence `short_goal`, a detailed `goal` (including its plan path when applicable), checkable `acceptance_criteria`, `constraints`, `files.in` and `tests`. Project paths are relative to the session root or absolute. `files.in` can name a file an earlier item will create.
- An item that changes documentation only may have no `tests`. A test cannot observe wording, so state plainly that the item is verified by reading. Do not write a test that pins an exact sentence — it fails on any rewording. Keep tests for the behaviour a documentation change describes, where behaviour exists.
- `workspace` resolves per item, then ledger default, then session root. Use one workspace repository per item. An optional item `branch` must match its repository on role start and submission; it does not locate the ledger.
- `validation_scripts` is a list of shell commands defined by the project being worked on, not by this skill's repository. Set the base list at ledger level; an item override replaces it. The submit tool runs them from the workspace. Temporary output should not create permanent project files.
- `review: true` opts an item into review; omitted or false means off. `max_failed_reviews` is a nonnegative integer: item override, then ledger root, then 5. Zero means unlimited. At a positive cap the item stays `in-progress` with findings intact; another worker start is blocked until an authorized resolution or limit change. A submission for a claim already held is not affected.
- `status` starts as `todo`; tools own all subsequent transitions. Leave `files.out`, `limitations`, `summary` and `commits` empty on a new item. Do not author claims or review history for new items.
- The tools maintain `failed_reviews` (zero-based failed-review count), `assignment` (`id`, `role`, `agent_id`, `claim_token`), and `findings`. Each finding has a stable `id`, `status` (`open` or `closed`), `details`, `rationale`, severity (`blocker`, `major`, `minor`, `nit`), `first_found_iteration`, and a list of `required_checks` instructions. All open severities block a pass. Closed and unmentioned open findings remain in history.
- The tools record the feature base in `commits.start`, the current claim's expected HEAD in `commits.expected`, the latest work commit in `commits.end`, and all work commits in `commits.submissions`. `files.out` is cumulative. Review metadata commits are distinct from work commits.
- Use YAML arrays for lists. Quote an entire string bullet beginning with `key: value`, otherwise it parses as a mapping. `references/ledger.yaml` demonstrates folded text and lists.

## Check before handing off

Call `ledger_check` with the draft path. It returns `{ path, ok, problems, warnings }`; fix problems including duplicate IDs, missing `short_goal`, invalid review settings or state, missing referenced plans and invalid workspaces before work starts. A `files.in` path that does not exist yet is a warning, not a problem. The authoring flow may read the file it wrote. If the tool is unavailable, stop and report it; do not invoke a script from the skill's repository.
