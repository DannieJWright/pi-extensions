# AGENTS.md

Rules for agents working in this repository.

## Skill files describe agents in other projects

A file under `skills/` is read by an agent working in another project. That agent does not have this
repository's justfile, scripts, or tools. So a skill file must not tell it to run a command from this
repository.

- Name the extension's tools as the path an agent uses: `ledger_check`, `ledger_list`, `ledger_next`,
  `ledger_start`, `ledger_submit`.
- Do not write `just <recipe>` in a skill file for a recipe defined here. The justfile serves humans and CI.
- Put a CLI command in `extensions/*/README.md`, the human and CI reference, not in a skill file.
- Do not add a fallback that names a script or recipe in this repository. If a tool is not available, say
  what the agent must do instead with the tools it has.
- A field that names a command the working project defines, such as `validation_scripts`, may show an example
  like `just_test`. State clearly that it comes from the project being worked on, not from this one.

## Checks

Run `just feature-ledger check` and `just test` through the just tools exposed to you. These are your own
commands in this repository; the rule above is about what a skill file tells another agent to run.

`plan/` is gitignored in this repository, so `git ls-files plan/` is always empty here and the tracked-plan
problem in `ledger_check` cannot fire. That check applies to projects that track `plan/`, which is what the
skill states for agents working in another project.
