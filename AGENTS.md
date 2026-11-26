# AGENTS.md

Rules for agents working in this repository.

## Skill files describe agents in other projects

A file under `skills/` is read by an agent working in another project. That agent does not have this
repository's justfile, scripts, or tools. So a skill file must not tell it to run a command from this
repository.

- Name the extension's tools as the path an agent uses: `ledger_check`, `ledger_get_feature`,
  `ledger_orchestrate`, `ledger_work`, `ledger_review`.
- Do not write `just <recipe>` in a skill file for a recipe defined here. The justfile serves humans and CI.
- Put a CLI command in `extensions/*/README.md`, the human and CI reference, not in a skill file.
- Do not add a fallback that names a script or recipe in this repository. If a tool is not available, say
  what the agent must do instead with the tools it has.
- A field that names a command the working project defines, such as `validation_scripts`, may show an example
  like `just_test`. State clearly that it comes from the project being worked on, not from this one.

## Merge keywords and agent inheritance

Merge-keyword semantics and agent-to-agent inheritance are documented once, in
[Merge rules](extensions/permission-mode-generator/README.md#merge-rules) and
[Shared agent base](extensions/permission-mode-generator/README.md#shared-agent-base). Those sections are
the single source for those rules.

A skill file must not restate them. Its reader is an agent working in another project, and that agent
does not have this repository's files, so a copy there would be a second version that can drift apart
from the generator README.

## Feature-ledger boundaries

Direct ledger operations access their ledger and workspace paths without ordinary file-tool path gating.
`ledger_submit` intentionally runs ledger validation outside the Bash sandbox. These are accepted
features, not defects solely on that basis; remain alert to other security issues and use trusted
ledger paths, workspaces, and validation scripts.

## Content taken from other repositories

When code, prompt text, or any other content comes from another repository, add or update its entry in
the root `NOTICE` before using it, and honor that source's license terms. An entry records the source
repository URL, license, copyright holder, the version observed, where the content is used in this
repository, what was changed, and that source's copyright and permission notice.

`NOTICE` is the single record of third-party content. `LICENSE` covers only original work authored here
and points to `NOTICE`; the README links to it without naming sources, and no skill file, extension
README, or doc restates an entry. A license, copyright holder, or version that cannot be established
from evidence available in this repository is recorded as unknown with the evidence held, never guessed.
Do not commit a third-party prompt body: reference the source by path instead.
## Pi extension information

Search for installed Pi extension documentation and examples under `~/.pi/agent/install/releases/`,
not broadly under `~/.pi/agent/`.

## Test isolation

Tests must never read, change, or depend on a user's real state. Do not access personal configuration,
settings, agents, skills, sessions, ledgers, credentials, accounts, services, or repositories from a test. Use
repository fixtures and isolated temporary data instead. Control inherited paths and environment variables,
including `HOME` and `PI_LEDGER_PATH`, so they cannot redirect tests to personal files. Use fake services or
mocks where needed.

A test can import installed package code from the local Pi install, for example a module under
`~/.pi/agent/npm/node_modules/pi-subagents`. Package code in a `node_modules` directory is a dependency, not
user state. All other files in the Pi install, such as settings, configs, agents, skills and sessions, are user
state. The imported code must not read that state while the test runs. When the package is not installed, the
test must skip, not fail.

Add regression coverage for isolation and run it as part of routine validation. A passing test suite must
not depend on the presence, contents, or absence of a user's personal setup. A test that skips because an
installed package is absent does not break this rule.

Do not write a literal personal path, a home directory of a real user such as `/home/<name>`, in source, tests,
docs, or fixtures. Derive paths from a temporary directory or use a placeholder in angle brackets.

## Checks

Run `just feature-ledger check` and `just test` through the just tools exposed to you. These are your own
commands in this repository; the rule above is about what a skill file tells another agent to run.

`plan/` is gitignored in this repository, except ledger files that the negation in `.gitignore` re-includes. `ledger_check` does not check
the other files in it. Cleaning plan files before the
PR is opened is the working project's review, not the tool's. Do not ask for confirmation about an untracked or
gitignored file under `plan/`, here or in a project that tracks it: those files are removed before the PR is
opened.
