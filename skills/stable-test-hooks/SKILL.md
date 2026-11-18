---
name: stable-test-hooks
description: >-
  Keep test selectors stable. Use when writing or changing tests that reach a
  region of the UI, or when a component gains a new control. Prefers data test
  ids for test scoping and avoids assertions that depend on a computed
  accessible name.
---

# Stable Test Hooks

Follow these rules when writing or changing tests that reach a region of the UI.

## Rules

1. **Prefer `data-testid` for test scoping.** When a test must reach a region, the component exposes a stable id: `data-testid="search-results"`, `data-testid="block-actions"`.
2. **Use a role or label when the test reads the element as a user does.** A test that clicks a button by name is still valid. Test ids are for regions and for elements whose name is not stable.
3. **Naming:** `data-testid=<component>-<region-or-control>`, kebab-case. Once a test depends on an id, the id is an interface: changing it is a test change, not a copy change.
4. **Do not assert on a joined accessible name.** A name built from several parts joins with single spaces. Assert each part by its own text.
5. **New control, audit the selectors.** When a component gains a control, every test that selects "the button" must name it. Search for role selectors with no name in the affected test file.
6. **Guard the hook.** One cheap test per page object asserts the test id exists.
7. **Page objects resolve through test ids.** One thin selector layer per page; tests do not hard-code selectors.

## Framework mapping

| Layer | Region hook | Control access |
|---|---|---|
| React / testing-library | `data-testid` | `getByRole(name)` |
| Playwright | `locator("[data-testid=...]")` | `getByRole(name)` |
| Vue / Svelte | `data-testid` | role + name |

The rules are the same in each; only the call differs.

## Capture specs

The before-after-capture skill uses these hooks. A capture spec selects through test ids, so a spec does not break when the markup changes. When a capture step needs a region, the page object exposes it here first.

## Cleanup before merge

The audit is work, not a deliverable:

- remove scratch files and throwaway audits created while checking selectors;
- keep the guard tests — one per page object is part of the suite;
- before the PR is opened, `git ls-files` must show only the page objects, their guard tests, and the intended test changes — no leftover scratch test files.
