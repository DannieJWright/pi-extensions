# UI Tests

## Purpose

UI tests are browser-based end-to-end tests of real user flows against explicitly configured local or canary resources. They validate critical journeys across rendered UI, client behavior, backend integration, and user-visible state.

Use the page object model (POM): page objects represent a screen or coherent UI area and expose behavior-focused actions and state queries. Test files orchestrate pages and make journey-level assertions; they should not embed repeated selectors or low-level browser mechanics.

## Preconditions

Discover the repository's browser runner, browser lifecycle, base URL, authentication approach, data policy, approved local/canary environment, and cleanup mechanism. Never invent URLs, accounts, selectors, credentials, or test data. Ask a focused question if required configuration is missing.

## Expectations

- Cover a small set of valuable, successful user journeys. Test most field validation, error handling, and edge cases in unit or integration tests.
- Encapsulate selectors and reusable interactions in page objects. Keep assertions in tests unless a page state query improves readability. See Selectors and Test Hooks.
- Create unique test data and clean it up after every run, including after failures.
- Wait for meaningful UI state rather than arbitrary sleeps.
- Keep page objects task-oriented: `signIn`, `submitOrder`, `expectConfirmation`, not generic selector wrappers.

## Selectors and Test Hooks

- **Regions:** reach a region, or an element whose accessible name is not stable, through a `data-testid` the application provides, such as `search-results` or `block-actions`. Request or add narrowly scoped ids when needed.
- **Controls:** when a test reads an element as a user does, use role plus name. Clicking a button by name is valid.
- **Naming:** `data-testid=<component>-<region-or-control>`, kebab-case. Once a test depends on an id, the id is an interface: changing it is a test change, not a copy change.
- **No joined names:** do not assert on a joined accessible name. A name built from several parts joins with single spaces. Assert each part by its own text.
- **New control:** when a component gains a control, audit the tests that select it. Every role selector with no name in the affected test file must now name its control.
- **Guard:** add one cheap test per page object that asserts its test ids exist.

## Location

Preserve the repository convention. If none exists, use `tests/ui/<feature>/<flow>.test.<ext>` and place page objects in the closest established support location, or `tests/ui/pages/` for a new repository.

## Language Routing

Load exactly one language resource after selecting this layer:

| Language | Resource |
|---|---|
| Python | `resources/ui/languages/python.md` |
| TypeScript or JavaScript | `resources/ui/languages/typescript.md` |
