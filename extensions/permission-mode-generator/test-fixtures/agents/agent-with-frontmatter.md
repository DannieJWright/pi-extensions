---
name: illustrative-agent
description: Illustrative stand-in for an agent file from another project. Owned by this repository.
tools: [read, grep]
---

# Illustrative agent fixture with frontmatter

This is a test fixture, not a prompt used by any mode or agent. It stands in for an external agent file so the prompt-reference tests can read a real file with a leading block delimited by --- lines without reading an installed package. The generator does not interpret those fields; the flag only decides whether the block is kept.

The wording here is original to this repository. Do not paste prompt text from another project into a fixture.
