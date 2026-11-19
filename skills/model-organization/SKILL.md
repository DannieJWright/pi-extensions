---
name: model-organization
description: >
  Keeps each domain model's shape, vocabulary, statuses, parsing, formatting and persistence mapping in
  one owner module, so engines (parsers, serializers, repositories, routes) read model definitions and
  never re-declare them. Use when you plan or spec a new or changed domain model or document type, when
  you review a diff that touches model definitions or the engines that consume them, or when you
  consolidate scattered model knowledge. Triggers: "where should this model live", "add a new entity
  type", "scattered enums or labels", "duplicated status lists", "review model changes", "per-model
  modules". Do NOT use for general code review, test design (use the testing skill), or writing new
  skills (use creating-skills).
---

# Model Organization

## Overview

Each domain model owns exactly one authoritative module containing everything the system knows about that type — its shape, vocabulary, statuses, parsing, formatting, and persistence mapping. Feature engines orchestrate workflows and read model definitions; they never re-declare them. This skill keeps all specifics in resources next to it so only what the current task needs enters context.

Pattern: domain-specific intelligence, with context-aware routing. The delegation rules below pick the one resource that fits the current phase.

**Announce at start:** "I'm using the model-organization skill."

## When to Use

- A plan, spec, or pseudocode introduces or changes domain models or document/format types.
- A diff touches model definitions (schemas, descriptors, enums/statuses) or engines that consume them (parsers, formatters/serializers, repositories, routes).
- Model knowledge is scattered across feature files and needs consolidating.

Do NOT use for general code review with no model changes, test design, skill authoring, or schema design that raises no ownership question.

## Resources (under `resources/`)

| Path | Contains |
|---|---|
| `resources/explanation.md` | The ownership expectations: what belongs in a model file, what engines may contain, shared-helper and aggregation patterns, parent-child delegation, the add-type cost test. |
| `resources/review-guide.md` | Checklists validating that the expectations are met and detecting unnecessary hardcoding; finding format; refactor sequence for dedicated tech-debt sessions. |
| `resources/examples.md` | Before/after case studies: a plan-format monolith refactor (illustrative, from a real project) and a generic scattered-entity consolidation. **Never load this directly** — only via `resources/review-guide.md`. |

## Delegation rules

Match the current task to exactly one context below. Load only the listed resource(s); never preload, and do not load more than one resource per phase unless a single turn explicitly spans planning and reviewing.

1. **Creating a plan / spec / pseudocode** that introduces or changes domain models or document/format types:
   Read `resources/explanation.md` before proposing file layout, module boundaries, or where new type behavior will live. Do not load the review guide or examples in this phase.

2. **Code reviewing work**, when the diff touches model definitions (schemas, descriptors, enums/statuses) or engines that consume them (parsers, formatters/serializers, repositories, routes):
   Read `resources/review-guide.md` and run its checklists against the changed code, following wherever it directs you to consult further resources. If the diff touches none of these files, load nothing.

3. **Dedicated refactor** of scattered-model tech debt (model knowledge spread across multiple feature files):
   Read `resources/review-guide.md` in its refactor mode and follow that sequence, including wherever it directs you to consult further resources.

## Output

- Review and refactor findings use the finding format in `resources/review-guide.md`: `file:line — A#/B# — what is spelled here and where its owner lives — remediation direction`.
- Plans and specs state the result of the add-type cost test from `resources/explanation.md`.

## Common Issues

### No single clear owner for a type
Cause: the type's knowledge is spread over several files, or no module declares it.
Solution: report finding A1 (see `resources/review-guide.md`), name the module that should own it, and do not guess a layout from memory.

### The diff touches no model or engine files
Cause: the change is outside this skill's scope.
Solution: load no resource and say so.

### A grep match is ambiguous (fixture, comment, engine-owned string)
Cause: the needle list matches text that may not be functional use.
Solution: report it as "verify" using the exception list in `resources/review-guide.md`; do not pass or fail it silently.

### Adding one plain type touches more than three files
Cause: the layout lacks a per-type owner or a registry.
Solution: stop and redesign the layout first, using `resources/explanation.md`.

## Guardrails

- This file deliberately contains no organization rules. If you are about to state an ownership rule from memory, stop and read the resource that owns it.
- `resources/examples.md` is reachable only through `resources/review-guide.md`; a planning-phase task never reads it.
- "Just in case" loading defeats this skill's purpose — resources stay out of context until their trigger fires.
