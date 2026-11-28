---
name: before-after-capture
description: >-
  Capture and verify a before/after image pair for a visible UI change. Use when
  a task asks for screenshots or visual evidence of a change. Pin the conditions,
  drive the changed state, and check the returned images.
---

# Before/after capture

Use this skill for a visible UI change. For a change with no visible surface, use tests and command output instead. Use one spec for each pair.

## Prepare

Choose a feature ID and integer subphase. Use a new subphase for each review iteration so that earlier pairs remain available. Save the YAML spec beside the pair in a tracked, non-ignored artifact directory. The default is `artifacts/<feature>/<subphase>/` at the Git root. A project can select another path. Check that the path is not ignored before capture. If it is ignored, choose a tracked path or ask the user.

The spec has `feature`, `subphase`, `description`, `server`, `conditions`, and `steps`. The description says what the reader must see. Give `server` a `url` for a running server. Automatic host startup via `start` is unavailable because cleanup cannot be guaranteed; start the server separately using the project's workflow if needed. URL mode never stops the server. Never delete another server's lock. Do not run a build or end-to-end tests for the same package while its capture server runs.

Pin the viewport, clock, locale, theme, and deterministic fixture data. Do not use real time, random data, or network calls for fixture data. Use the same spec and conditions for both phases. Select the same important elements in both views. The steps must produce the state that changes, such as hover, focus, or a key press. Do not assume the state. Wait for the target region to render before the screenshot. Select stable test IDs or roles and names.

Pin `conditions.theme` to `light` or `dark`. For a project-named theme, set `theme_storage.key` to the key the app reads instead. A launch blocked by the OS sandbox retries once without Chromium's sandbox, and nothing records which mode ran, so take no extra step.

Example for a running server (replace the values with the project's values):

```yaml
feature: search-result-labels
subphase: 1
description: The selected result has a visible background.
server:
  url: http://127.0.0.1:3000
  ready: {path: /app, selector: '[data-testid=search-results]'}
conditions:
  entry: /app
  viewport: 1400x1000
  clock: 2026-11-14T10:00:00.000Z
  locale: en
  theme: dark
  fixture: pinned search results
steps:
  - wait_for: '[data-testid=search-results]'
  - focus: '[data-testid=search-field]'
  - press: ArrowDown
  - screenshot: {name: full}
```

## Capture and check

1. Write the spec before implementation. Call `capture_run` with the spec and `phase: before` against the pre-change build. Set `build` when a label is needed.
2. Implement the change. Call `capture_run` with the same spec and `phase: after` against the post-change build. Set `build` when a label is needed.
3. Look at both returned images and the diff. Confirm that the description is visible, the conditions match, the same elements are in view, and only the feature differs. A DOM attribute alone is not evidence of a visible change. If the region is not visible or the pair does not match, correct the spec or fixture and capture both phases again.
4. Call `capture_check` with the spec and answers: `visible`, `conditions_match`, `only_difference_is_the_feature`, `same_target`, `preserved`, `measurements`, and `note`. Reference recorded measurement keys rather than retyping values. The check must pass for the current pair. State the conclusion and sidecar path in the item summary.
5. Use `capture_server` to inspect server health. Do not stop a user's server. Legacy owned-server cleanup may be incomplete and requires manual inspection; follow the reported error. If a capture tool reports a server or lock conflict, stop and resolve it without deleting the lock. If a required tool is unavailable, stop and report it.

The tool saves the spec, images, and sidecar together. Commit the tracked artifacts on the feature branch for review. Before merge, remove the artifacts and squash their commits out of the main history. Verify that no artifact files remain tracked. Keep the artifact paths in the ledger for the reviewer.

## Project note

Record the project artifact path, server block, and deterministic fixture clock here for the work. Use project values, not the example values above.
