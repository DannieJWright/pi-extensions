# Provider prompt rules

Adds a provider-conditional block to the system prompt. When a provider that serves one agent at a
time is active, the model is told to run subagents one at a time and to do no work while one runs.
Pi has no per-provider system prompt field, so this extension owns its own config file.

## Use

```sh
just provider-rules                 # check: validate the config and print the effective rules
just provider-rules check --model strata/qwen3.8-flash-next-iq2_xs
just provider-rules test            # run the parse and resolve tests
```

In a session, `/provider-rules` re-reads the config and reports the model, the winning rule, and any
problems. The rule is resolved on every run, so a `/model` switch takes effect on the next run.

## Config

The global config is `~/.pi/agent/provider-prompt-rules.jsonc`.

Each entry sets the rule value and the wording for that level. Wording is per provider, so two
providers can say the same rule in different words.

```jsonc
{
  "providers": {
    "strata": {
      "sequentialSubagents": true,
      "text": {
        "sequentialSubagents": [
          "This provider serves one agent at a time.",
          "- Run one subagent at a time. Do not dispatch another while one is running.",
          "- Wait for each subagent to finish before starting the next. Use acp_delegate_wait to block for its result.",
          "- While a subagent is running, do not do other work and do not call tools."
        ]
      }
    }
  },
  // Keyed provider/modelId, like modelThinkingLevels. Deepest defined level wins.
  "modelOverrides": {
    "local-llama/qwen-3.6-27B-tc-262k": { "sequentialSubagents": false }
  },
  // Default wording for a rule when an entry does not set its own text.
  "text": {}
}
```

Precedence, per field: value — model entry > provider entry; wording — model entry text > provider
entry text > top-level `text` default > built-in text. A model entry may carry wording only, with the
value coming from its provider.

Text is a string or an array of lines joined with a newline. Unknown keys, unknown rule names,
non-boolean values, empty text, and model keys without a `/` are dropped and reported. They never
clobber a good value. A missing config file is not an error.

## Rules

| Rule | Section tag | What it says |
| --- | --- | --- |
| `sequentialSubagents` | `subagent_execution` | Run one subagent at a time, wait for each to finish before starting the next, and do no work or tool calls while one runs. |

The built-in wording is the last fallback. Entry text or the top-level default replaces it. Keep the wording
byte-stable: a change mid-session is a prompt-cache bust, and these providers default to
`supportsMidConvoSystemMessages: false`, so the section is folded into the leading system message.

## Scope

The section is added for the main agent. A delegate gets its own role prompt, so role prompts are not
changed here. A delegate runs in its own Pi process, and that process loads this extension too, so the
section also appears in a sub-agent's prompt. That is harmless: a sub-agent does one job at a time.

Prompt text is an instruction, not a gate. For hard enforcement, set
`pi.subagents.maxConcurrent: 1` in `~/.config/billion-context/billion-context.json`. That knob is
process-global, so it applies to every provider in the session, not only the listed one.

## Files

- `config.ts` — parse, resolve, render, report. No Pi imports.
- `index.ts` — the extension: `session_start` load, `before_agent_start` apply, `/provider-rules`.
- `check.ts` — command-line report for the just recipe.
- `provider-prompt-rules.test.ts` — tests.

The JSONC reader is shared with `../permission-mode-generator/jsonc.ts`.
