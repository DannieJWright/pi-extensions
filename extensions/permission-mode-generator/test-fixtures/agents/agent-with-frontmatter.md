---
name: illustrative-agent
description: Illustrative stand-in for an agent file from another project. Owned by this repository.
tools: [read, grep]
---

# Illustrative agent fixture with frontmatter

This is a test fixture owned by this repository. It stands in for an external agent file so the prompt-reference tests read a real file with a leading block delimited by --- lines instead of an installed package, and the example source references it as a prompt value, including from a mode prompt. The generator does not interpret those fields; the flag only decides whether the block is kept.

The wording here is original to this repository. Do not paste prompt text from another project into a fixture.
