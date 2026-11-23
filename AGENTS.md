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

## Checks

Run `just feature-ledger check` and `just test` through the just tools exposed to you. These are your own
commands in this repository; the rule above is about what a skill file tells another agent to run.

`plan/` is gitignored in this repository and `ledger_check` does not check it. Cleaning plan files before the
PR is opened is the working project's review, not the tool's. Do not ask for confirmation about an untracked or
gitignored file under `plan/`, here or in a project that tracks it: those files are removed before the PR is
opened.
