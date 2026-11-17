# Provider rules

Two provider-scoped things:

1. A provider-conditional block in the system prompt. When a provider that serves one agent at a time
   is active, the model is told to run subagents one at a time and to do no work while one runs.
   Pi has no per-provider system prompt field, so this extension owns its own config file.
2. Recovery for truncated responses. A local model that spends its whole budget on thinking and stops
   with `stopReason: "length"` gets its thinking turn dropped, a prompt injected, and the run continued
   at a lower thinking level.

Pi has no per-provider system prompt field, so both read from this extension's own config file.

## Use

```sh
just provider-rules                 # check: validate the config and print the effective rules
just provider-rules check --model strata/qwen3.8-flash-next-iq2_xs
just provider-rules test            # run the parse, resolve, and recovery tests
```

In a session, `/provider-rules` re-reads the config and reports the model, the winning rule, and any
problems. The rule is resolved on every run, so a `/model` switch takes effect on the next run.

## Config

The global config is `~/.pi/agent/provider-rules.jsonc`. The old name
`provider-prompt-rules.jsonc` is still read when the new one does not exist, and the report says to
rename it. Example: `configs/provider-rules.example.jsonc`.

Each entry sets the rule value, the wording for that level, and the recovery settings for that level.
Wording and recovery settings are per provider, so two providers can differ.

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
  // Providers whose models are self-hosted. Recovery only runs for these.
  "localProviders": ["strata"],
  // Default recovery settings. A provider entry overrides them; a model entry overrides that.
  "recovery": {
    "prompt": "Work through the task one at a time.",
    "maxAttempts": 3,
    "thinkingLevel": "low",
    "display": true
  },
  // Keyed provider/modelId, like modelThinkingLevels. Deepest defined level wins.
  "modelOverrides": {
    "local-llama/qwen-3.6-27B-tc-262k": { "sequentialSubagents": false },
    "strata/qwen3.8-flash-next-iq2_xs": { "recovery": { "thinkingLevel": "low" } }
  },
  // Default wording for a rule when an entry does not set its own text.
  "text": {}
}
```

Precedence, per field: value — model entry > provider entry; wording — model entry text > provider
entry text > top-level `text` default > built-in text; recovery settings — model entry > provider
entry > top-level `recovery` default > built-in. A model entry may carry wording only, with the value
coming from its provider.

Text is a string or an array of lines joined with a newline. `prompt` is the same. `maxAttempts` is a
positive integer. `thinkingLevel` is `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `null` to
leave the level unchanged — `off` is not accepted, because the extension API has no `off` thinking
level. `display` is a boolean. `localProviders` is an array of provider ids as Pi reports them
(`strata`, not a URL). Unknown keys, unknown rule names, bad values, empty text, and model keys
without a `/` are dropped and reported. They never clobber a good value. A missing config file is not
an error.

## Rules

| Rule | Section tag | What it says |
| --- | --- | --- |
| `sequentialSubagents` | `subagent_execution` | Run one subagent at a time, wait for each to finish before starting the next, and do no work or tool calls while one runs. |

The built-in wording is the last fallback. Entry text or the top-level default replaces it. Keep the wording
byte-stable: a change mid-session is a prompt-cache bust, and these providers default to
`supportsMidConvoSystemMessages: false`, so the section is folded into the leading system message.

## Recovery

A turn is recovered when all of these hold:

- the response ended with `stopReason: "length"` and the turn completed (not aborted or errored);
- the provider is in `localProviders`;
- the response has no visible text and no tool results — a length stop that already produced text or
  ran a tool is a normal turn, not a runaway thinking block;
- the consecutive attempt count is below `maxAttempts`.

What happens at `turn_end` for that turn:

- the thinking message is dropped from model context with a `context_edit` (`replacement: null`), so
  the transcript keeps it but the next request does not carry it;
- the prompt is injected as a `custom_message` (`display: true` by default), which also makes the
  continuation valid — Pi only continues when the last message is not an assistant message;
- the thinking level is set to `thinkingLevel` for the recovery request;
- the run continues, so no user message is needed.

The level is put back at the `turn_end` of the recovery turn, whatever its outcome, so a second
truncation restores the original level before lowering it again. If the run ends before a turn
completes, `agent_settled` restores it as a safety net.

Attempts count consecutive truncated turns; a normal turn clears the count. At the limit the extension
stops recovering and reports once, then stays quiet until a normal turn clears the count.

## Scope

The section is added for the main agent. A delegate gets its own role prompt, so role prompts are not
changed here. A delegate runs in its own Pi process, and that process loads this extension too, so the
section also appears in a sub-agent's prompt. That is harmless: a sub-agent does one job at a time.

Prompt text is an instruction, not a gate. For hard enforcement, set
`pi.subagents.maxConcurrent: 1` in `~/.config/billion-context/billion-context.json`. That knob is
process-global, so it applies to every provider in the session, not only the listed one.

## Files

- `config.ts` — parse, resolve, render, report. No Pi imports.
- `recovery.ts` — the decision logic (trigger, gate, counter, level bookkeeping). Pure: takes facts and
  state, returns a decision and the next state. No Pi imports.
- `index.ts` — the extension: `session_start` load, `before_agent_start` apply, `turn_end` recovery,
  `agent_settled` safety net, `/provider-rules`.
- `check.ts` — command-line report for the just recipe.
- `provider-rules.test.ts` — parse and resolve tests. `recovery.test.ts` — gate, trigger, counter,
  level bookkeeping, report tests.

The JSONC reader is shared in `../../lib/jsonc.ts`.
