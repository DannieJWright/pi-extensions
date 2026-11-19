---
name: before-after-capture
description: >-
  Capture a before/after pair that shows a feature change. Use when a task asks
  for screenshots of a change, or when a change must be shown to a reviewer.
  Drives the app state, pins the conditions, and verifies the picture actually
  shows the difference.
---

# Before/After Capture

Use this skill only for UI changes. A change with no visible surface has no pair: verify it with tests and command output instead. If the change cannot be seen in a frame, it is not a capture task.

Capture a pair of images that proves a feature change. One key — the feature id — links the spec, the artifact folder, and the commit message.

The rules below are generic. Project values (artifact path, start command, fixture clock) live in the Project note at the end, not in the rules.

## 1. Naming and paths

The feature id is a string (`search-result-labels`). The subphase is an integer; `1` is the first pass, later iterations add `2`, `3`, so a pair is never overwritten and a review round can be compared with the previous one.

```
<artifacts>/<feature>/<subphase>/before.png
<artifacts>/<feature>/<subphase>/after.png
<artifacts>/<feature>/<subphase>/capture.yaml      # the spec used
<artifacts>/<feature>/<subphase>/sidecar.json       # conditions + resolved state, written by the runner
```

Default `<artifacts>` is `artifacts/` at the repo root, tracked. A project may override it; the override is stated in the Project note. Before the first capture, check that the path is not ignored:

```sh
git check-ignore -v artifacts/ || echo "not ignored"
```

If it is ignored, ask the user or pick a tracked path. Do not write to an ignored path and assume the images can be committed.

## 2. Capture spec

The spec is a YAML file saved with the pair. Required fields: `feature`, `subphase`, `phase`, `description`. The description says what the reader should see — it is what the pair check runs against.

```yaml
feature: search-result-labels
subphase: 1
phase: after
description: >
  What the reader should see. Required. Example: result rows show the source label and a
  relative time, and the row the reader is on is marked.
conditions:
  base_url: http://127.0.0.1:<port>
  entry: /agent
  viewport: 1400x1000
  clock: 2026-11-14T10:00:00.000Z      # pinned; relative times are only reproducible with this
  locale: en
  theme: dark
  fixture: <fixture or seed name>
  permissions: [clipboard-write]
steps:
  - scroll_to: '[data-testid=transcript]'
  - wait_for: '[data-testid=search-results]'
  - fill: '[data-testid=search-field]'
    value: atomically
  - press: ArrowDown
  - assert: '[data-testid=search-results] li[data-current]'
  - screenshot: artifacts/search-result-labels/1/after.png
```

Step vocabulary: `goto`, `fill`, `press`, `hover`, `click`, `scroll_to`, `wait_for`, `assert`, `screenshot`. The runner exits nonzero if an `assert` fails or a target is not rendered.

Select through test ids for regions and role + name for controls. A spec that hard-codes markup selectors breaks when the markup changes.

## 3. Conditions (must match between before and after)

The before and after runs share one `conditions` block. Only the feature change differs. The pair is valid only when:

- same viewport, clock, locale, theme, and fixture data;
- the same important elements are in view in both frames;
- the state that the feature changes is produced by the runner (hover, focus, key press), not assumed;
- the region is asserted to have rendered before the shot — never measure or photograph a region that has not rendered.

If the change is not visible in the frame, the capture is invalid. Re-shoot with the region in view.

## 4. Running the capture

- Start one server per feature, not per shot (use the start command in the Project note). Rebuild after each code change. Stop it at the end.
- Run the same spec for `before` (against the pre-change build) and `after` (against the post-change build). Record which build each shot came from in the sidecar (`--build <label>`, or the runner records the current commit).
- Use the project's own fixture and clock (see the Project note). Do not use real time, random data, or network calls.

Run the runner from the repo root:

```sh
node skills/before-after-capture/scripts/capture.mjs artifacts/<feature>/<subphase>/capture.yaml
```

The runner needs Playwright in the project (`npm install playwright`). It writes the png and the sidecar, and exits nonzero on a failed assert or a target that is not rendered.

## 5. Pair check (verification)

After both frames exist, read both images back and answer three questions. This is the pair check:

1. Is the `description` visible in the after image?
2. Does the before image show the same conditions and the same elements in view?
3. Is the only difference the feature change?

A DOM attribute is not evidence. If a state is only marked in the DOM and has no visible effect, the after image does not show the change, and the capture is not done.

Write the answers to the sidecar as a `pair_check` object:

```json
{
  "feature": "search-result-labels",
  "phase": "after",
  "subphase": 1,
  "conditions": { "viewport": "1400x1000", "clock": "2026-11-14T10:00:00.000Z" },
  "pair_check": {
    "visible": true,
    "conditions_match": true,
    "only_difference_is_the_feature": true,
    "note": "the marked row is visible as a background; the before frame shows the same rows"
  }
}
```

The ledger item does not carry these answers. Its `summary` states the conclusion in one line and points to the sidecar.

## 6. Cleanup before merge

Artifacts are committed on the feature branch so a reviewer can see them. They must not reach the main history:

- before merge, remove the artifact files and squash their commits out;
- this must print nothing before the PR is opened:

  ```sh
  git ls-files artifacts/
  ```

- The ledger keeps the artifact paths so the reviewer can still find them after the squash.

## Project note

Fill this in for the current project; the rules above stay unchanged.

- Artifacts path: `artifacts/` at the repo root, tracked (the repo `.gitignore` does not ignore it, so feature-branch images can be committed). Scratch output goes to `build/`, which the repo `.gitignore` ignores.
- Start command: the project's own dev server command, one server per feature.
- Fixture clock: `2026-11-14T10:00:00.000Z`, locale `en`, theme `dark` — the values the fixtures pin.
